// The group check: what the precision setting turns up or down (notes/accuracy-2026-10-31.md, "Precision").
// After the passes, each new group of `splitFrom` or more tabs goes back to the model on its own: only its tabs, not
// its name, sorted by subject with the tidy's own rules (prompt.js, CHECK_PROMPT). A group that turns out to hold
// several subjects is replaced by one group per subject of 2 or more tabs; a tab the check leaves out of every subject
// goes loose when the group has `ejectFrom` or more tabs, and otherwise stays, in the largest part.
// On 257 real tabs, Sonnet 5.5's groups without a check held 69% right pairs (pair precision against an Opus 5.5
// reference; 80% on another 236), three quarters of the wrong pairs in a few large groups that merged two or three
// neighbouring subjects. Checked with Haiku 5.5, the levels came to (precision on the two sets, share of tabs grouped):
//   1  no check                              69% / 80%   84%
//   2  split groups of 10+                   82% / 88%   84%
//   3  split groups of 5+                    84% / 89%   84%
//   4  ... and leave odd tabs out of 10+     91% / 92%   79%
//   5  ... and out of every group checked    96% / 95%   73%
// Every level above 1 also splits some subjects in two (pair recall 85% falls to 61% at level 5). Tried and dropped:
// several groups in one call (the model split far fewer: 78%), Sonnet 5.5 or thinking for the check (no more precise,
// slower or 20x the cost), two checks per group voting (2 points more coverage for twice the requests).
// Groups that join one of the person's own groups aren't checked: their other tabs aren't part of the tidy.
// A check that fails, is refused or runs out of time leaves its group as it was, since it only refines a plan that is
// already good to show.

import { validatePlan, nameKey } from "./plan.js";

export const PRECISION_LEVELS = Object.freeze([1, 2, 3, 4, 5]);
export const DEFAULT_PRECISION = 5;
const RULES = Object.freeze({
  2: Object.freeze({ splitFrom: 10, ejectFrom: Infinity }),
  3: Object.freeze({ splitFrom: 5, ejectFrom: Infinity }),
  4: Object.freeze({ splitFrom: 5, ejectFrom: 10 }),
  5: Object.freeze({ splitFrom: 5, ejectFrom: 5 }),
});
// The check model, whatever model the tidy uses: Haiku 5.5 checked as precisely as Sonnet 5.5 at a twentieth of the
// cost, in about 3 s for a 250-tab tidy (17 checks).
export const CHECK_MODEL = "claude-haiku-5-5";
// Checks in flight at once. A rate-limited key retries inside each check's time box (anthropic.js).
export const CHECK_PARALLEL = 8;

// The rule for a precision level, or null for no check (level 1, or a value no level has).
export function checkRule(precision) {
  // Integers only: RULES' keys are strings, so "5" would match too.
  return Number.isInteger(precision) && Object.hasOwn(RULES, precision) ? RULES[precision] : null;
}

// Runs fn over items, at most `limit` at a time; the results come back in the items' order.
async function inPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The groups that replace `group` once its check (a validated plan over its tabs) is back. A part the check named like
// one of the person's own groups is a join to it (plan.js turned it into one), placed as such.
export function applyCheck(group, checked, rule) {
  const eject = group.tabIds.length >= rule.ejectFrom;
  const mine = new Set(group.tabIds);
  const parts = checked.groups
    .map((part) => ({ ...part, tabIds: part.tabIds.filter((id) => mine.has(id)) }))
    .filter((part) => part.tabIds.length >= 2);
  if (parts.length === 0) return eject ? [] : [group];
  const placed = new Set(parts.flatMap((part) => part.tabIds));
  const left = group.tabIds.filter((id) => !placed.has(id));
  if (left.length && !eject) {
    const largest = parts.reduce((a, b) => (b.tabIds.length > a.tabIds.length ? b : a));
    largest.tabIds = [...largest.tabIds, ...left];
  }
  // Still one subject: the group keeps its own name and icon.
  if (parts.length === 1) return [{ ...group, tabIds: parts[0].tabIds }];
  return parts.map((part) => (part.kind === "existing"
    ? { kind: "existing", groupId: part.groupId, name: part.name, icon: part.icon, tabIds: part.tabIds, placeAfterGroupId: null }
    : { kind: "new", name: part.name, icon: part.icon, tabIds: part.tabIds, placeAfterGroupId: group.placeAfterGroupId }));
}

// A check's answer as a plan over the group's tabs, or null when it can't be used: refused, malformed, or naming tabs
// that weren't sent (the model numbered them itself, say), which would otherwise read as every tab left out and empty
// the group. Its existing_group numbers are dropped (the check sees no groups); only a part's name can still match one
// of the person's own groups.
function readCheck(result, tabs, payload) {
  if (!result || result.refusal) return null;
  const output = result.output;
  const entries = output && typeof output === "object" && Array.isArray(output.groups)
    ? output.groups.map((entry) => (entry && typeof entry === "object" ? { ...entry, existing_group: 0 } : entry))
    : null;
  if (!entries) return null;
  const checked = validatePlan({ ...output, groups: entries }, { ...payload, tabs });
  return checked.issues.malformed.length || checked.issues.unknownIds.length ? null : checked;
}

// checkGroups(plan, payload, requestCheck, options) resolves to { plan, pass } (pass null when nothing was checked).
// - requestCheck(tabs, callOptions) resolves to { output } or { refusal: true }, or throws: as requestOutput does.
// - options: { precision, callOptions, onStart }: callOptions() is called as each check is about to start, for its
//   { timeoutMs }; null means it's too late, and that check (with every one after it) is skipped. onStart() is called
//   once before the first, only when there is a group to check.
// A split part named like another new group joins it: the check saw only its own group, and the same name means the
// passes had scattered that subject. Only tabs that were loose already or in a checked group can end up loose, so a tab
// refused or never sent stays out of the leftovers that regroupTwins and groupPrivateBySite may still move.
export async function checkGroups(plan, payload, requestCheck, { precision = DEFAULT_PRECISION, callOptions, onStart } = {}) {
  const rule = checkRule(precision);
  const todo = rule ? plan.groups.filter((group) => group.kind === "new" && group.tabIds.length >= rule.splitFrom) : [];
  if (todo.length === 0 || typeof requestCheck !== "function") return { plan, pass: null };
  if (typeof onStart === "function") onStart();
  const tabsById = new Map(payload.tabs.map((tab) => [payload.idMap[tab.id], tab]));
  let failed = 0;
  let sent = 0;
  let late = false;
  // Largest first: those hold most of the wrong pairs, so a check cut short by the deadline still did the most good.
  const bySize = [...todo].sort((a, b) => b.tabIds.length - a.tabIds.length);
  const answers = await inPool(bySize, CHECK_PARALLEL, async (group) => {
    const tabs = group.tabIds.map((id) => tabsById.get(id)).filter(Boolean);
    try {
      const options = typeof callOptions === "function" ? callOptions() : undefined;
      if (late || options === null) {
        late = true;
        return null;
      }
      sent += 1;
      const answer = readCheck(await requestCheck(tabs, options), tabs, payload);
      if (!answer) failed += 1;
      return answer;
    } catch {
      failed += 1;
      return null;
    }
  });
  const replaced = new Map(bySize.map((group, index) => [group, answers[index] ? applyCheck(group, answers[index], rule) : [group]]));

  const entries = plan.groups.flatMap((group) => {
    const parts = replaced.get(group) ?? [group];
    return parts.map((part) => ({ group: { ...part, tabIds: [...part.tabIds] }, split: parts.length > 1 }));
  });
  // Where a split part goes when it names a group already in the plan: a new group by name, a join by group id.
  const keyOf = (group) => (group.kind === "existing" ? `id:${group.groupId}` : `name:${nameKey(group.name)}`);
  const twins = new Map();
  for (const { group, split } of entries) if (!split && !twins.has(keyOf(group))) twins.set(keyOf(group), group);
  const groups = [];
  for (const { group, split } of entries) {
    if (split) {
      const twin = twins.get(keyOf(group));
      if (twin) {
        twin.tabIds.push(...group.tabIds);
        continue;
      }
      twins.set(keyOf(group), group);
    }
    groups.push(group);
  }
  const grouped = new Set(groups.flatMap((group) => group.tabIds));
  const checkedTabs = todo.flatMap((group) => group.tabIds);
  const mayBeLoose = new Set([...plan.leftoverTabIds, ...checkedTabs]);
  const stripOrder = payload.tabs.map((tab) => payload.idMap[tab.id]);
  return {
    plan: {
      ...plan,
      groups: groups.map((group, order) => ({ ...group, order })),
      leftoverTabIds: stripOrder.filter((id) => mayBeLoose.has(id) && !grouped.has(id)),
    },
    pass: {
      kind: "check", tabs: checkedTabs.length, grouped: checkedTabs.filter((id) => grouped.has(id)).length,
      calls: sent, stoppedEarly: failed > 0 || late,
    },
  };
}
