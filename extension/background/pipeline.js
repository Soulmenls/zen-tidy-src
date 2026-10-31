// Plan a tidy in two or three passes (pure orchestration; the model call is injected).
// Pass 1 groups every loose tab. Pass 2, the sweep, sends only the leftovers, with pass 1's new groups
// listed as existing groups, so tabs the first pass skipped can join them or form small new groups.
// The M1 benchmark found pass 1 alone grouped 44-77% of the tabs and the sweep raised that to 81-96%.
// When the sweep still leaves many tabs loose, one extra sweep runs over what is left (the coverage
// tail; see EXTRA_SWEEP_LEFTOVER_SHARE). Every pass goes through the refusal split, and a new group from any pass
// needs 2 tabs (plan.js). The sweep used to need 3 for its own groups, while the prompt asked for broad groups; with
// the one-subject prompt that floor left small subjects loose (Sonnet 5.5, 257 real tabs: 34 tabs per tidy loose that
// had a subject-mate, against 21 without it, for about 4 more tabs from unrelated fields). Then the group check
// (check.js) sorts each large group's tabs by subject again, as far as the precision setting asks. Last, regroupTwins
// puts copies of one page (same host and title) in one group, since the model sometimes splits them,
// and groupPrivateBySite groups the private tabs the model left loose by their site.

import { planWithRefusalSplit } from "./split.js";
import { validatePlan, mergePartialPlans, regroupTwins, groupPrivateBySite } from "./plan.js";
import { checkGroups, DEFAULT_PRECISION } from "./check.js";

export const SWEEP_MIN_LEFTOVERS = 5;
// The sweep decides from these samples whether a leftover fits a pass-1 group. With 3, the live run
// left clear fits loose next to large groups, so a group now shows up to this many.
export const SWEEP_SAMPLE_COUNT = 6;
// Each pass places only about 50-65% of the tabs it is sent, and that swings from run to run on the
// same tabs, so after a weak pass 1 or sweep a tidy could end near 62-80% coverage. When the sweep
// leaves more than this share of the sent tabs loose, one extra sweep runs over them. On 257 real tabs
// (M2 quality round, 26 tidies each way, with groupPrivateBySite) runs below 85% coverage fell from 12
// to 2 and the worst run rose from 62% to 82%; it ran in about 45% of tidies, and the judge flagged 6%
// of the tabs it placed. A sweep-specific instruction in the request was tried too and lowered coverage.
// Private tabs don't count: the model rarely groups a tab it sees only by its site, and
// groupPrivateBySite handles them.
export const EXTRA_SWEEP_LEFTOVER_SHARE = 0.12;
// It also needs at least this many loose non-private tabs, whatever the share: on a small re-tidy 12% is
// a handful of tabs, and a 23-tab re-tidy spent a third call on 6 of them to place 1.
export const EXTRA_SWEEP_MIN_LOOSE = 10;
// The extra sweep is skipped once pass 1 and the sweep have taken this long (a slow API, retries), so
// a tidy stays inside the 30 s target. The two passes normally take about 10 s on Haiku 5.5 and 17-21 s on Sonnet 5.5,
// the default, which then runs the extra sweep in about 4 of 5 tidies that call for one.
export const EXTRA_SWEEP_MAX_ELAPSED_MS = 20000;
// The guard above only decides whether the extra sweep starts, so its one call is time-boxed too: it
// may take what is left until this long after the tidy started, and never less than the minimum. A call
// that runs out fails like any other, and the two-pass plan stands.
export const EXTRA_SWEEP_DEADLINE_MS = 28000;
export const EXTRA_SWEEP_MIN_TIMEOUT_MS = 5000;
// The group checks take about 3 s together after the passes (17 Haiku 5.5 calls for 257 tabs, 8 at a time). Each one
// may take what is left until this long after the tidy started, and never less than the minimum; one that runs out
// leaves its group unchecked. A check starts only before this deadline, except the first ones (as many as run at once,
// the largest groups) when the passes ran past it, so a slow tidy ends at most about the minimum later.
export const CHECK_DEADLINE_MS = 34000;
export const CHECK_MIN_TIMEOUT_MS = 5000;

const hostOf = (site) => (typeof site === "string" ? site.split("/")[0] : "");

// Distinct titles in group order, one per site first so a large group shows its whole range.
// Payload titles are already redacted and private tabs have none, so samples can't leak.
function sampleTitles(tabs) {
  const titled = tabs.filter((tab) => tab && !tab.private && typeof tab.title === "string" && tab.title);
  const picked = new Set();
  const titles = new Set();
  const hosts = new Set();
  for (const newSiteOnly of [true, false]) {
    for (const tab of titled) {
      if (picked.size >= SWEEP_SAMPLE_COUNT) break;
      if (picked.has(tab) || titles.has(tab.title) || (newSiteOnly && hosts.has(hostOf(tab.site)))) continue;
      picked.add(tab);
      titles.add(tab.title);
      hosts.add(hostOf(tab.site));
    }
  }
  return titled.filter((tab) => picked.has(tab)).map((tab) => tab.title);
}

// The plan's new groups are not created yet, so they go to the model as "virtual" existing groups:
// numbered after the real ones, with no groupMap entry. plan.js keeps their name and icon, and
// mergePartialPlans folds the joined tabs into the earlier group of the same name.
function virtualGroups(plan, payload) {
  const tabsById = new Map(payload.tabs.map((tab) => [payload.idMap[tab.id], tab]));
  let number = Math.max(0, ...payload.existingGroups.map((group) => group.group));
  return plan.groups
    .filter((group) => group.kind === "new")
    .map((group) => ({
      group: ++number,
      name: group.name,
      icon: group.icon,
      samples: sampleTitles(group.tabIds.map((id) => tabsById.get(id))),
    }));
}

async function runPass(tabs, baseGroups, payload, requestOutput, splitOptions, callOptions) {
  const split = await planWithRefusalSplit(
    { tabs, existingGroups: baseGroups },
    (subset, extra) => requestOutput(subset, [...baseGroups, ...extra], callOptions),
    splitOptions,
  );
  const plans = split.outputs.map(({ output, tabs: subset, extraExistingGroups }) =>
    validatePlan(output, { ...payload, tabs: subset, existingGroups: [...baseGroups, ...extraExistingGroups] }),
  );
  return { split, plans };
}

// How many of the given real tab ids the plan has in a group.
function countGrouped(plan, tabIds) {
  const grouped = new Set(plan.groups.flatMap((group) => group.tabIds));
  return tabIds.filter((id) => grouped.has(id)).length;
}

// planTidy(payload, requestOutput, options) resolves to
// { plan, passes, refusedTabIds, unsentTabIds, calls }.
// - requestOutput(tabs, existingGroups, callOptions) resolves to { refusal: true, category } or
//   { output }, and throws a TidyApiError on failure (the run then rejects). callOptions is undefined,
//   except on the extra sweep: { timeoutMs }, the most its call may take, retries included.
// - options: { sweep = true, extraSweep = true, split: options for planWithRefusalSplit, onPass,
//   now = Date.now, requestCheck, precision = DEFAULT_PRECISION }. now times the extra sweep's latency guard and the
//   time boxes. requestCheck(tabs, callOptions) is the group check's call (check.js), answering as requestOutput does;
//   without it nothing is checked.
// - onPass(index) is called just before each pass starts (0 = pass 1, 1 = sweep, 2 = extra sweep, 3 = the
//   group check), for progress only: it is not awaited, and a throw or a rejected promise from it never affects the plan.
// - passes holds one entry per pass that ran: { kind: "pass1" | "sweep" | "extra" | "check", tabs, grouped,
//   calls, stoppedEarly }. tabs is how many tabs the pass was sent, and grouped how many of those were
//   in a group once its answer was merged. An extra sweep whose call failed is listed with grouped 0 and
//   failed: true; a check pass with a failed call has stoppedEarly true.
// refusedTabIds and unsentTabIds hold real tab ids; refused tabs stay loose and should be sent as
// private next time. plan.leftoverTabIds are loose tabs that no pass grouped.
export async function planTidy(payload, requestOutput, options = {}) {
  const {
    sweep = true, extraSweep = true, split: splitOptions = {}, onPass, now = Date.now, requestCheck,
    precision = DEFAULT_PRECISION,
  } = options ?? {};
  const base = Array.isArray(payload.existingGroups) ? payload.existingGroups : [];
  const toReal = (shortIds) => shortIds.map((id) => payload.idMap[id]).filter((id) => id !== undefined);
  const stripOrder = payload.tabs.map((tab) => payload.idMap[tab.id]);
  const startedAt = now();
  const reportPass = (index) => {
    if (typeof onPass !== "function") return;
    try {
      Promise.resolve(onPass(index)).catch(() => {});
    } catch {
      // Progress reporting must never cost the plan.
    }
  };

  reportPass(0);
  const first = await runPass(payload.tabs, base, payload, requestOutput, splitOptions);
  let plan = mergePartialPlans(first.plans);
  const passes = [{
    kind: "pass1", tabs: payload.tabs.length, grouped: countGrouped(plan, stripOrder),
    calls: first.split.calls, stoppedEarly: first.split.stoppedEarly,
  }];
  const refused = new Set(toReal(first.split.refusedTabIds));
  const unsent = new Set(toReal(first.split.unsentTabIds));
  let calls = first.split.calls;

  // Tabs a sweep may take: loose in the plan so far, and neither refused nor unsent (never retried).
  const sweepable = () => {
    const leftover = new Set(plan.leftoverTabIds);
    return payload.tabs.filter((tab) => {
      const id = payload.idMap[tab.id];
      return leftover.has(id) && !refused.has(id) && !unsent.has(id);
    });
  };

  // One leftover pass: the plan's new groups so far go to the model as virtual existing groups, and its
  // answer is merged into the plan as it stands (not into the earlier passes' raw answers), so the extra
  // sweep builds on the groups the sweep left.
  const sweepPass = async (index, tabs, passSplit, callOptions) => {
    const sweepBase = [...base, ...virtualGroups(plan, payload)];
    reportPass(index);
    const result = await runPass(tabs, sweepBase, payload, requestOutput, passSplit, callOptions);
    plan = mergePartialPlans([plan, ...result.plans]);
    calls += result.split.calls;
    const record = {
      tabs: tabs.length, grouped: countGrouped(plan, tabs.map((tab) => payload.idMap[tab.id])),
      calls: result.split.calls, stoppedEarly: result.split.stoppedEarly,
    };
    return { record, split: result.split };
  };

  const sweepTabs = sweepable();
  if (sweep && sweepTabs.length >= SWEEP_MIN_LEFTOVERS) {
    const second = await sweepPass(1, sweepTabs, splitOptions);
    passes.push({ kind: "sweep", ...second.record });
    toReal(second.split.refusedTabIds).forEach((id) => refused.add(id));
    toReal(second.split.unsentTabIds).forEach((id) => unsent.add(id));

    // The extra sweep makes at most one call. Its tabs already went through pass 1 and the sweep
    // without a refusal, so a refusal here is pinned on none of them: they stay loose, unmarked. It
    // only improves a plan that is already good to show, so a failed or timed-out call keeps that plan
    // instead of failing the tidy (plan is only replaced once the answer is in).
    const extraTabs = sweepable();
    const loosePublic = extraTabs.filter((tab) => tab.private !== true).length;
    const elapsed = now() - startedAt;
    const triggered = extraSweep && loosePublic >= EXTRA_SWEEP_MIN_LOOSE &&
      loosePublic > EXTRA_SWEEP_LEFTOVER_SHARE * payload.tabs.length && elapsed < EXTRA_SWEEP_MAX_ELAPSED_MS;
    if (triggered) {
      const timeoutMs = Math.max(EXTRA_SWEEP_MIN_TIMEOUT_MS, EXTRA_SWEEP_DEADLINE_MS - elapsed);
      try {
        const third = await sweepPass(2, extraTabs, { ...splitOptions, maxCalls: 1 }, { timeoutMs });
        passes.push({ kind: "extra", ...third.record });
      } catch {
        calls += 1;
        passes.push({ kind: "extra", tabs: extraTabs.length, grouped: 0, calls: 1, stoppedEarly: true, failed: true });
      }
    }
  }

  if (typeof requestCheck === "function") {
    let startBy = null;
    const checkOptions = () => {
      const elapsed = now() - startedAt;
      startBy ??= Math.max(CHECK_DEADLINE_MS, elapsed + 1);
      return elapsed >= startBy ? null : { timeoutMs: Math.max(CHECK_MIN_TIMEOUT_MS, CHECK_DEADLINE_MS - elapsed) };
    };
    const checked = await checkGroups(plan, payload, requestCheck, {
      precision, callOptions: checkOptions, onStart: () => reportPass(3),
    });
    plan = checked.plan;
    if (checked.pass) {
      passes.push(checked.pass);
      calls += checked.pass.calls;
    }
  }

  // Copies of one page (same host and title) end up in one group, whichever pass placed them.
  plan = regroupTwins(plan, payload);
  // Private tabs the passes left loose join their site's group, or form one when there are 2 or more.
  plan = groupPrivateBySite(plan, payload);
  // Pass 1 reports the tabs it skipped as missing even when a later step grouped them.
  const stillLoose = new Set(plan.leftoverTabIds);
  plan.issues.missingIds = plan.issues.missingIds.filter((id) => stillLoose.has(id));
  return { plan, passes, refusedTabIds: [...refused], unsentTabIds: [...unsent], calls };
}
