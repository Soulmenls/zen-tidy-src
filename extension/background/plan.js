// Validate and repair the model's grouping output (pure: no browser, fetch, timers or storage).
// The model only proposes; everything here assumes its output may be wrong or hostile.
//
// Id spaces: the model sees short ids (1..N) and group numbers (1..M). Returned groups, leftovers,
// duplicateIds, missingIds and droppedSmallGroups use real tab ids. unknownIds keeps the model's raw
// values, since by definition they map to nothing.

import { ICONS, DEFAULT_ICON, iconIndex } from "../shared/icons.js";
import { cleanVisibleName } from "./markers.js";

export const FALLBACK_NAME = "Group";
// A new group needs this many tabs; an existing group may receive a single tab.
export const MIN_NEW_GROUP_TABS = 2;

function emptyIssues() {
  return {
    unknownIds: [],
    duplicateIds: [],
    missingIds: [],
    droppedSmallGroups: [],
    badIcons: [],
    renamed: [],
    mergedNames: [],
    // Not in the M1 contract: structural problems (bad output, bad entries, unknown existing_group).
    malformed: [],
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lookup(map, key) {
  return isObject(map) && Object.hasOwn(map, String(key)) ? map[key] : undefined;
}

// For issue messages only; must never throw (BigInt and cycles cannot come from JSON, but still).
function show(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return typeof value;
  }
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

// Tab and group ids go straight to tabs.group, so anything else in a map is unusable.
function isBrowserId(value) {
  return Number.isInteger(value) && value >= 0;
}

// Map keys that read back as the same number. "01" or "1.0" would look up the wrong entry, or none.
function canonicalNumbers(map) {
  return Object.keys(isObject(map) ? map : {})
    .filter((key) => String(Number(key)) === key)
    .map(Number)
    .filter(isPositiveInt);
}

// An append-only list without repeats. The Set keeps it linear: garbled output can hold tens of
// thousands of ids, and Array.includes in a loop would block the event page.
function uniqueList(list = []) {
  const seen = new Set(list);
  return {
    list,
    add(value) {
      if (seen.has(value)) return;
      seen.add(value);
      list.push(value);
    },
  };
}

// Names are compared case-insensitively; NFC so precomposed and combining accents match.
export function nameKey(name) {
  return name.normalize("NFC").toLowerCase();
}

// The key groups merge on. Existing names are kept in full for display (Zen allows more than 32
// characters), but a model copying one writes at most 32, so both sides are cut the same way.
function mergeKey(name) {
  return nameKey(cleanVisibleName(name));
}

function sameName(a, b) {
  return nameKey(a) === nameKey(b);
}

export function matchIcon(icon) {
  const index = iconIndex(icon);
  return index >= 0 ? ICONS[index] : DEFAULT_ICON;
}

// Clean a model-written name. Records a rename when cleaning changed more than whitespace.
function cleanName(raw, issues) {
  const cleaned = cleanVisibleName(raw) || FALLBACK_NAME;
  noteRename(raw, cleaned, issues);
  return cleaned;
}

function noteRename(raw, finalName, issues) {
  const before = typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim() : raw;
  if (typeof before !== "string" || !sameName(before, finalName)) {
    issues.renamed.push({ from: raw, to: finalName });
  }
}

// Valid short ids, in snapshot order; each maps to a usable tab id. payload.tabs narrows the set, so
// a refusal-split chunk can be validated with { ...payload, tabs: chunkTabs } and ids from other
// chunks count as unknown.
function knownShortIds(payload) {
  const usable = (id) => isPositiveInt(id) && isBrowserId(lookup(payload.idMap, id));
  if (Array.isArray(payload.tabs)) {
    return [...new Set(payload.tabs.map((tab) => tab?.id).filter(usable))];
  }
  return canonicalNumbers(payload.idMap).filter(usable).sort((a, b) => a - b);
}

// Existing groups the model may reference. Only numbers in groupMap are real groups. Other listed
// entries (a refusal split's first-half groups, not created yet) are "virtual": joining one makes a
// new group with its name, which mergePartialPlans folds into the first half's group.
function existingIndex(payload) {
  const listed = new Map();
  for (const entry of Array.isArray(payload.existingGroups) ? payload.existingGroups : []) {
    if (isObject(entry) && isPositiveInt(entry.group) && !listed.has(entry.group)) {
      listed.set(entry.group, entry);
    }
  }
  const real = new Map();
  const byName = new Map();
  for (const number of canonicalNumbers(payload.groupMap)) {
    const groupId = payload.groupMap[number];
    if (!isBrowserId(groupId)) continue;
    const entry = listed.get(number);
    const group = {
      groupId,
      name: entry ? cleanVisibleName(entry.name, Number.MAX_SAFE_INTEGER) : null,
      icon: entry ? matchIcon(entry.icon) : null,
    };
    real.set(number, group);
    if (group.name && !byName.has(mergeKey(group.name))) byName.set(mergeKey(group.name), group);
  }
  const virtual = new Map();
  const virtualByName = new Map();
  for (const [number, entry] of listed) {
    if (real.has(number)) continue;
    const group = { name: cleanVisibleName(entry.name), icon: matchIcon(entry.icon) };
    virtual.set(number, group);
    const key = group.name && mergeKey(group.name);
    if (key && !byName.has(key) && !virtualByName.has(key)) virtualByName.set(key, group);
  }
  return { real, byName, virtual, virtualByName };
}

// Turn one raw group entry into a candidate, or null when the entry is unusable.
function readEntry(entry, index, ctx) {
  const { issues, existing, idMap, known, assigned, duplicates } = ctx;
  if (!isObject(entry)) {
    issues.malformed.push(`groups[${index}] is not an object`);
    return null;
  }
  if (!Array.isArray(entry.tab_ids)) {
    issues.malformed.push(`groups[${index}].tab_ids is not an array`);
    return null;
  }

  // First assignment wins; later copies of an id are reported and ignored.
  const tabIds = [];
  for (const shortId of entry.tab_ids) {
    if (!Number.isInteger(shortId) || !known.has(shortId)) {
      issues.unknownIds.push(shortId);
      continue;
    }
    const tabId = lookup(idMap, shortId);
    if (assigned.has(shortId)) {
      duplicates.add(tabId);
      continue;
    }
    assigned.add(shortId);
    tabIds.push(tabId);
  }

  if (iconIndex(entry.icon) < 0) issues.badIcons.push(entry.icon);
  const number = entry.existing_group;
  const real = isPositiveInt(number) ? existing.real.get(number) : undefined;

  if (real) {
    const name = real.name ?? cleanName(entry.name, issues);
    if (real.name) noteRename(entry.name, real.name, issues);
    return {
      kind: "existing", groupId: real.groupId, name, icon: real.icon ?? matchIcon(entry.icon),
      tabIds, placeAfterGroupId: null,
    };
  }

  // Unknown numbers make a new group.
  const virtual = isPositiveInt(number) ? existing.virtual.get(number) : undefined;
  if (number != null && number !== 0 && !virtual) {
    issues.malformed.push(`groups[${index}].existing_group ${show(number)} is not a known group`);
  }
  let name;
  let icon = matchIcon(entry.icon);
  if (virtual?.name) {
    name = virtual.name;
    icon = virtual.icon;
    noteRename(entry.name, name, issues);
  } else {
    name = cleanName(entry.name, issues);
  }
  const after = entry.place_after;
  const placeAfter = isPositiveInt(after) ? existing.real.get(after) : undefined;
  return { kind: "new", name, icon, tabIds, placeAfterGroupId: placeAfter ? placeAfter.groupId : null };
}

// Merge candidates in display order. A new group whose name matches an existing group joins it; one
// whose name matches a virtual group takes that group's name and icon; one whose name matches an
// earlier new group joins that one. Merged groups keep the place, icon and placement of their first
// occurrence.
function assemble(candidates, existing, issues) {
  const groups = [];
  const byGroupId = new Map();
  const byName = new Map();
  for (const candidate of candidates) {
    let c = candidate;
    if (c.kind === "new") {
      const nameMatch = mergeKey(c.name);
      const match = existing.byName.get(nameMatch);
      const virtual = existing.virtualByName.get(nameMatch);
      if (match) {
        issues.mergedNames.push(c.name);
        c = { kind: "existing", groupId: match.groupId, name: match.name, icon: match.icon,
              tabIds: c.tabIds, placeAfterGroupId: null };
      } else if (virtual) {
        c = { ...c, name: virtual.name, icon: virtual.icon, virtual: true };
      }
    }
    const index = c.kind === "existing" ? byGroupId : byName;
    const key = c.kind === "existing" ? c.groupId : mergeKey(c.name);
    const target = index.get(key);
    if (target) {
      if (c.kind === "new") issues.mergedNames.push(candidate.name);
      target.tabIds.push(...c.tabIds);
      if (target.placeAfterGroupId === null) target.placeAfterGroupId = c.placeAfterGroupId;
      continue;
    }
    const group = { ...c, tabIds: [...c.tabIds] };
    index.set(key, group);
    groups.push(group);
  }
  return groups;
}

// Drop new groups below the minimum and existing groups that receive nothing; number the rest.
// A join to a virtual group is held back instead: it is too small alone, but mergePartialPlans adds
// it to the group an earlier chunk made, the same way an existing group may receive 1 tab.
function finish(groups, issues) {
  const kept = [];
  const dropped = [];
  const pendingJoins = [];
  for (const group of groups) {
    const min = group.kind === "new" ? MIN_NEW_GROUP_TABS : 1;
    if (group.tabIds.length >= min) {
      kept.push(group);
      continue;
    }
    if (group.virtual && group.tabIds.length > 0) {
      pendingJoins.push({
        name: group.name, icon: group.icon, tabIds: [...group.tabIds], placeAfterGroupId: group.placeAfterGroupId,
      });
      continue;
    }
    const record = { name: group.name, tabIds: [...group.tabIds] };
    if (group.kind === "existing") record.groupId = group.groupId;
    issues.droppedSmallGroups.push(record);
    dropped.push(...group.tabIds);
  }
  return {
    groups: kept.map((group, order) => shapeGroup(group, order)),
    droppedTabIds: dropped,
    pendingJoins,
  };
}

function shapeGroup(group, order) {
  const shaped = { kind: group.kind };
  if (group.kind === "existing") shaped.groupId = group.groupId;
  shaped.name = group.name;
  shaped.icon = group.icon;
  shaped.tabIds = group.tabIds;
  shaped.placeAfterGroupId = group.kind === "existing" ? null : group.placeAfterGroupId;
  shaped.order = order;
  return shaped;
}

// Returns { groups, leftoverTabIds, pendingJoins, issues }. pendingJoins (not in the M1 contract) is
// only non-empty for a refusal-split chunk; its tabs are also in leftoverTabIds, so a caller that
// skips mergePartialPlans leaves them loose rather than in a 1-tab group.
export function validatePlan(output, payload) {
  const issues = emptyIssues();
  const safePayload = isObject(payload) ? payload : {};
  const idMap = isObject(safePayload.idMap) ? safePayload.idMap : {};
  const shortIds = knownShortIds({ ...safePayload, idMap });
  const known = new Set(shortIds);
  const existing = existingIndex(safePayload);

  let entries = [];
  if (!isObject(output)) {
    issues.malformed.push("output is not an object");
  } else if (!Array.isArray(output.groups)) {
    issues.malformed.push("groups is not an array");
  } else {
    entries = output.groups;
  }

  const ctx = {
    issues, existing, idMap, known, assigned: new Set(), duplicates: uniqueList(issues.duplicateIds),
  };
  const candidates = entries.map((entry, index) => readEntry(entry, index, ctx)).filter(Boolean);
  const { groups, droppedTabIds, pendingJoins } = finish(assemble(candidates, existing, issues), issues);

  const missing = shortIds.filter((id) => !ctx.assigned.has(id)).map((id) => idMap[id]);
  issues.missingIds.push(...missing);
  // Leftovers stay in snapshot order: tabs the model skipped, tabs from dropped groups and pending joins.
  const loose = new Set([...missing, ...droppedTabIds, ...pendingJoins.flatMap((join) => join.tabIds)]);
  const leftoverTabIds = shortIds.map((id) => idMap[id]).filter((tabId) => loose.has(tabId));
  return { groups, leftoverTabIds, pendingJoins, issues };
}

// Combine validated plans from refusal-split chunks, in chunk order, with the same merge rules.
// Pending joins are resolved here: they join the same-named group of an earlier chunk, or face the
// usual 2-tab minimum.
export function mergePartialPlans(plans) {
  const issues = emptyIssues();
  const valid = (Array.isArray(plans) ? plans : []).filter(
    (plan) => isObject(plan) && Array.isArray(plan.groups),
  );
  const unique = {
    unknownIds: uniqueList(issues.unknownIds),
    duplicateIds: uniqueList(issues.duplicateIds),
    missingIds: uniqueList(issues.missingIds),
  };

  for (const plan of valid) {
    if (!isObject(plan.issues)) continue;
    for (const key of Object.keys(issues)) {
      const values = Array.isArray(plan.issues[key]) ? plan.issues[key] : [];
      for (const value of values) {
        if (Object.hasOwn(unique, key)) unique[key].add(value);
        else issues[key].push(value);
      }
    }
  }

  // Every existing group seen in any chunk, so a new group from an earlier chunk can join one that
  // only a later chunk mentions.
  const existingByName = new Map();
  for (const plan of valid) {
    for (const group of plan.groups) {
      if (group?.kind === "existing" && typeof group.name === "string" && group.name) {
        const key = mergeKey(group.name);
        if (!existingByName.has(key)) {
          existingByName.set(key, { groupId: group.groupId, name: group.name, icon: group.icon });
        }
      }
    }
  }

  // A tab claimed by two chunks keeps its first group.
  const assigned = new Set();
  const candidates = [];
  for (const plan of valid) {
    const pending = Array.isArray(plan.pendingJoins) ? plan.pendingJoins : [];
    for (const group of [...plan.groups, ...pending]) {
      if (!isObject(group) || !Array.isArray(group.tabIds)) continue;
      const tabIds = [];
      for (const tabId of group.tabIds) {
        if (assigned.has(tabId)) {
          unique.duplicateIds.add(tabId);
          continue;
        }
        assigned.add(tabId);
        tabIds.push(tabId);
      }
      candidates.push({
        kind: group.kind === "existing" ? "existing" : "new",
        groupId: group.groupId,
        name: typeof group.name === "string" ? group.name : FALLBACK_NAME,
        icon: matchIcon(group.icon),
        tabIds,
        placeAfterGroupId: group.kind === "existing" ? null : (group.placeAfterGroupId ?? null),
      });
    }
  }

  const existing = { byName: existingByName, virtualByName: new Map() };
  const { groups, droppedTabIds } = finish(assemble(candidates, existing, issues), issues);
  const grouped = new Set(groups.flatMap((group) => group.tabIds));
  const loose = uniqueList();
  for (const plan of valid) {
    for (const tabId of Array.isArray(plan.leftoverTabIds) ? plan.leftoverTabIds : []) {
      if (!grouped.has(tabId)) loose.add(tabId);
    }
  }
  for (const tabId of droppedTabIds) loose.add(tabId);
  return { groups, leftoverTabIds: loose.list, pendingJoins: [], issues };
}

// A payload tab's twin key: its host (from the redacted site) and its exact title. Tabs with the
// same key are copies of one page. Private tabs carry no title, so they have no key.
function twinKey(tab) {
  if (!isObject(tab) || tab.private === true) return null;
  if (typeof tab.title !== "string" || !tab.title || typeof tab.site !== "string") return null;
  const host = tab.site.split("/")[0].toLowerCase().replace(/^www\./, "");
  return host ? `${host}\n${tab.title}` : null;
}

// The group that keeps a set of twins: the one holding most of them, then the larger group, then
// the earlier one.
function twinTarget(counts, sizes) {
  let best = null;
  for (const [index, count] of counts) {
    const better =
      best === null ||
      count > counts.get(best) ||
      (count === counts.get(best) && (sizes[index] > sizes[best] || (sizes[index] === sizes[best] && index < best)));
    if (better) best = index;
  }
  return best;
}

// Runs after validation and merging: tabs with the same host and the same title belong together,
// but the model sometimes splits them, most often across the two passes. Each twin in another group
// moves to the group holding most of its twins, right after the last of them, and a twin the plan
// left loose joins it too. Private tabs are never matched. A group that falls below its minimum is
// dropped and its tabs go back to the leftovers. issues.regroupedTwins (not in the M1 contract)
// lists the real tab ids that moved. Pure: returns a new plan.
export function regroupTwins(plan, payload) {
  if (!isObject(plan) || !Array.isArray(plan.groups)) return plan;
  const safePayload = isObject(payload) ? payload : {};
  const idMap = isObject(safePayload.idMap) ? safePayload.idMap : {};
  const groups = plan.groups.map((group) => ({ ...group, tabIds: Array.isArray(group?.tabIds) ? [...group.tabIds] : [] }));
  const leftovers = Array.isArray(plan.leftoverTabIds) ? plan.leftoverTabIds : [];
  const issues = isObject(plan.issues) ? plan.issues : emptyIssues();

  const groupOf = new Map();
  groups.forEach((group, index) => {
    for (const tabId of group.tabIds) if (!groupOf.has(tabId)) groupOf.set(tabId, index);
  });
  const loose = new Set(leftovers.filter((tabId) => !groupOf.has(tabId)));

  // Real tab id -> twin key, and twin key -> its tabs that the plan holds, both in strip order.
  const keyOf = new Map();
  const twins = new Map();
  const stripOrder = new Map();
  for (const tab of Array.isArray(safePayload.tabs) ? safePayload.tabs : []) {
    const tabId = isObject(tab) && isPositiveInt(tab.id) ? lookup(idMap, tab.id) : undefined;
    if (!isBrowserId(tabId) || stripOrder.has(tabId)) continue;
    stripOrder.set(tabId, stripOrder.size);
    const key = twinKey(tab);
    if (!key || (!groupOf.has(tabId) && !loose.has(tabId))) continue;
    keyOf.set(tabId, key);
    if (!twins.has(key)) twins.set(key, []);
    twins.get(key).push(tabId);
  }

  const sizes = groups.map((group) => group.tabIds.length);
  const moves = new Map();
  for (const members of twins.values()) {
    if (members.length < 2) continue;
    const counts = new Map();
    for (const tabId of members) {
      if (groupOf.has(tabId)) counts.set(groupOf.get(tabId), (counts.get(groupOf.get(tabId)) ?? 0) + 1);
    }
    if (!counts.size) continue;
    const target = twinTarget(counts, sizes);
    for (const tabId of members) if (groupOf.get(tabId) !== target) moves.set(tabId, target);
  }
  if (!moves.size) return { ...plan, issues: { ...issues, regroupedTwins: [] } };

  // Incoming twins, by target group and key; each key already has a member in its target.
  const incoming = groups.map(() => new Map());
  for (const [tabId, target] of moves) {
    const byKey = incoming[target];
    const key = keyOf.get(tabId);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tabId);
  }
  groups.forEach((group, index) => {
    const kept = group.tabIds.filter((tabId) => !moves.has(tabId));
    const byKey = incoming[index];
    if (!byKey.size) {
      group.tabIds = kept;
      return;
    }
    const lastAt = new Map();
    kept.forEach((tabId, at) => {
      if (byKey.has(keyOf.get(tabId))) lastAt.set(keyOf.get(tabId), at);
    });
    const after = new Map([...lastAt].map(([key, at]) => [at, key]));
    group.tabIds = kept.flatMap((tabId, at) => (after.has(at) ? [tabId, ...byKey.get(after.get(at))] : [tabId]));
  });

  const kept = [];
  const dropped = [];
  const droppedSmallGroups = [...(Array.isArray(issues.droppedSmallGroups) ? issues.droppedSmallGroups : [])];
  for (const group of groups) {
    if (group.tabIds.length >= (group.kind === "new" ? MIN_NEW_GROUP_TABS : 1)) {
      kept.push(group);
      continue;
    }
    const record = { name: group.name, tabIds: [...group.tabIds] };
    if (group.kind === "existing") record.groupId = group.groupId;
    droppedSmallGroups.push(record);
    dropped.push(...group.tabIds);
  }

  // Leftovers in strip order; an id the payload doesn't list keeps its place after them.
  const position = (tabId) => stripOrder.get(tabId) ?? Number.MAX_SAFE_INTEGER;
  const loosened = uniqueList();
  for (const tabId of loose) if (!moves.has(tabId)) loosened.add(tabId);
  for (const tabId of dropped) loosened.add(tabId);
  const leftoverTabIds = loosened.list.sort((a, b) => position(a) - position(b));
  return {
    ...plan,
    groups: kept.map((group, order) => ({ ...group, order })),
    leftoverTabIds,
    issues: { ...issues, droppedSmallGroups, regroupedTwins: [...moves.keys()] },
  };
}

// ---------------------------------------------------------------------------------------------
// Private tabs by site

// The icon of a group made of private tabs only.
export const PRIVATE_GROUP_ICON = "lock-closed";
// A group "holds" a site when at least this share of its tabs are on it. A multi-topic site (a search
// engine, a forum) turns up in many topic groups, and a private tab on it can't be matched to one by
// topic, so it only joins a group that is about the site itself.
export const SITE_GROUP_SHARE = 0.5;

// Suffixes under which each name is a separate site. Country second levels follow one pattern (a
// generic label under a two-letter country code: co.uk, com.au, or.jp, gob.mx, gouv.fr, gv.at), so a
// rule covers them instead of a list. Labels that are also short names in their own right (gr.ch is a
// Swiss canton, tm a trademark or a brand) are left out: a missing one only puts a country's public
// bodies in one group. Hosting domains give each customer a subdomain (two github.io pages are usually
// two people's) and have to be listed; the list is small on purpose: a missing entry only means two
// unrelated private tabs share a group, which the preview shows and the person can undo.
const COUNTRY_SECOND_LEVELS = new Set([
  "co", "com", "net", "org", "gov", "govt", "gouv", "gv", "gc", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "asso",
  "nom", "ltd", "plc", "sch", "nhs",
]);
const HOSTING_SUFFIXES = new Set([
  "github.io", "gitlab.io", "blogspot.com", "wordpress.com", "substack.com", "tumblr.com",
  "herokuapp.com", "netlify.app", "vercel.app", "pages.dev", "web.app", "firebaseapp.com", "appspot.com",
  "azurewebsites.net", "cloudfront.net",
]);
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;
const HOST_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

// A payload site's registrable domain: "us.broker.example" and "broker.example" are both "broker.example", and
// "news.bbc.co.uk" is "bbc.co.uk". site is a host, or host plus path for a titled tab. IP addresses and
// one-label hosts stay whole. A host cut short by the display cap ("…") or with other characters has
// no domain (null), so it never matches anything.
export function siteDomain(site) {
  if (typeof site !== "string") return null;
  const host = site.split("/")[0].toLowerCase().replace(/\.+$/, "");
  if (IPV4_RE.test(host) || IPV6_RE.test(host)) return host;
  if (!HOST_RE.test(host)) return null;
  const labels = host.split(".");
  const [second, top] = labels.slice(-2);
  const multiLabel = HOSTING_SUFFIXES.has(`${second}.${top}`) || (top?.length === 2 && COUNTRY_SECOND_LEVELS.has(second));
  return labels.slice(labels.length > 2 && multiLabel ? -3 : -2).join(".");
}

// RFC 3492 decoding of the part of an IDN label after "xn--", or null when it isn't valid punycode.
// Labels are at most 63 characters, so the loops stay short; the bounds only stop garbage early.
function decodePunycode(input) {
  const BASE = 36;
  const T_MIN = 1;
  const T_MAX = 26;
  const MAX_INT = 0x7fffffff;
  const adapt = (delta, points, first) => {
    let d = first ? Math.floor(delta / 700) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
      d = Math.floor(d / (BASE - T_MIN));
      k += BASE;
    }
    return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + 38));
  };
  const digitOf = (code) => {
    if (code >= 48 && code <= 57) return code - 22;
    if (code >= 97 && code <= 122) return code - 97;
    if (code >= 65 && code <= 90) return code - 65;
    return BASE;
  };
  const basic = Math.max(input.lastIndexOf("-"), 0);
  const output = [];
  for (let at = 0; at < basic; at++) {
    if (input.charCodeAt(at) >= 0x80) return null;
    output.push(input.charCodeAt(at));
  }
  let n = 128;
  let i = 0;
  let bias = 72;
  for (let at = basic > 0 ? basic + 1 : 0; at < input.length;) {
    const oldI = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (at >= input.length) return null;
      const digit = digitOf(input.charCodeAt(at++));
      if (digit >= BASE || digit * w > MAX_INT - i) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > MAX_INT / (BASE - t)) return null;
      w *= BASE - t;
    }
    const points = output.length + 1;
    bias = adapt(i - oldI, points, oldI === 0);
    n += Math.floor(i / points);
    i %= points;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

// The name of a private site group: the domain's own label, capitalized ("broker.com" is "Broker",
// "x1.com" is "X1", "my-bank.co.uk" is "My Bank"). A punycode label is decoded so an IDN site reads
// as itself; an IP address keeps its digits.
export function siteName(domain) {
  if (typeof domain !== "string" || !domain) return FALLBACK_NAME;
  if (IPV4_RE.test(domain) || IPV6_RE.test(domain)) return domain;
  let label = domain.split(".")[0];
  if (label.startsWith("xn--")) label = decodePunycode(label.slice(4)) ?? label;
  const words = label.split(/[-_]+/u).filter(Boolean).map((word) => {
    const [first, ...rest] = [...word];
    return first.toUpperCase() + rest.join("");
  });
  return cleanVisibleName(words.join(" ")) || FALLBACK_NAME;
}

// The group holding a site: at least SITE_GROUP_SHARE of its tabs on it; then most tabs on the site,
// the larger group, the earlier one. -1 when none does.
function siteGroupIndex(groups, domain, domainOf) {
  let best = -1;
  let bestCount = 0;
  groups.forEach((group, index) => {
    const count = group.tabIds.filter((tabId) => domainOf.get(tabId) === domain).length;
    if (!count || count < SITE_GROUP_SHARE * group.tabIds.length) return;
    const better = best < 0 || count > bestCount || (count === bestCount && group.tabIds.length > groups[best].tabIds.length);
    if (better) {
      best = index;
      bestCount = count;
    }
  });
  return best;
}

// Runs last, after regroupTwins. Private tabs reach the model as a site only, so it leaves nearly all of
// them loose (11 of 12 in the M2 live run). This groups them by registrable domain, locally: the host was
// already sent, so nothing new leaves the browser. Each site's loose private tabs, sites in strip order:
// 1. join the group holding the site (siteGroupIndex), right after its last tab on the site;
// 2. else join a group with the site's name: one in the plan, or a real existing group, which is how a
//    site group from an earlier tidy gets the next tab (it enters the plan as a join);
// 3. else, 2 or more of them form a new group named after the site, with the lock icon, at the end of
//    the display order;
// 4. else the lone tab stays loose.
// Only tabs in plan.leftoverTabIds move (refused and unsent tabs stay loose), and a private tab the model
// placed stays where it is. issues.privateGrouped (not in the M1 contract) lists the real tab ids that
// moved. Pure: returns a new plan.
export function groupPrivateBySite(plan, payload) {
  if (!isObject(plan) || !Array.isArray(plan.groups)) return plan;
  const safePayload = isObject(payload) ? payload : {};
  const idMap = isObject(safePayload.idMap) ? safePayload.idMap : {};
  const issues = isObject(plan.issues) ? plan.issues : emptyIssues();
  const groups = plan.groups.map((group) => ({ ...group, tabIds: Array.isArray(group?.tabIds) ? [...group.tabIds] : [] }));
  const leftovers = Array.isArray(plan.leftoverTabIds) ? plan.leftoverTabIds : [];
  const grouped = new Set(groups.flatMap((group) => group.tabIds));
  const loose = new Set(leftovers.filter((tabId) => !grouped.has(tabId)));

  // Real tab id -> registrable domain, and each site's loose private tabs, both in strip order.
  const domainOf = new Map();
  const privateBySite = new Map();
  for (const tab of Array.isArray(safePayload.tabs) ? safePayload.tabs : []) {
    const tabId = isObject(tab) && isPositiveInt(tab.id) ? lookup(idMap, tab.id) : undefined;
    if (!isBrowserId(tabId) || domainOf.has(tabId)) continue;
    const domain = siteDomain(tab.site);
    domainOf.set(tabId, domain);
    if (!domain || tab.private !== true || !loose.has(tabId)) continue;
    if (!privateBySite.has(domain)) privateBySite.set(domain, []);
    privateBySite.get(domain).push(tabId);
  }
  if (!privateBySite.size) return { ...plan, issues: { ...issues, privateGrouped: [] } };

  const existing = existingIndex(safePayload);
  const moved = [];
  for (const [domain, tabIds] of privateBySite) {
    const name = siteName(domain);
    let index = siteGroupIndex(groups, domain, domainOf);
    if (index < 0) index = groups.findIndex((group) => typeof group.name === "string" && mergeKey(group.name) === mergeKey(name));
    if (index < 0) {
      const real = existing.byName.get(mergeKey(name));
      const inPlan = real ? groups.findIndex((group) => group.kind === "existing" && group.groupId === real.groupId) : -1;
      if (inPlan >= 0) index = inPlan;
      else if (real) index = groups.push({ kind: "existing", groupId: real.groupId, name: real.name, icon: real.icon, tabIds: [], placeAfterGroupId: null }) - 1;
    }
    if (index < 0 && tabIds.length < MIN_NEW_GROUP_TABS) continue;
    if (index < 0) {
      groups.push({ kind: "new", name, icon: PRIVATE_GROUP_ICON, tabIds: [...tabIds], placeAfterGroupId: null });
    } else {
      const target = groups[index];
      const lastOnSite = target.tabIds.findLastIndex((tabId) => domainOf.get(tabId) === domain);
      target.tabIds.splice(lastOnSite < 0 ? target.tabIds.length : lastOnSite + 1, 0, ...tabIds);
    }
    moved.push(...tabIds);
  }

  const movedSet = new Set(moved);
  return {
    ...plan,
    groups: groups.map((group, order) => ({ ...group, order })),
    leftoverTabIds: leftovers.filter((tabId) => !movedSet.has(tabId)),
    issues: { ...issues, privateGrouped: moved },
  };
}
