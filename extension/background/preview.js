// Preview model and apply-request validation (pure: no browser, fetch, timers or storage).
// buildPreview turns a snapshot plus planTidy's result, and the Extras extras.js found (duplicate and stale tabs to
// close), into what the popup shows. validateApplyRequest checks the popup's edited answer against that preview
// before anything touches the browser: the request comes from a page, so it is treated as untrusted and never makes
// this module throw. Shapes: notes/m2-contracts.md, and notes/m4-contracts.md ("Preview and apply") for Extras.

import { cleanVisibleName, MAX_NAME_LENGTH } from "./markers.js";
import { matchIcon, FALLBACK_NAME, MIN_NEW_GROUP_TABS } from "./plan.js";
import { urlHash } from "../shared/hash.js";
import { holdsKey } from "./store.js";

const NO_GROUP = -1;
// The editor can only move tabs between the preview's groups, so a real request never comes close to these.
export const MAX_REQUEST_GROUPS = 200;
const MAX_KEY_LENGTH = 32;
const KEY_RE = /^[A-Za-z0-9_-]+$/;
// Saved edits (validateEdits): no string the popup sends is longer, except an existing group's own longer name.
export const MAX_EDIT_STRING = 200;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

// run.js may pass a value or a generator; both are accepted so the two modules can't disagree.
function resolve(value) {
  return typeof value === "function" ? value() : value;
}

// The popup shows the host so similar titles can be told apart; tabs without one (about:, file:) show none.
// The row's second line. Web tabs show their host; other tabs get a plain label, because a
// moz-extension host is a random UUID and a file: URL has no host at all.
const SCHEME_LABELS = new Map([["file:", "Local file"], ["moz-extension:", "Extension page"], ["about:", "Browser page"]]);

function siteLabel(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "http:" || protocol === "https:") return hostname;
    return SCHEME_LABELS.get(protocol) ?? "";
  } catch {
    return "";
  }
}

// The extension's own pages (the popup or Settings open in a tab) are never sent or grouped, so listing them as
// tabs that stay loose would only be noise. ownOrigin is runtime.getURL(""), "moz-extension://<uuid>/".
function ownPageTest(ownOrigin) {
  if (typeof ownOrigin !== "string" || !/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.test(ownOrigin)) return () => false;
  const prefix = ownOrigin.endsWith("/") ? ownOrigin : `${ownOrigin}/`;
  return (tab) => typeof tab.url === "string" && tab.url.startsWith(prefix);
}

// Extras only ever close http(s) tabs: undo can reopen nothing else (implementation-notes, "Undo").
const isWebUrl = (url) => typeof url === "string" && /^https?:\/\//i.test(url);

// preview.extras (notes/m4-contracts.md): the tabs extras.js offers to close, every one unticked:
//   duplicates: [{ tabId, title, site, keepTitle, groupKey, private, checked: false, urlHash, keepTabId, keepUrlHash }]
//   stale:      [{ tabId, title, site, days,      groupKey, private, checked: false, urlHash }]
//   staleDays:  the day count the stale tabs were found with (findExtras' own, the setting or its default), so the
//               popup's heading "Not opened in N days" names the rows' threshold, 0 (the dev override) included. Left
//               out when extras.js gave none that is a whole number >= 0; the popup then shows the default.
//   activeTabId: the tab that was active when the preview was made (buildPreview adds it when the snapshot names
//               one), so apply can tell a tab activated since, such as a Glance opened from an offered tab, from the
//               one the popup was opened from (validateApplyRequest's closeChecks, apply.js closableIn).
// A tab offered here closes on Apply, so the detector's rules are checked again against this snapshot: one of its
// tabs (never the extension's own page), loose or in the tidy group the snapshot lists it in (so unpinned and outside
// any split: a loose tab is neither, and a tidy group holds no pinned tab and is never a split), on an http(s) page,
// neither the active tab nor a Glance suspect, and not a page whose address holds a key-shaped string (store.js
// holdsKey: undo could not reopen it as it was). A duplicate's kept copy must be another tab of the snapshot, and a
// kept copy is never offered itself, as a duplicate or as stale (extras.js has the same rule): otherwise ticking both
// could close every copy of the page. A tab named as some offered duplicate's kept copy therefore gets no row, even
// when that leaves a second copy open (two rows that keep each other both go). Each tab is offered once, as a
// duplicate first (extras.js does the same), in the order extras.js gave.
// groupKey: the preview group whose rows list the tab (new or existing), where the popup marks it "Will close"; null
// for leftovers and for tabs already in a tidy group, which no row lists. private: as the payload sent the tab (tabs
// already in a group are not sent, so false).
// urlHash / keepUrlHash: the fingerprint (shared/hash.js urlHash) of the offered tab's address and of its kept copy's,
// salted with the preview's id, never the address. validateApplyRequest hands them to apply, which closes a tab only
// while it still shows that page and, for a duplicate, while its kept copy (keepTabId) is still open on its own page:
// the preview stays while the popup is closed, and a ticked tab may have navigated, or its kept copy closed, since.
function previewExtras(extras, { snapshot, tabsById, isLoose, privateIds, suspectIds, groupKeyOf, salt }) {
  const tidyGroupOf = new Map(
    list(snapshot?.tidyGroups).filter(isObject).flatMap((group) => list(group.tabIds).map((tabId) => [tabId, group.id])),
  );
  // tidyGroupOf.has: a tab without a groupId field must not match a missing entry (undefined === undefined).
  const offerable = (tab) =>
    Boolean(tab) && !tab.active && !suspectIds.has(tab.id) && isWebUrl(tab.url) && !holdsKey(tab.url) &&
    (isLoose(tab) || (tidyGroupOf.has(tab.id) && tidyGroupOf.get(tab.id) === tab.groupId));
  const fingerprint = (tab) => urlHash(salt, tab.url);
  const offered = new Set();
  // The row for raw.tabId with `fields` added, or null when that tab can't be offered (or already is).
  const row = (raw, fields) => {
    const tab = offered.has(raw.tabId) ? undefined : tabsById.get(raw.tabId);
    if (!offerable(tab)) return null;
    offered.add(tab.id);
    return {
      tabId: tab.id, title: typeof tab.title === "string" ? tab.title : "", site: siteLabel(tab.url), ...fields,
      groupKey: groupKeyOf.get(tab.id) ?? null, private: privateIds.has(tab.id), checked: false, urlHash: fingerprint(tab),
    };
  };

  const candidates = [];
  for (const raw of list(extras?.duplicates)) {
    const keep = isObject(raw) && raw.keepTabId !== raw.tabId ? tabsById.get(raw.keepTabId) : undefined;
    const ref = keep
      ? row(raw, { keepTitle: typeof keep.title === "string" ? keep.title : "" })
      : null;
    if (ref) candidates.push({ ...ref, keepTabId: keep.id, keepUrlHash: fingerprint(keep) });
  }
  // Second pass: a kept copy never gets a row of its own (it stays in `offered`, so no stale row either).
  const kept = new Set(candidates.map((ref) => ref.keepTabId));
  const duplicates = candidates.filter((ref) => !kept.has(ref.tabId));
  for (const tabId of kept) offered.add(tabId);
  const stale = [];
  for (const raw of list(extras?.stale)) {
    const ref = isObject(raw) && Number.isFinite(raw.days) && raw.days >= 0 ? row(raw, { days: Math.floor(raw.days) }) : null;
    if (ref) stale.push(ref);
  }
  const staleDays = isObject(extras) && Number.isInteger(extras.staleDays) && extras.staleDays >= 0 ? extras.staleDays : undefined;
  return staleDays === undefined ? { duplicates, stale } : { duplicates, stale, staleDays };
}

// The rows preview.extras offers, by tab id: the only tabs a request or the saved edits may close. `duplicate`: the
// row is a duplicate's, whose kept copy apply checks too.
function offeredExtras(preview) {
  const offered = new Map();
  const add = (refs, duplicate) => {
    for (const ref of list(refs)) {
      if (isObject(ref) && Number.isInteger(ref.tabId) && !offered.has(ref.tabId)) offered.set(ref.tabId, { ref, duplicate });
    }
  };
  add(preview?.extras?.duplicates, true);
  add(preview?.extras?.stale, false);
  return offered;
}

// What apply checks before it closes a tab (request.closeChecks): the tab still shows the page the preview offered,
// and a duplicate's kept copy is still open on its own page. Fingerprints only (previewExtras). buildPreview always
// sets them; a row without its own fingerprint (a preview from before they existed) gets no check (null), and a
// duplicate row without its kept copy's id and fingerprint gets no `keep`.
function closeCheck(tabId, { ref, duplicate }) {
  if (typeof ref.urlHash !== "string") return null;
  const keep = duplicate && Number.isInteger(ref.keepTabId) && typeof ref.keepUrlHash === "string"
    ? { tabId: ref.keepTabId, urlHash: ref.keepUrlHash }
    : null;
  return { tabId, urlHash: ref.urlHash, keep };
}

// preview = buildPreview({ snapshot, payload, tidy, now, id, ownOrigin, extras })
// tidy is planTidy's result ({ plan, refusedTabIds, unsentTabIds, ... }). Titles are the real tab titles: the
// preview stays in the extension (storage.session), unlike the payload. Leftovers are every loose tab that is in
// no group, so refused, unsent and non-web tabs (payload.stats.excluded) show up there; split tabs never appear,
// and neither do the extension's own pages when ownOrigin is given. extras is findExtras' result
// ({ duplicates: [{ tabId, keepTabId, url }], stale: [{ tabId, days }], staleDays }); its URLs never reach the preview.
// The preview's id (random in run.js) also salts the extras' page fingerprints (previewExtras).
export function buildPreview({ snapshot, payload, tidy, now, id, ownOrigin, extras } = {}) {
  const previewId = resolve(id);
  const isOwnPage = ownPageTest(ownOrigin);
  const tabs = list(snapshot?.tabs).filter((tab) => isObject(tab) && !isOwnPage(tab));
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const looseIds = new Set(list(snapshot?.looseTabIds));
  const splitIds = new Set(list(snapshot?.splitTabIds));
  const privateIds = new Set(list(payload?.privateTabIds));
  const suspectIds = new Set(list(snapshot?.glanceSuspectIds));
  const tidyGroups = new Map(list(snapshot?.tidyGroups).filter(isObject).map((group) => [group.id, group]));

  const isLoose = (tab) =>
    Boolean(tab) && looseIds.has(tab.id) && !splitIds.has(tab.id) && !tab.pinned && (tab.groupId ?? NO_GROUP) === NO_GROUP;
  const tabRef = (tab) => {
    const suspect = suspectIds.has(tab.id);
    return {
      tabId: tab.id,
      title: typeof tab.title === "string" ? tab.title : "",
      site: siteLabel(tab.url),
      private: privateIds.has(tab.id),
      suspect,
      checked: !suspect,
    };
  };

  const grouped = new Set();
  const groups = [];
  for (const group of list(tidy?.plan?.groups)) {
    if (!isObject(group)) continue;
    const existing = group.kind === "existing" ? tidyGroups.get(group.groupId) : undefined;
    if (group.kind === "existing" && !existing) continue;
    // The plan only holds loose tabs, but a tab listed twice or no longer loose must not be shown twice.
    const members = [...new Set(list(group.tabIds))].filter((tabId) => !grouped.has(tabId) && isLoose(tabsById.get(tabId)));
    if (members.length < (existing ? 1 : MIN_NEW_GROUP_TABS)) continue;
    members.forEach((tabId) => grouped.add(tabId));
    groups.push({
      key: `g${groups.length + 1}`,
      kind: existing ? "existing" : "new",
      groupId: existing ? existing.id : null,
      // An existing group shows its own name and icon as they are in Zen, not the model's copy.
      name: existing ? existing.name : cleanVisibleName(group.name) || FALLBACK_NAME,
      icon: existing ? existing.icon : matchIcon(group.icon),
      placeAfterGroupId: !existing && tidyGroups.has(group.placeAfterGroupId) ? group.placeAfterGroupId : null,
      tabs: members.map((tabId) => tabRef(tabsById.get(tabId))),
    });
  }

  const groupKeyOf = new Map(groups.flatMap((group) => group.tabs.map((ref) => [ref.tabId, group.key])));
  return {
    id: previewId,
    windowId: snapshot?.windowId,
    createdAt: resolve(now),
    multiWindow: (snapshot?.windowCount ?? 1) > 1,
    refusedCount: list(tidy?.refusedTabIds).length,
    groups,
    leftovers: tabs.filter((tab) => isLoose(tab) && !grouped.has(tab.id)).map(tabRef),
    extras: {
      ...previewExtras(extras, { snapshot, tabsById, isLoose, privateIds, suspectIds, groupKeyOf, salt: closeSalt(previewId) }),
      ...(Number.isInteger(snapshot?.activeTabId) ? { activeTabId: snapshot.activeTabId } : {}),
    },
  };
}

// The salt of a preview's page fingerprints: its id, as text ("" without one).
function closeSalt(previewId) {
  return previewId === undefined || previewId === null ? "" : String(previewId);
}

function fail(error) {
  return { ok: false, error };
}

function requestKey(raw, index, taken) {
  if (typeof raw === "string" && raw.length <= MAX_KEY_LENGTH && KEY_RE.test(raw) && !taken.has(raw)) return raw;
  let key = `r${index + 1}`;
  while (taken.has(key)) key += "_";
  return key;
}

// validateApplyRequest(request, preview) returns { ok: true, request } or { ok: false, error }.
// The cleaned request holds only tab ids the preview showed (in a group or in the leftovers), each at most once,
// with names cleaned, icons matched, unknown existing groups dropped, new groups below 2 tabs dropped, and the
// group order as sent. Existing groups carry `rename`: true when the name or icon differs from the preview, the
// only case in which apply rewrites that group's title; one that receives no tab is kept only to be renamed.
// They also carry `nameChanged`: false means only the icon changed, and apply keeps the name exactly as Zen shows
// it. A new name for an existing group is capped at max(32, the old name's length), since Zen allows longer ones.
// `close` (M4): the tabs ticked to close, only ids preview.extras offered, each at most once, in the order sent
// (missing or null: none). Closing wins: a tab to close is taken out of every group first, so the group-size rules
// above see the group without it (a new group left with one tab is dropped, an untouched existing one too). The
// cleaned request always has `close`, empty when nothing closes; a request with no group left that only closes tabs
// is valid. It also always has `closeChecks` = { salt, tabs: [{ tabId, urlHash, keep: { tabId, urlHash } | null }] },
// in `close` order, taken from the preview's own rows (never from the request), one for each tab whose row carries
// its fingerprint (closeCheck): apply closes such a tab only while it still shows the offered page and, for a
// duplicate (`keep` set), while its kept copy is still open on its own page (previewExtras). `salt` is the preview
// id as text. closeChecks also carry `activeTabId`, the preview's (when it has one, and the request closes a tab):
// apply leaves open a ticked tab right before an active tab other than that one, where a Glance opened from it sits.
export function validateApplyRequest(request, preview) {
  if (!isObject(preview)) return fail("no-preview");
  if (!isObject(request)) return fail("not-an-object");
  if (request.previewId !== preview.id) return fail("preview-mismatch");
  if (!Array.isArray(request.groups)) return fail("groups-not-array");
  if (request.groups.length > MAX_REQUEST_GROUPS) return fail("too-many-groups");
  if (request.close !== undefined && request.close !== null && !Array.isArray(request.close)) return fail("close-not-array");

  const previewGroups = list(preview.groups).filter(isObject);
  const knownTabs = new Set();
  for (const ref of [...previewGroups.flatMap((group) => list(group.tabs)), ...list(preview.leftovers)]) {
    if (isObject(ref) && Number.isInteger(ref.tabId)) knownTabs.add(ref.tabId);
  }
  const offered = offeredExtras(preview);
  // Each preview tab once, plus slack for a sloppy editor; anything bigger is garbage, refused before the scan.
  let entries = 0;
  for (const raw of request.groups) if (isObject(raw) && Array.isArray(raw.tabIds)) entries += raw.tabIds.length;
  if (entries > knownTabs.size * 2 + 16 || list(request.close).length > offered.size * 2 + 16) return fail("too-many-tabs");

  const close = [];
  const closing = new Set();
  for (const tabId of list(request.close)) {
    if (!Number.isInteger(tabId) || !offered.has(tabId) || closing.has(tabId)) continue;
    closing.add(tabId);
    close.push(tabId);
  }

  const existingGroups = new Map(
    previewGroups.filter((group) => group.kind === "existing" && Number.isInteger(group.groupId)).map((group) => [group.groupId, group]),
  );
  // A new group may follow an existing tidy group the preview knows: one it adds to, or one the plan placed after.
  const anchors = new Set([...existingGroups.keys(), ...previewGroups.map((group) => group.placeAfterGroupId).filter(Number.isInteger)]);

  const assigned = new Set();
  const joined = new Set();
  const keys = new Set();
  const groups = [];
  request.groups.forEach((raw, index) => {
    if (!isObject(raw) || (raw.kind !== "new" && raw.kind !== "existing")) return;
    const previous = raw.kind === "existing" ? existingGroups.get(raw.groupId) : undefined;
    if (raw.kind === "existing" && (!previous || joined.has(raw.groupId))) return;
    if (previous) joined.add(raw.groupId);

    // First assignment wins, as in plan.js; a tab to close joins no group.
    const tabIds = [];
    for (const tabId of list(raw.tabIds)) {
      if (!Number.isInteger(tabId) || !knownTabs.has(tabId) || assigned.has(tabId) || closing.has(tabId)) continue;
      assigned.add(tabId);
      tabIds.push(tabId);
    }
    // An untouched existing name is kept verbatim: Zen allows names longer than 32 characters, and an icon-only
    // group has an empty one.
    const maxLength = previous ? Math.max(MAX_NAME_LENGTH, [...String(previous.name ?? "")].length) : MAX_NAME_LENGTH;
    const name = previous && raw.name === previous.name ? previous.name : cleanVisibleName(raw.name, maxLength) || FALLBACK_NAME;
    const icon = matchIcon(raw.icon);

    if (!previous) {
      if (tabIds.length < MIN_NEW_GROUP_TABS) return;
      const key = requestKey(raw.key, index, keys);
      keys.add(key);
      const placeAfterGroupId = Number.isInteger(raw.placeAfterGroupId) && anchors.has(raw.placeAfterGroupId) ? raw.placeAfterGroupId : null;
      groups.push({ key, kind: "new", groupId: null, name, icon, placeAfterGroupId, tabIds });
      return;
    }
    const nameChanged = name !== previous.name;
    const rename = nameChanged || icon !== previous.icon;
    if (!tabIds.length && !rename) return;
    const key = requestKey(raw.key, index, keys);
    keys.add(key);
    groups.push({ key, kind: "existing", groupId: raw.groupId, name, icon, placeAfterGroupId: null, tabIds, rename, nameChanged });
  });

  const checks = close.map((tabId) => closeCheck(tabId, offered.get(tabId))).filter((check) => check !== null);
  const activeTabId = preview.extras?.activeTabId;
  const closeChecks = {
    salt: closeSalt(preview.id), tabs: checks, ...(close.length && Number.isInteger(activeTabId) ? { activeTabId } : {}),
  };
  return { ok: true, request: { previewId: preview.id, groups, close, closeChecks } };
}

const isShortString = (value, max = MAX_EDIT_STRING) => typeof value === "string" && value.length <= max;
const orNull = (value) => (value === undefined ? null : value);

// validateEdits(edits, preview) returns { ok: true, edits } or { ok: false, error } for the popup's saved editor
// state (saveEdits), so reopening the popup restores exactly what the person saw:
//   Edits = { previewId, groups: [{ key, kind, groupId, name, icon, placeAfterGroupId, tabs: [{ tabId, checked }] }],
//             leftovers: [tabId], close: [tabId] }   (popup-state.js)
// The check is structural only (names are cleaned on Apply, by validateApplyRequest): each group is one of the
// preview's, at most once, with the preview's kind and ids; each tab id is one the preview showed, at most once
// across groups and leftovers; strings are capped; arrays are bounded by the preview, so junk is refused before any
// scan. `close` (M4, may be missing: none) holds Extras ticked to close: ids preview.extras offered, each at most
// once; such a tab may also sit in a group or the leftovers, where the popup marks it "Will close". The result is a
// fresh copy holding only these fields, `close` always included.
export function validateEdits(edits, preview) {
  if (!isObject(preview)) return fail("no-preview");
  if (!isObject(edits)) return fail("not-an-object");
  if (edits.previewId !== preview.id) return fail("preview-mismatch");
  if (!Array.isArray(edits.groups) || !Array.isArray(edits.leftovers)) return fail("not-arrays");
  if (edits.close !== undefined && !Array.isArray(edits.close)) return fail("not-arrays");

  const previewGroups = new Map(list(preview.groups).filter(isObject).map((group) => [group.key, group]));
  const knownTabs = new Set();
  for (const ref of [...[...previewGroups.values()].flatMap((group) => list(group.tabs)), ...list(preview.leftovers)]) {
    if (isObject(ref) && Number.isInteger(ref.tabId)) knownTabs.add(ref.tabId);
  }
  const offered = offeredExtras(preview);
  if (edits.groups.length > previewGroups.size || edits.leftovers.length > knownTabs.size) return fail("too-large");
  if (list(edits.close).length > offered.size) return fail("too-large");

  const seenKeys = new Set();
  const seenTabs = new Set();
  const takeTab = (tabId) => {
    if (!Number.isInteger(tabId) || !knownTabs.has(tabId) || seenTabs.has(tabId)) return false;
    seenTabs.add(tabId);
    return true;
  };
  const groups = [];
  for (const raw of edits.groups) {
    if (!isObject(raw) || !isShortString(raw.key) || !previewGroups.has(raw.key) || seenKeys.has(raw.key)) return fail("bad-group");
    const source = previewGroups.get(raw.key);
    seenKeys.add(raw.key);
    if (raw.kind !== source.kind) return fail("bad-kind");
    if (orNull(raw.groupId) !== orNull(source.groupId) || orNull(raw.placeAfterGroupId) !== orNull(source.placeAfterGroupId)) {
      return fail("bad-group-id");
    }
    // An existing group's own name may be longer than any cap; the popup shows it in full.
    const nameCap = Math.max(MAX_EDIT_STRING, typeof source.name === "string" ? source.name.length : 0);
    if (!isShortString(raw.name, nameCap) || !isShortString(raw.icon)) return fail("bad-text");
    if (!Array.isArray(raw.tabs) || raw.tabs.length > knownTabs.size) return fail("bad-tabs");
    const tabs = [];
    for (const tab of raw.tabs) {
      if (!isObject(tab) || typeof tab.checked !== "boolean" || !takeTab(tab.tabId)) return fail("bad-tab");
      tabs.push({ tabId: tab.tabId, checked: tab.checked });
    }
    groups.push({
      key: source.key, kind: source.kind, groupId: orNull(source.groupId), name: raw.name, icon: raw.icon,
      placeAfterGroupId: orNull(source.placeAfterGroupId), tabs,
    });
  }
  const leftovers = [];
  for (const tabId of edits.leftovers) {
    if (!takeTab(tabId)) return fail("bad-tab");
    leftovers.push(tabId);
  }
  const close = [];
  for (const tabId of list(edits.close)) {
    if (!Number.isInteger(tabId) || !offered.has(tabId) || close.includes(tabId)) return fail("bad-close");
    close.push(tabId);
  }
  return { ok: true, edits: { previewId: preview.id, groups, leftovers, close } };
}
