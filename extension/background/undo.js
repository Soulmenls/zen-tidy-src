// Undo the last tidy: match the journal's tabs to the tabs open now, classify them, plan (planUndo, pure) and put
// everything back (undoTidy). Rules: notes/m3-contracts.md (binding); implementation-notes ("Undo", "Applying a plan
// (move algorithm)" and the Zen facts on Space scope, split views, tab keys, crash rollback and tabs.move); the
// journal block at the top of apply.js, whose v1, v2 and v3 journals are all read here.
// The browser comes in as `api` and storage as `store`. Anything can change between the popup's plan and the click
// (tabs closed, moved, regrouped, the Space switched), so undoTidy plans again from a fresh snapshot, and every batch
// re-reads tabs.query right before it acts: only tabs that query returned, unpinned and outside splits and the
// person's own groups, ever reach a tab API.
//
// How tabs go back (undoTidy step 3). Tab ids don't survive a restart, so a journal tab is found again by its key
// (sessions value) and its address's fingerprint (v3 `urlHash`; v1 and v2 kept the plain URL, fingerprinted on read:
// "Matching"). Tabs are lifted out of their groups first, then put back in reverse original order, each
// run of them right before its anchor: the next strip entry that is still there, and still in its old order. tabs.move
// has no "stay ungrouped" flag, so after every move a tab that joined a group is ungrouped again, and the run is
// checked against where it should be. Zen 1.23.4b, as measured by the M3 integration run: a moved tab joins only the
// group of the tab that was at the target index (it ends up after the tab on a backward move, before it on a forward
// one), named or untitled, never a split; and tabs.ungroup takes tabs at a group's front out before the group, any
// others out after its last tab, in strip order. So a run that joins a group at its front comes out right before it,
// and one that joins it at its end right after it: in place either way. That holds for an untitled group that is not
// a split too (the person's own unnamed group, or one an interrupted apply left behind), although undo can't tell it
// from a split: every run tab was loose right before its move, so a group it is in afterwards is one the move put it
// in, never a split, and an ungroup on a real split tab does nothing anyway (M0). Two fallbacks keep the order exact if
// a browser behaves otherwise (the fake browser's EDGES_MODEL, which joins either neighbour and ungroups to the end):
// - a run that belongs right before a group but joined it and came out at its end: the group hops back over the run
//   with tabGroups.move, only for Zen Tidy's own groups (created, joined or titled with SIG). For the person's own
//   group the run is moved back past the tab before the group and then forward again; if that joins too, the run
//   stays right after that group and an "order" failure says so.
// - a batch that did not land as computed (another reading of tabs.move's batch semantics): one tab at a time.
// tabs.move batches follow Firefox's ext-tabs loop (verified in Zen): moved back, the batch's first tab lands at
// `index`; moved forward, its last tab does. So a run goes right before anchor A with index = A.index, or A.index - 1
// when its first tab starts before A. A run longer than MOVE_BATCH moves in chunks with a yield between them, and so
// does a long ungroup: Zen's main thread is held for the whole call.
//
// Tabs the person moved since the tidy. A strip entry still there is a fixed point only while it keeps its old place
// among the others: the person may have dragged a leftover, their own group or a split elsewhere since. So once the
// lift is done, the entries that can anchor are taken as units (a loose tab, or a whole split or group at its first
// tab) and only the run of units whose current indices still rise in strip order and that holds the most tabs anchors;
// the others are passed over like closed tabs, and a run whose way to its anchor passed one gets an "order" note.
// Counting tabs keeps a group in place when a single tab was dragged past it. When two runs hold as many tabs (a
// block moved, or two loose tabs swapped), the earlier one in the strip anchors; either gives a consistent order.
//
// The open tab. The active tab and the Glance suspects never anchor a move or a reopen (implementation-notes, Glance:
// user-approved), yet the popup is usually opened from a loose active tab, so it often is a run's real next
// neighbour. Such a tab still splits runs (while it sits between the anchors around it), and a run whose next
// neighbour it is goes right after the strip entry before it instead (prevAnchor: a loose tab, or the end of a split
// or group), which is exact; a run already right before it stays put. When there is no such entry (the run opens the
// loose area, or a tab the person moved sits there) the run lands after the open tab and the report says so
// ("order"). That is not rare: the popup is often opened from the first loose tab, right where a tidied tab came from.
//
// Trying again. Right before its first change, undo marks the journal with `undoStartedAt` (its state stays "done" or
// "applying", as apply writes "applying" before its first change), and the final write marks it "undone". An undo
// that failed or died partway can therefore be run again: with the mark set, a journal tab that is loose counts as
// "as left" (the first attempt lifted it out, or already put it back), as for an interrupted apply. So undo that went
// through every step but left tabs where the lift left them (a lift or a move the browser refused), that left closed
// tabs unopened (a create Zen refused or didn't answer, a closed tabs' group it couldn't make again or name), or that
// lost sight of the tidied Space after its first change, rejects instead of writing "undone": the journal keeps its
// mark (plus what a retry must know: a refused create's count, a group made again), and Try again finishes the job.
// The mark would also take a tab the person moved loose since for one the first attempt lifted out, so the final
// write is tried twice (the second time without its report copy), and then the journal is removed if the store can;
// if all of that fails, the report's "journal" failure is the only trace and that risk stays (the router could stop
// offering undo then). A joined group's title already back is neither restored again nor reported as kept, and
// reopened tabs get their old key back, so a retry doesn't reopen them twice. The "undone" journal keeps only its
// times and the name-free report: the tabs' keys and fingerprints (a v1 or v2 journal's URLs), the salt, closed tabs'
// URLs, the old titles and the strip are spent.
//
// Reopening closed tabs (step 6; apply fills `closed` with the Extras it closed, M4). The M3 spike
// (notes/m3-contracts.md, "Reopen: the M3 spike result") settled it: a tab created live has its Space as soon as
// tabs.create resolves (Zen sets it inside addTab), so it is discarded right away, with a 5 s guard on the create and
// no wait on onUpdated. Discarded before it loaded, it reads about:blank, so it gets the tab value zt-reopen = { url,
// title, at } for takeSnapshot, plus its old zt-key. tabs.query follows the active Space, so every create is
// bracketed by a tab known to be in the tidied Space: if that tab is gone from tabs.query right after the create, the
// Space changed, the new tab is closed, and the rest are reported as not reopened. A create that outlives its guard
// stops the batch; its tab, if it ever opens, gets its old key, is unloaded and labelled (labelLate). A tab gets its
// old key the moment its create resolves, so Try again never opens it twice. A closed entry whose key is on a visible
// tab is skipped: that tab was never closed (an apply Zen stopped between two batches journals every tab it meant to
// close) or is back already. A tab that was in a tidy group (`groupId`) goes back into it while that group is still a
// tidy group here (notes/m4-contracts.md): created in its place inside the group, or added with tabs.group and put in
// its place, then the group is collapsed again if it was; that happens before the next create, which may anchor on
// it. A closed run at a group's front anchors on the group's first open tab past the run. The closed tabs of a joined
// group the lift would empty (the apply added tabs to it and closed all its own) are reopened into it before the
// lift, so the group never goes away. A tidy group whose every tab the apply closed went away with them, so the
// journal names it (`closedGroups`: its full title and collapsed state) and its reopened tabs are grouped again
// (remakeClosedGroups), its new id recorded before it is named.
//
// v1 journals have no strip, so only the journal's own tabs can anchor, and a run with leftovers between it and the
// next journal tab goes to its original index (counted among the tabs that stay where they are), never past that next
// tab. With nothing else changed since the tidy that is exact, and journal tabs closed since are allowed for; other
// tabs closed or opened since, or journal tabs the person moved, make the leftovers interleave approximately.
//
// Matching. A v3 journal keeps no address, only urlHash = fnv1a32(urlSalt + url) under its own salt (apply.js header,
// shared/hash.js), so undo fingerprints each current tab's URL with that salt and compares fingerprints; a v1 or v2
// journal's plain URL is fingerprinted with the empty salt on read, and the current tabs with it too. takeSnapshot
// has already put a reopened tab's zt-reopen URL in place of its about:blank, so that is the URL fingerprinted.
// Addresses are compared only as fingerprints, and never logged or reported.
//
// Groups removed. The report counts the apply's new groups as gone (groupsRemoved) or still there (groupsKept) once
// undo is done. A group goes when the lift takes its last tab, but Zen first animates it out (100 ms, unless the system
// asks for reduced motion: ZenVerticalTabsManager.animateItemClose, after tabgroup.mjs fires TabGroupRemoved), and
// tabGroups.query lists it until then. So a group of the apply's still listed with none of this window's tabs in it is
// read again every GROUP_CLOSE_POLL_MS until it is gone, for up to GROUP_CLOSE_SETTLE_MS (groupsLeft); only one still
// there after that counts as kept. One that holds a tab (the person added it since) counts as kept at once.
//
// Privacy: failure messages never name a tab or group. The report's messages carry the browser's error text for the
// popup; the journal (storage.local) keeps only the fixed text, since an error string can carry what was passed in.

import { takeSnapshot, glanceSuspects, FOLDER_COLOR, TAB_KEY, REOPEN_KEY } from "./snapshot.js";
import { isTidyTitle, makeTitle } from "./markers.js";
import { FALLBACK_NAME } from "./plan.js";
import { fnv1a32, urlHash } from "../shared/hash.js";

const NO_GROUP = -1;
// The router tells "nothing changed" from "failed midway" by this code (as applyRequest's APPLY_NOT_STARTED).
export const UNDO_NOT_STARTED = "undo-not-started";
// Closed tabs reopen live at most this many at a time, each discarded again right after its create resolves.
export const REOPEN_CONCURRENCY = 3;
// The most tabs one tabs.move takes; a longer run moves in chunks with a yield between them. Zen's main thread is
// busy for the whole call, about 0.75 ms per moved tab with 200 tabs open and 1.25 ms with 340 (zen_flow check 17
// and the M3 integration probe: 200 tabs in one call froze it for 148-265 ms; 25 at a time, 22 ms with 200 open).
export const MOVE_BATCH = 25;
// The guard on each tabs.create of a closed tab; the M3 spike measured 4-133 ms.
export const REOPEN_CREATE_TIMEOUT_MS = 5000;
// How many times one closed tab's tabs.create may be refused. A refused create leaves the journal for Try again
// (header, "Trying again"), and the journal keeps the count on the closed entry (`reopenFailures`), so a page Zen
// refuses every time is tried once more and then given up and reported, rather than leaving Try again forever.
export const REOPEN_ATTEMPTS = 2;
// How long a group of the apply's that undo emptied may still be listed before it counts as kept, and how often it is
// read meanwhile (header, "Groups removed"): Zen's close animation takes 100 ms.
export const GROUP_CLOSE_SETTLE_MS = 500;
export const GROUP_CLOSE_POLL_MS = 50;
const failuresOf = (entry) => (Number.isInteger(entry?.reopenFailures) && entry.reopenFailures > 0 ? entry.reopenFailures : 0);
// True for a closed entry whose create was refused REOPEN_ATTEMPTS times: undo no longer tries it (close all's undo
// goes through the same path).
export function reopenGivenUp(entry) {
  return failuresOf(entry) >= REOPEN_ATTEMPTS;
}
// sessions value on a reopened tab: { url, title, at }. takeSnapshot reads it for a discarded tab that reads
// about:blank, so it is defined there, next to TAB_KEY.
export { REOPEN_KEY };

// Thrown when undo stops before its first change: the browser and the journal are untouched, so the caller may
// offer the same undo again. `status` is the re-check's "wrong-space" or "nothing" when that was the reason.
export class UndoNotStartedError extends Error {
  constructor(cause, status = null) {
    super(`Undo stopped before changing anything: ${cause?.message ?? cause}`, { cause });
    this.name = "UndoNotStartedError";
    this.code = UNDO_NOT_STARTED;
    this.status = status;
  }
}

// Thrown after changes began when undo can't finish here: it went through every step but left tabs where the lift
// left them (a lift or a move the browser refused), or it lost sight of the tidied Space. The journal keeps its mark
// and its state ("done" or "applying"), not "undone", so the same undo can be tried again (header, "Trying again").
// `report` is what this attempt did, as far as it got.
export const UNDO_INCOMPLETE = "undo-incomplete";
export class UndoIncompleteError extends Error {
  constructor(reason, report) {
    super(`Undo stopped before putting every tab back: ${reason}`);
    this.name = "UndoIncompleteError";
    this.code = UNDO_INCOMPLETE;
    this.report = report;
  }
}

// A failure's structured fields, which the popup builds its lines from (never from `message`): { scope, code?,
// count? }. code, for "order" only: "near" (put next to its place), "in-group" (the browser kept it in a group next
// to its place), "unmoved" (the move threw), "open-tab" and "moved-anchor" (the two notes). count: how many tabs, a
// positive integer, left out when it doesn't apply (the notes, "title", "collapse", "journal").
function structuredFailure(spec) {
  if (typeof spec === "string") return { scope: spec };
  const fields = { scope: spec.scope };
  if (typeof spec.code === "string") fields.code = spec.code;
  if (Number.isInteger(spec.count) && spec.count > 0) fields.count = spec.count;
  return fields;
}

const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));
const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Reopen readiness: tabs.create's resolution is the signal (M3 spike), so the default waits for nothing. waitReady
// stays a seam (tests hold tabs in flight with it); onUpdated "complete" takes seconds to forever, so never that.
const readyOnCreate = async () => {};
const errorText = (error) => error?.message ?? String(error);
const list = (value) => (Array.isArray(value) ? value : []);
const isWebUrl = (url) => typeof url === "string" && /^https?:\/\//i.test(url);
const STRIP_KINDS = new Set(["loose", "split", "grouped"]);

// ---------------------------------------------------------------------------------------------------------------
// Reading the journal, matching and classifying (pure)

// The journal as undo needs it, whatever its version and however damaged: arrays always arrays, tabs in their
// original strip order, groups once each. `undoable` is false once undo has run (or for a state it doesn't know).
function journalView(journal) {
  const source = journal !== null && typeof journal === "object" ? journal : {};
  const version = Number.isInteger(source.version) ? source.version : 1;
  const v2 = version >= 2;
  // Each tab's fingerprint (header, "Matching"): v3's urlHash as written, or a v1/v2 plain URL fingerprinted with the
  // journal's salt, which is "" for those versions.
  const urlSalt = typeof source.urlSalt === "string" ? source.urlSalt : "";
  const fingerprint = (t) => (typeof t.urlHash === "string" ? t.urlHash : urlHash(urlSalt, t.url));
  const tabs = list(source.tabs)
    .filter((t) => typeof t?.key === "string" && t.key !== "" && Number.isFinite(t.index))
    .map((t) => ({ key: t.key, index: t.index, to: t.to, urlHash: fingerprint(t) }))
    .sort((a, b) => a.index - b.index);
  const seenJoins = new Set();
  const joins = list(source.joins).filter((j) => {
    if (!Number.isInteger(j?.groupId) || seenJoins.has(j.groupId)) return false;
    seenJoins.add(j.groupId);
    return true;
  });
  const created = [...new Set(list(source.createdGroupIds).filter(Number.isInteger))];
  const strip = v2 && Array.isArray(source.strip)
    ? source.strip
      .filter((e) => typeof e?.key === "string" && e.key !== "")
      .map((e) => ({ key: e.key, kind: STRIP_KINDS.has(e.kind) ? e.kind : "loose" }))
    : null;
  // Only web URLs can come back, and M4's closed entries are http(s) by contract; anything else is ignored.
  const closed = list(source.closed)
    .filter((c) => typeof c?.key === "string" && c.key !== "" && isWebUrl(c.url))
    .sort((a, b) => (Number.isFinite(a.index) ? a.index : Infinity) - (Number.isFinite(b.index) ? b.index : Infinity));
  // The tidy groups the apply's closes emptied (apply.js closedGroups), once each, always with a Zen Tidy title: an
  // untitled group would look like a split view.
  const seenClosedGroups = new Set();
  const closedGroups = list(source.closedGroups)
    .filter((g) => {
      if (!Number.isInteger(g?.groupId) || g.groupId === NO_GROUP || seenClosedGroups.has(g.groupId)) return false;
      seenClosedGroups.add(g.groupId);
      return true;
    })
    .map((g) => ({
      groupId: g.groupId, title: isTidyTitle(g.title) ? g.title : makeTitle(FALLBACK_NAME), collapsed: g.collapsed === true,
      recreated: g.recreated === true,
    }));
  const live = source.undoneAt === null || source.undoneAt === undefined;
  return {
    v2,
    applying: source.state === "applying",
    undoStarted: Number.isFinite(source.undoStartedAt),
    undoable: live && (source.state === "done" || source.state === "applying"),
    tabs, joins, created, strip, closed, closedGroups, urlSalt,
    multiWindow: source.multiWindow === true,
  };
}

// Each journal tab to at most one current tab, by key (the fresh snapshot already re-keyed duplicates). A strong
// match also has the address's fingerprint (the current URL under the journal's salt); a weak one only the key (the
// tab navigated since). Strong matches are claimed first, and among tabs holding the same key the one with the
// fingerprint wins (the older one if several do); a weak match is taken only when exactly one tab holds the key, so
// it never chooses between duplicates.
function matchTabs(entries, tabs, urlSalt) {
  const byKey = new Map();
  for (const tab of tabs) {
    if (typeof tab.key !== "string" || tab.key === "") continue;
    if (!byKey.has(tab.key)) byKey.set(tab.key, []);
    byKey.get(tab.key).push(tab);
  }
  const claimed = new Set();
  const matches = entries.map(() => null);
  entries.forEach((entry, i) => {
    const strong = (byKey.get(entry.key) ?? [])
      .filter((t) => urlHash(urlSalt, t.url) === entry.urlHash && !claimed.has(t.id));
    if (!strong.length) return;
    const tab = strong.reduce((a, b) => (b.id < a.id ? b : a));
    claimed.add(tab.id);
    matches[i] = { tab, strong: true };
  });
  entries.forEach((entry, i) => {
    const holders = byKey.get(entry.key) ?? [];
    if (matches[i] || holders.length !== 1 || claimed.has(holders[0].id)) return;
    claimed.add(holders[0].id);
    matches[i] = { tab: holders[0], strong: false };
  });
  return matches;
}

// "As left": where the apply put the tab. v2: in its group `to`. v1: in any group the apply created or joined. An
// interrupted apply ("applying") may have stopped before reaching it, and an undo that stopped partway may have
// lifted it out already (undoStartedAt), so then a tab that is loose counts too.
function asLeft(view, entry, tab, ours) {
  const to = view.v2 && Number.isInteger(entry.to) ? entry.to : null;
  if ((view.applying || view.undoStarted) && tab.groupId === NO_GROUP) return true;
  return to !== null ? tab.groupId === to : ours.has(tab.groupId);
}

function emptyPlan(status, missing, multiWindow) {
  return {
    status, restore: [], moved: [], missing, dissolve: [], keepGroups: [], titles: [], keptTitles: [], collapse: [],
    reopen: [], multiWindow,
  };
}

// FNV-1a of the title as it is now against the hash of the title apply set (shared/hash.js).
function sameTitleHash(title, hash) {
  return typeof hash === "string" && fnv1a32(title) === hash.toLowerCase();
}

// The plan plus what undoTidy needs to anchor tabs: `roles` maps each journal key to { role, tabId }, role
// "restore" | "moved" | "missing".
function analyze(journal, snapshot, allGroups) {
  const view = journalView(journal);
  const tabs = list(snapshot?.tabs);
  const multiWindow = view.multiWindow || snapshot?.windowCount > 1;
  const roles = new Map();
  if (!view.undoable) return { view, roles, plan: emptyPlan("nothing", view.tabs.length, multiWindow) };

  const groupsHere = new Map(list(snapshot?.groups).map((g) => [g.id, g]));
  const everywhere = new Set(list(allGroups).map((g) => g?.id));
  const created = new Set(view.created);
  const ours = new Set([...created, ...view.joins.map((j) => j.groupId)]);
  // An untitled group the apply created looks exactly like a split view (M0), but the journal knows it is its own.
  const splitTabIds = new Set(list(snapshot?.splitTabIds));
  const inSplit = (tab) => splitTabIds.has(tab.id) && !created.has(tab.groupId);

  const restore = [];
  const moved = [];
  let movedUnpinned = 0;
  let groupedRestore = 0;
  let missing = 0;
  matchTabs(view.tabs, tabs, view.urlSalt).forEach((match, i) => {
    const entry = view.tabs[i];
    if (!match) {
      missing++;
      roles.set(entry.key, { role: "missing", tabId: null });
      return;
    }
    const { tab } = match;
    if (!tab.pinned && !inSplit(tab) && asLeft(view, entry, tab, ours)) {
      restore.push({ tabId: tab.id, key: entry.key, origIndex: entry.index });
      if (tab.groupId !== NO_GROUP) groupedRestore++;
      roles.set(entry.key, { role: "restore", tabId: tab.id });
    } else {
      moved.push({ tabId: tab.id, title: typeof tab.title === "string" ? tab.title : "" });
      if (!tab.pinned) movedUnpinned++;
      roles.set(entry.key, { role: "moved", tabId: tab.id });
    }
  });

  // The Space check. tabs.query covers only the active Space (plus the Essentials, which are pinned and show in
  // every Space, so a pinned tab proves nothing), so an unpinned journal tab, a group of the apply's or a closed
  // tab's unpinned neighbour seen here proves this is the Space that was tidied. Otherwise tabGroups.query({}) (every
  // Space) tells "in another Space" from "gone"; invisible tabs are never treated as closed. A journal tab the person
  // may have carried here proves nothing while a group of the apply's lives in another Space and none here: one
  // listed as moved (dragged into a group of another Space, which takes it there), or one that only counts as left
  // because it is loose (an interrupted apply, or an undo that stopped partway). The tidy groups closed tabs were in
  // (M4 `closed[].groupId`) count too: one seen here proves the Space, and one that lives only in another Space makes
  // the answer "wrong-space", so an apply that only closed tabs can tell it from "gone" whenever a closed tab was in a
  // tidy group (closed loose tabs leave only their neighbours' keys, which tabs.query can't see in another Space).
  const keysOf = (some) => new Set(some.map((t) => t.key).filter((key) => typeof key === "string" && key !== ""));
  const keysHere = keysOf(tabs);
  const unpinnedKeys = keysOf(tabs.filter((t) => !t.pinned));
  const oursHere = [...ours].some((id) => groupsHere.has(id));
  const carried = !oursHere && [...ours].some((id) => everywhere.has(id));
  const closedGroupIds = [...new Set(view.closed.map((c) => c.groupId))].filter((id) => Number.isInteger(id) && id !== NO_GROUP);
  const evidence = groupedRestore > 0 || oursHere || (!carried && (restore.length > 0 || movedUnpinned > 0)) ||
    view.closed.some((c) => unpinnedKeys.has(c.before) || unpinnedKeys.has(c.after)) ||
    closedGroupIds.some((id) => groupsHere.has(id));
  if (!evidence) {
    const status = [...ours, ...closedGroupIds].some((id) => everywhere.has(id)) ? "wrong-space" : "nothing";
    return { view, roles, plan: emptyPlan(status, missing, multiWindow) };
  }

  // Created groups: dissolved where restore tabs leave them, kept where other tabs stay (added by the person, or
  // `moved`), or where they now live in another Space.
  const restoreIds = new Set(restore.map((r) => r.tabId));
  const dissolve = [];
  const keepGroups = [];
  for (const id of created) {
    const members = tabs.filter((t) => t.groupId === id);
    if (!members.length) {
      if (everywhere.has(id)) keepGroups.push(id);
      continue;
    }
    if (members.some((t) => restoreIds.has(t.id))) dissolve.push(id);
    if (members.some((t) => !restoreIds.has(t.id))) keepGroups.push(id);
  }

  // Joined groups seen here: their old title only if nobody renamed them since (v1 kept no hash: left as they are),
  // and their collapsed state while they are still tidy groups.
  const tidyHere = new Set(list(snapshot?.tidyGroups).map((g) => g.id));
  const titles = [];
  const keptTitles = [];
  const collapse = [];
  for (const join of view.joins) {
    const group = groupsHere.get(join.groupId);
    if (!group) continue;
    // A title that is the old one already (an earlier attempt put it back) needs nothing.
    if (typeof join.title === "string" && typeof join.titleHash === "string" && group.title !== join.title) {
      if (sameTitleHash(group.title, join.titleHash)) titles.push({ groupId: join.groupId, title: join.title });
      else keptTitles.push(join.groupId);
    }
    if (tidyHere.has(join.groupId)) collapse.push({ groupId: join.groupId, collapsed: join.collapsed === true });
  }

  // A closed tab whose key is open again (Ctrl+Shift+T copies sessions values, and undo gives a reopened tab its old
  // key) is back already; one whose create Zen refused REOPEN_ATTEMPTS times is no longer tried.
  const reopen = view.closed.filter((c) => !keysHere.has(c.key) && !reopenGivenUp(c)).map((c) => structuredClone(c));

  return {
    view,
    roles,
    plan: { status: "ready", restore, moved, missing, dissolve, keepGroups, titles, keptTitles, collapse, reopen, multiWindow },
  };
}

// planUndo(journal, snapshot, allGroups) is pure. snapshot: takeSnapshot's, for the window to undo in; allGroups:
// tabGroups.query({}) (every Space and window). Returns notes/m3-contracts.md's plan; for "wrong-space" and
// "nothing" every list is empty, `missing` counts the journal tabs no current tab matched, and multiWindow is set.
// An undone or unreadable journal is "nothing".
export function planUndo(journal, snapshot, allGroups) {
  return analyze(journal, snapshot, allGroups).plan;
}

// ---------------------------------------------------------------------------------------------------------------
// Executing (undoTidy)

// undoTidy(api, plan, { windowId, store, journal, yieldFn, onOwnGroupChange, now, snapshot, waitReady,
// createTimeoutMs, delay }) resolves to notes/m3-contracts.md's UndoReport:
//   { restored, moved: [{ title }], missing, groupsRemoved, groupsKept, titlesRestored, titlesKept, reopened,
//     failures: [{ message, scope, code?, count? }] }
// - plan: the plan the popup offered. Only its status is read: undo plans again from a fresh snapshot right before
//   it acts, so a stale plan is never executed.
// - restored: tabs out of their tidy groups and back in the loose strip. moved: tabs left alone, by current title,
//   including any the person moved while undo ran. groupsRemoved / groupsKept: the apply's new groups gone / still
//   there afterwards. titlesKept: joined groups renamed since, whose old title stayed off. reopened: closed tabs
//   back in this Space.
// - failures' scope: "lift" (ungrouping), "order" (a run not put back exactly, or the notes on the open tab and on
//   tabs the person moved), "title", "collapse", "reopen" or "journal". Messages never name a tab or group (header,
//   "Privacy"). code and count (structuredFailure) are what the popup builds its lines from: "order" failures carry
//   a code, and those about a number of tabs ("lift", "order" other than the notes, and "reopen" for tabs not
//   reopened or not showing up) carry a count. The journal's copy keeps both.
// - store: { writeJournal, removeJournal? }. The journal (`journal`, as read) is written with `undoStartedAt` right
//   before the first change (header, "Trying again"), and last as spent: { version, state: "undone", startedAt,
//   finishedAt, undoStartedAt, undoneAt, undoReport }, where undoReport is a name-free copy of the report (`moved` a
//   count, failures with their fixed text only). That write is tried again without undoReport, then the journal is
//   removed (removeJournal, when the store has it), before a "journal" failure is reported.
// - onOwnGroupChange(groupId): the suppression window, awaited before every title or collapsed change and before a
//   move or a create next to a collapsed group. snapshot: (api, { windowId }) => Snapshot, for tests. waitReady(api,
//   tabId): held before a reopened tab is discarded (immediate by default). createTimeoutMs: the create guard.
//   delay(ms): the wait between the reads of a group still going away (header, "Groups removed"; a timer by default).
// Rejects with UndoNotStartedError when it stops before its first change (the re-check found nothing to do here, a
// read failed, the mark could not be written, or the Space changed before anything changed, status "wrong-space");
// the journal is then untouched. Rejects with UndoIncompleteError when, after changes began, it left tabs where the
// lift left them, left closed tabs unopened (a create refused fewer than REOPEN_ATTEMPTS times, or that outlived its
// guard; a closed tabs' group not made again or not named), or lost sight of the tidied Space; anything else thrown
// after the first change may come after changes too. In both cases the journal keeps its state and the mark, so the
// same undo can be tried again.
export async function undoTidy(api, plan, options = {}) {
  const changes = { started: false };
  try {
    return await undoAll(api, plan, options, changes);
  } catch (error) {
    if (changes.started || error instanceof UndoNotStartedError) throw error;
    throw new UndoNotStartedError(error);
  }
}

async function undoAll(api, plan, options, changes) {
  const {
    windowId, store, journal, yieldFn = defaultYield, onOwnGroupChange = () => {}, now = Date.now,
    snapshot: snap = takeSnapshot, waitReady = readyOnCreate, createTimeoutMs = REOPEN_CREATE_TIMEOUT_MS,
    delay = defaultDelay,
  } = options;
  if (plan?.status !== undefined && plan.status !== "ready") {
    throw new UndoNotStartedError(new Error(`the plan's status is "${plan.status}"`), plan.status);
  }

  // 1. Re-check: plan again from what is open now.
  const snapshot = await snap(api, { windowId });
  const allGroups = list(await api.tabGroups.query({}));
  const { view, roles, plan: fresh } = analyze(journal, snapshot, allGroups);
  if (fresh.status !== "ready") {
    throw new UndoNotStartedError(new Error(`nothing to undo here (${fresh.status})`), fresh.status);
  }

  const report = {
    restored: 0,
    moved: fresh.moved.map((m) => ({ title: m.title })),
    missing: fresh.missing,
    groupsRemoved: 0,
    groupsKept: 0,
    titlesRestored: 0,
    titlesKept: fresh.keptTitles.length,
    reopened: 0,
    failures: [],
  };
  // The failures as the journal keeps them: the fixed text only (header, "Privacy").
  const keptFailures = [];
  const created = new Set(view.created);
  const joinedIds = new Set(view.joins.map((j) => j.groupId));
  const placed = new Set();
  // Unpinned tabs live in one Space, and the start snapshot was taken in the tidied one (the Space check).
  const startIds = new Set(snapshot.tabs.filter((t) => !t.pinned).map((t) => t.id));
  let undoStartedAt = journal?.undoStartedAt;
  // The journal as this undo keeps it for Try again: the mark is written from it, and so are what a later attempt
  // must know (a closed tabs' group made again, a refused create's count, a tab another Space took): record().
  const kept = structuredClone(journal);
  const ctx = {
    api,
    windowId,
    report,
    yieldFn,
    onOwnGroupChange,
    now,
    created,
    ours: new Set([...created, ...joinedIds]),
    // Titles, colours and collapsed states as undo found them (copies, kept up to date by steps 4 and 5): which
    // groups are splits, which may hop, which are collapsed (and must be again if a tab joining them expanded them).
    groupInfo: new Map(snapshot.groups.map((g) => [g.id, { ...g }])),
    // The joined groups step 5 gives their journaled collapsed state; until it has run, they are left to it. Any
    // other group a move expanded (a joined group that is the person's now included) is collapsed again at once.
    collapseIds: new Set(fresh.collapse.map((c) => c.groupId)),
    collapseRestored: false,
    placed,
    // Strip entries that kept no place among the others (putBack, "Tabs the person moved since the tidy").
    unordered: new Set(),
    // Set when tabs that should have moved stayed where the lift left them (a lift or a move the browser refused), or
    // closed tabs stayed closed (a create refused or unanswered, the Space changed, a closed tabs' group not made
    // again or not named): the journal is then left for a retry instead of being marked undone.
    unfinished: false,
    // fail(scope, message, error?): the report gets the message plus the browser's error text, the journal only
    // the message. `scope` is a scope string, or { scope, code?, count? } (structuredFailure), whose code and count
    // both copies keep.
    fail: (scope, message, ...error) => {
      const fields = structuredFailure(scope);
      report.failures.push({ message: error.length ? `${message}: ${errorText(error[0])}` : message, ...fields });
      keptFailures.push({ message, ...fields });
    },
    started: () => changes.started,
    // Awaited right before every change; the first call writes the mark. If that write fails nothing has changed.
    begin: async () => {
      if (changes.started) return;
      const at = now();
      try {
        await store.writeJournal({ ...structuredClone(kept), undoStartedAt: at });
      } catch (error) {
        throw new UndoNotStartedError(error);
      }
      undoStartedAt = at;
      changes.started = true;
    },
    // The journal for Try again, with the mark, once changes began. Best effort: if it fails, the mark write stands,
    // and a retry knows less (a closed tabs' group made again is made once more, a refused create is tried again).
    kept,
    record: async () => {
      if (!changes.started) return;
      try {
        await store.writeJournal({ ...structuredClone(kept), undoStartedAt });
      } catch {
        // See above.
      }
    },
    readTabs: async () =>
      list(await api.tabs.query({ windowId })).map((t) => ({
        ...t, groupId: Number.isInteger(t.groupId) ? t.groupId : NO_GROUP, pinned: Boolean(t.pinned),
      })),
    // A read that shows the tidied Space: one of its tabs (from the start snapshot, or put back) is in it.
    inSpace: (tabs) => tabs.some((t) => !t.pinned && (startIds.has(t.id) || placed.has(t.id))),
    // readTabs for the lift and the put-back, which act on what they see. tabs.query follows the active Space, so
    // a read without a tab of the tidied Space means the person switched Space: before the first change that is
    // the re-check's "wrong-space"; after it, undo stops rather than count every tab it can't see as missing, and
    // the journal keeps its mark, so Try again in the tidied Space finishes the job.
    readHere: async () => {
      const tabs = await ctx.readTabs();
      if (ctx.inSpace(tabs)) return tabs;
      if (!changes.started) throw new UndoNotStartedError(new Error("the Space changed"), "wrong-space");
      throw new UndoIncompleteError("the Space changed", report);
    },
  };

  // 6, first part. A joined tidy group that the lift would empty (every tab in it now is one the apply added, its own
  // tabs all closed) would vanish with the last tab lifted out, and its closed tabs would then come back loose. So
  // those closed tabs go back into it first, while it still exists; the lift leaves them there, as they are no
  // journal tabs.
  const reopening = newReopening(fresh.reopen);
  const emptied = emptiedByLift(snapshot, fresh.restore, joinedIds);
  const reopenFirst = fresh.reopen.filter((entry) => emptied.has(entry.groupId));
  if (reopenFirst.length) await reopenClosed(ctx, reopenFirst, snapshot, waitReady, createTimeoutMs, reopening);
  // 2. and 3. Lift the tabs out of their groups, then put them back.
  if (fresh.restore.length) {
    await liftOut(ctx, fresh.restore);
    await putBack(ctx, stripEntries(view, roles, snapshot, reopening.reopened), !view.strip);
  }
  // 4. Titles, only where the hash still matches (re-read just before), and 5. collapsed states.
  await restoreTitles(ctx, fresh.titles, view.joins);
  await restoreCollapsed(ctx, fresh.collapse);
  // 6. Closed tabs (M4 fills `closed`).
  const reopenLast = fresh.reopen.filter((entry) => !emptied.has(entry.groupId));
  if (reopenLast.length) await reopenClosed(ctx, reopenLast, snapshot, waitReady, createTimeoutMs, reopening);
  // A tidy group the closes emptied went away with its last tab: its reopened tabs are grouped again.
  if (view.closedGroups.length) await remakeClosedGroups(ctx, view, snapshot, reopening);
  if (fresh.reopen.length) await countReopened(ctx, reopening, snapshot);

  const before = view.created.filter((id) => allGroups.some((g) => g?.id === id));
  const after = await groupsLeft(ctx, before, delay);
  report.groupsKept = before.filter((id) => after.has(id)).length;
  report.groupsRemoved = before.length - report.groupsKept;

  // Nothing changed, yet a group of the apply's is still there and none is in view: the tidied tabs went to another
  // Space after the re-check (or the Space changed). Spending the journal would leave them for good.
  if (!changes.started && [...ctx.ours].some((id) => after.has(id))) {
    const inView = new Set((await ctx.readTabs()).map((t) => t.groupId));
    if (![...ctx.ours].some((id) => inView.has(id))) {
      throw new UndoNotStartedError(new Error("the tidied groups are in another Space"), "wrong-space");
    }
  }
  if (ctx.unfinished && changes.started) {
    await keepForRetry(ctx, reopening);
    throw new UndoIncompleteError("some tabs were not put back or reopened", report);
  }

  // 7. The journal, last, spent: its tabs' fingerprints (or a v1/v2 journal's URLs), salt, closed tabs' URLs, old
  // titles and strip are of no use any more, so they leave storage.local. A journal left "done" with the mark would let a later undo take tabs the person moved loose since
  // for tabs this one lifted out (header, "Trying again"), so a failed write is tried once more, without the report
  // copy, and then the journal is removed.
  const spent = {
    version: journal?.version,
    state: "undone",
    startedAt: journal?.startedAt ?? null,
    finishedAt: journal?.finishedAt ?? null,
    ...(Number.isFinite(undoStartedAt) ? { undoStartedAt } : {}),
    undoneAt: now(),
  };
  try {
    await store.writeJournal({
      ...spent,
      undoReport: { ...report, moved: report.moved.length, failures: keptFailures.map((f) => ({ ...f })) },
    });
  } catch (error) {
    try {
      await store.writeJournal(spent);
    } catch {
      try {
        if (typeof store.removeJournal !== "function") throw error;
        await store.removeJournal();
      } catch {
        ctx.fail("journal", "Could not mark the tidy as undone", error);
      }
    }
  }
  return report;
}

// The ids of every group listed once undo is done. One of `ids` (the apply's new groups) still listed with none of this
// window's tabs in it may be in Zen's close animation, so the groups are read again every GROUP_CLOSE_POLL_MS until it
// is gone, for up to GROUP_CLOSE_SETTLE_MS (header, "Groups removed").
async function groupsLeft(ctx, ids, delay) {
  const read = async () => new Set(list(await ctx.api.tabGroups.query({})).map((g) => g?.id));
  let after = await read();
  if (!ids.some((id) => after.has(id))) return after;
  const inUse = new Set((await ctx.readTabs()).map((t) => t.groupId));
  const going = ids.filter((id) => after.has(id) && !inUse.has(id));
  for (let waited = 0; waited < GROUP_CLOSE_SETTLE_MS && going.some((id) => after.has(id)); waited += GROUP_CLOSE_POLL_MS) {
    try {
      await delay(GROUP_CLOSE_POLL_MS);
    } catch {
      // A wait that fails only means the next read comes sooner.
    }
    after = await read();
  }
  return after;
}

// The anchor sequence. v2: the strip, every unpinned tab before the change (a journal tab missing from it, which
// apply never writes, goes in before the first journal tab after it). v1: the journal's tabs only. `reopened` (key to
// tab id) holds the closed tabs already back (reopened into a group before the lift), which anchor as they did then.
function stripEntries(view, roles, snapshot, reopened = new Map()) {
  const keyToTabId = new Map([...snapshot.tabs.filter((t) => t.key).map((t) => [t.key, t.id]), ...reopened]);
  const entryFor = (key, kind, origIndex) => {
    const role = roles.get(key);
    return role ? { key, kind, origIndex, ...role } : { key, kind, origIndex, role: "other", tabId: keyToTabId.get(key) ?? null };
  };
  if (!view.strip) return view.tabs.map((t) => entryFor(t.key, "loose", t.index));
  const indexOf = new Map(view.tabs.map((t) => [t.key, t.index]));
  const entries = view.strip.map((e) => entryFor(e.key, e.kind, indexOf.get(e.key) ?? null));
  const inStrip = new Set(view.strip.map((e) => e.key));
  for (const t of view.tabs) {
    if (inStrip.has(t.key)) continue;
    const at = entries.findIndex((e) => e.origIndex !== null && e.origIndex > t.index);
    entries.splice(at < 0 ? entries.length : at, 0, entryFor(t.key, "loose", t.index));
  }
  return entries;
}

// tabs sorted by index, cached per read.
const orderCache = new WeakMap();
function ordered(tabs) {
  if (!orderCache.has(tabs)) orderCache.set(tabs, [...tabs].sort((a, b) => a.index - b.index));
  return orderCache.get(tabs);
}

// Tabs that never anchor a move or a reopen (implementation-notes, Glance): the active tab, the Glance suspects
// (which include any tab whose index is out of order in tabs.query's own array order), and, as apply has it, an
// unpinned tab at or before the last pinned one (the Glance of an Essential). Exported for groups.js, whose undo
// anchors groups by the same rule. `tabs` is one read (tabs.query's array, in its own order) and is treated as
// read-only: the set is cached per array, so a caller that changes the array after asking gets the old answer.
const unsafeCache = new WeakMap();
export function unsafeOf(tabs) {
  if (!unsafeCache.has(tabs)) {
    const lastPinned = Math.max(-1, ...tabs.filter((t) => t.pinned).map((t) => t.index));
    unsafeCache.set(tabs, new Set([
      ...glanceSuspects(tabs),
      ...tabs.filter((t) => t.active || (!t.pinned && t.index <= lastPinned)).map((t) => t.id),
    ]));
  }
  return unsafeCache.get(tabs);
}

// A split view, or a group undo knows nothing about (made since it started, maybe a split): never touched, only
// anchored on from outside. An untitled group of the apply's own is not one.
function isSplitLike(ctx, groupId) {
  if (groupId === NO_GROUP || ctx.ours.has(groupId)) return false;
  const info = ctx.groupInfo.get(groupId);
  return !info || info.title === "";
}

// 2. One tabs.ungroup per group, with only that group's restore tabs, each re-checked against a fresh read first;
// a group with more than MOVE_BATCH of them, MOVE_BATCH at a time from its end, with a yield and a fresh read
// between (ungrouping 100 tabs at once held Zen's main thread for 119 ms with 233 tabs open, 20 at a time 36 ms).
// A created group whose last tab leaves is removed by the browser; one that keeps other tabs stays. A Space switch
// meanwhile only hides the restore tabs from these reads (nothing of another Space is ever passed on); the put-back's
// first read finds out.
async function liftOut(ctx, restore) {
  const { api, readTabs, fail, yieldFn, begin, ours } = ctx;
  const ids = new Set(restore.map((r) => r.tabId));
  let tabs = await readTabs();
  const groups = [...new Set(tabs.filter((t) => ids.has(t.id) && t.groupId !== NO_GROUP).map((t) => t.groupId))];
  const members = (groupId) => ordered(tabs).filter((t) => ids.has(t.id) && t.groupId === groupId).map((t) => t.id);
  for (const [n, groupId] of groups.entries()) {
    if (n > 0) {
      await yieldFn();
      tabs = await readTabs();
    }
    if (!ours.has(groupId)) continue;
    let out = members(groupId);
    // As many rounds as the group needed at the start, so tabs an ungroup left in place are not asked for forever.
    for (let rounds = Math.ceil(out.length / MOVE_BATCH); rounds > 0 && out.length; rounds--) {
      const chunk = out.slice(-MOVE_BATCH);
      await begin();
      try {
        await api.tabs.ungroup(chunk);
      } catch (error) {
        fail({ scope: "lift", count: chunk.length }, `Could not take ${chunk.length} tab(s) out of a group`, error);
        break;
      }
      if (rounds > 1) {
        await yieldFn();
        tabs = await readTabs();
        out = members(groupId);
      }
    }
  }
}

// 3. Reverse original order, a run at a time, with a yield between runs.
async function putBack(ctx, entries, v1) {
  const { readTabs, readHere, report, fail, yieldFn, placed } = ctx;
  let tabs = await readHere();
  let byId = new Map(tabs.map((t) => [t.id, t]));
  // Movable now: lifted, visible, unpinned. The rest changed since the plan (gone, pinned, regrouped by the person:
  // counted and listed) or could not be lifted (reported, left where they are).
  const movable = new Set();
  let stuck = 0;
  for (const entry of entries) {
    if (entry.role !== "restore") continue;
    const tab = byId.get(entry.tabId);
    if (tab && !tab.pinned && tab.groupId === NO_GROUP) movable.add(entry.tabId);
    else if (!tab) report.missing++;
    else if (tab.pinned || !ctx.ours.has(tab.groupId)) report.moved.push({ title: tab.title ?? "" });
    else stuck++;
  }
  // Tabs the lift left in their group (an ungroup that failed, or did nothing) are left for Try again.
  if (stuck) {
    if (!report.failures.some((f) => f.scope === "lift")) fail({ scope: "lift", count: stuck }, `${stuck} tab(s) stayed in their group.`);
    ctx.unfinished = true;
  }
  if (!v1) for (const entry of movedSince(ctx, entries, tabs)) ctx.unordered.add(entry);

  const handled = new Set();
  let nearOpenTab = false;
  let nearMoved = false;
  // Restore tabs of the runs still to come (earlier in the strip): they move later, so they never anchor, and v1
  // doesn't count them where they sit now.
  const waiting = new Set(movable);
  for (const run of formRuns(ctx, entries, movable, tabs, v1).reverse()) {
    for (const i of run) waiting.delete(entries[i].tabId);
    await yieldFn();
    tabs = await readHere();
    byId = new Map(tabs.map((t) => [t.id, t]));
    const memberIds = [];
    for (const i of run) {
      const tab = byId.get(entries[i].tabId);
      if (!tab) report.missing++;
      else if (tab.pinned || tab.groupId !== NO_GROUP) report.moved.push({ title: tab.title ?? "" });
      else memberIds.push(tab.id);
    }
    if (!memberIds.length) continue;
    for (const id of memberIds) handled.add(id);
    const anchor = findAnchor(ctx, entries, run, tabs, new Set(memberIds), waiting, v1);
    // A run already right before the open tab it could not anchor on is exactly in place: nothing moves.
    const settled = anchor.skipped !== undefined && inPlace(tabs, memberIds, { kind: "tab", tabId: anchor.skipped });
    try {
      const result = settled ? { ok: true, tabs } : await placeRun(ctx, memberIds, anchor, tabs);
      if (!result.ok) {
        // A tab still in a group after its move was ungrouped again: the browser kept it there.
        const grouped = new Set(result.tabs.filter((t) => t.groupId !== NO_GROUP).map((t) => t.id));
        const inGroup = memberIds.some((id) => grouped.has(id));
        const where = inGroup ? "inside a group next to it" : "next to it";
        fail({ scope: "order", code: inGroup ? "in-group" : "near", count: memberIds.length },
          `${memberIds.length} tab(s) could not be put back exactly in place; they are ${where}.`);
        continue;
      }
      for (const id of memberIds) placed.add(id);
      // The open tab (or a Glance suspect) was the run's real next neighbour and could not be anchored around.
      if (anchor.skipped !== undefined && !nearOpenTab && endsBefore(result.tabs, anchor.skipped, memberIds[0])) {
        nearOpenTab = true;
        fail({ scope: "order", code: "open-tab" }, "Tabs next to the one you have open may be in a slightly different order.");
      }
      // A tab the person moved since the tidy sat between the run and the entry it went by.
      if (anchor.pastMoved && !nearMoved) {
        nearMoved = true;
        fail({ scope: "order", code: "moved-anchor" },
          "Tabs next to ones you moved since the tidy may be in a slightly different order.");
      }
    } catch (error) {
      if (error instanceof UndoNotStartedError || error instanceof UndoIncompleteError) throw error;
      fail({ scope: "order", code: "unmoved", count: memberIds.length }, `Could not put ${memberIds.length} tab(s) back`, error);
      ctx.unfinished = true;
    }
  }
  const final = await readTabs();
  const finalById = new Map(final.map((t) => [t.id, t]));
  // After a Space switch the tabs put back can't be seen; they were loose at their last read.
  report.restored = ctx.inSpace(final)
    ? [...handled].filter((id) => finalById.get(id)?.groupId === NO_GROUP && !finalById.get(id).pinned).length
    : handled.size;
}

// Tab `id` sits before tab `firstId`.
function endsBefore(tabs, id, firstId) {
  const tab = tabs.find((t) => t.id === id);
  const first = tabs.find((t) => t.id === firstId);
  return Boolean(tab && first) && tab.index < first.index;
}

// Tabs the person moved since the tidy (header). The strip entries that can anchor now, as units: a loose tab, or a
// whole split or group (its entries sit together), at its first tab's index. Only the run of units whose indices still
// rise in strip order and that holds the most of these entries keeps its place; the entries of every other unit are
// returned, and so is an open tab or Glance suspect that no longer sits between the kept units around it. Read once,
// after the lift: undo's own moves later shift indices but never the order of these tabs among themselves.
function movedSince(ctx, entries, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const units = [];
  const unsafe = [];
  for (const entry of entries) {
    if (entry.role !== "other") continue;
    const anchor = anchorFor(ctx, entry, tabs, byId);
    if (anchor) {
      const key = anchor.kind === "tab" ? `tab ${anchor.tabId}` : `group ${anchor.groupId}`;
      if (units.at(-1)?.key === key) units.at(-1).entries.push(entry);
      else units.push({ key, index: targetTab(anchor, tabs).index, entries: [entry] });
      continue;
    }
    const tab = unsafeLoose(null, entry, tabs, byId);
    if (tab) unsafe.push({ entry, index: tab.index, at: units.length });
  }
  const kept = heaviestRising(units.map((u) => u.index), units.map((u) => u.entries.length));
  const keep = new Set(kept);
  const moved = new Set(units.flatMap((u, i) => (keep.has(i) ? [] : u.entries)));
  for (const { entry, index, at } of unsafe) {
    const before = kept.filter((i) => i < at).at(-1);
    const after = kept.find((i) => i >= at);
    if ((before !== undefined && units[before].index > index) || (after !== undefined && units[after].index < index)) {
      moved.add(entry);
    }
  }
  return moved;
}

// The positions (ascending) of the strictly rising subsequence of `values` with the largest sum of `weights`; on a
// tie, the one that ends first, each of its units the earliest that gives that sum. Quadratic: a strip has a few
// hundred units at most.
function heaviestRising(values, weights) {
  const best = [...weights];
  const prev = values.map(() => -1);
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] < values[i] && best[j] + weights[i] > best[i]) {
        best[i] = best[j] + weights[i];
        prev[i] = j;
      }
    }
  }
  let end = -1;
  best.forEach((weight, i) => {
    if (end < 0 || weight > best[end]) end = i;
  });
  const kept = [];
  for (let i = end; i >= 0; i = prev[i]) kept.unshift(i);
  return kept;
}

// Runs: consecutive movable restore entries with nothing between them that is still there to anchor on, or that
// still stands between them (the open tab; v1: no original index between them that no journal tab accounts for,
// since leftovers sat there). Ascending order.
function formRuns(ctx, entries, movable, tabs, v1) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const runs = [];
  let run = null;
  entries.forEach((entry, i) => {
    if (entry.role === "restore" && movable.has(entry.tabId)) {
      const prev = run ? run.at(-1) : null;
      const gap = v1 && prev !== null && entry.origIndex - entries[prev].origIndex - (i - prev) > 0;
      if (run && !gap) {
        run.push(i);
      } else {
        if (run) runs.push(run);
        run = [i];
      }
      return;
    }
    if (run && (anchorFor(ctx, entry, tabs, byId) || unsafeLoose(ctx, entry, tabs, byId))) {
      runs.push(run);
      run = null;
    }
  });
  if (run) runs.push(run);
  return runs;
}

// What an entry anchors a run on now, or null when it can't: { kind: "tab", tabId } (loose, not the active tab or
// a Glance suspect), { kind: "split", groupId } (its outer edge, before its first tab: tabs.move never lands inside
// one), or { kind: "group", groupId } (a grouped entry still in a group that isn't the apply's: before its first
// tab). Restore tabs anchor once they are back; tabs the person moved never do, nor strip entries that lost their
// place among the others (ctx.unordered).
function anchorFor(ctx, entry, tabs, byId) {
  if (entry.role === "restore") {
    const tab = ctx.placed.has(entry.tabId) ? byId.get(entry.tabId) : undefined;
    return tab && !tab.pinned && tab.groupId === NO_GROUP ? { kind: "tab", tabId: tab.id } : null;
  }
  if (entry.role !== "other" || ctx.unordered.has(entry)) return null;
  const tab = entry.tabId === null ? undefined : byId.get(entry.tabId);
  if (!tab || tab.pinned) return null;
  if (tab.groupId === NO_GROUP) return unsafeOf(tabs).has(tab.id) ? null : { kind: "tab", tabId: tab.id };
  if (isSplitLike(ctx, tab.groupId)) return { kind: "split", groupId: tab.groupId };
  if (entry.kind === "grouped" && !ctx.created.has(tab.groupId)) return { kind: "group", groupId: tab.groupId };
  return null;
}

// A strip tab that is still loose where it was but may not anchor (the active tab or a Glance suspect), or null.
// `ctx` null: wherever it is (movedSince's own question).
function unsafeLoose(ctx, entry, tabs, byId) {
  if (entry.role !== "other" || entry.tabId === null || ctx?.unordered.has(entry)) return null;
  const tab = byId.get(entry.tabId);
  return tab && !tab.pinned && tab.groupId === NO_GROUP && unsafeOf(tabs).has(tab.id) ? tab : null;
}

// v2: the first entry after the run that can anchor, else the end of the strip. If the open tab came first, the run
// goes right after the strip tab before it (prevAnchor) instead, and otherwise carries `skipped` (that tab's id) so
// putBack can tell when the order around it came out different. `pastMoved`: the way to the entry it goes by passed
// a strip entry the person moved since the tidy. v1: the run's original index, counted among the tabs open now, but
// never past the next journal tab that is back.
function findAnchor(ctx, entries, run, tabs, memberIds, waiting, v1) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  let next = null;
  let skipped = null;
  let pastMoved = false;
  for (let i = run.at(-1) + 1; i < entries.length && !next; i++) {
    next = anchorFor(ctx, entries[i], tabs, byId);
    if (next) break;
    skipped ??= unsafeLoose(ctx, entries[i], tabs, byId);
    if (!skipped && ctx.unordered.has(entries[i])) pastMoved = true;
  }
  if (!v1) {
    const mark = (anchor) => (pastMoved ? { ...anchor, pastMoved } : anchor);
    if (!skipped) return mark(next ?? { kind: "end" });
    const after = prevAnchor(ctx, entries, run, tabs, byId);
    if (after) return after;
    return mark({ ...(next ?? { kind: "end" }), skipped: skipped.id });
  }
  // The run's first tab belongs at its old index. Journal tabs that are gone no longer take up a place before it,
  // and the restore tabs still waiting that belong before it will be put there later, so they are left out of the
  // count, as they are left out of the tabs counted.
  const first = entries[run[0]].origIndex;
  const gone = entries.filter((e) => e.role === "missing" && e.origIndex < first).length;
  const later = entries.filter((e) => e.role === "restore" && waiting.has(e.tabId) && e.origIndex < first).length;
  const byIndex = indexAnchor(ctx, tabs, memberIds, waiting, first - gone - later);
  if (!byIndex) return next ?? { kind: "end" };
  if (!next) return byIndex;
  if (slotOf(byIndex, tabs) < slotOf(next, tabs)) return byIndex;
  return byIndex.skipped === undefined ? next : { ...next, skipped: byIndex.skipped };
}

// The run's real next neighbour may not anchor, so the run goes right after the strip entry before it: a loose tab
// that may anchor, or the last tab of the split or group it sits in (a move never lands inside a split, and a tab
// that joins the group there is ungrouped to its end, the same place). Journal tabs gone or still to be put back
// are walked over (those land before this run later), as are strip tabs closed or pinned since, or moved since
// (ctx.unordered: the anchor then says `pastMoved`); anything else (a journal tab the person moved, another open
// tab, a group the apply created) gives null.
function prevAnchor(ctx, entries, run, tabs, byId) {
  let pastMoved = false;
  for (let i = run[0] - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role === "missing" || entry.role === "restore") continue;
    if (entry.role !== "other") return null;
    if (ctx.unordered.has(entry)) {
      pastMoved = true;
      continue;
    }
    const tab = entry.tabId === null ? undefined : byId.get(entry.tabId);
    if (!tab || tab.pinned) continue;
    const after = afterAnchor(ctx, tab, tabs);
    return after && pastMoved ? { ...after, pastMoved } : after;
  }
  return null;
}

// "Right after this tab" as an anchor, or null: a loose tab that may anchor, else the last tab of its split or
// group, unless the apply created that group (a tab the person added to it is no fixed point).
function afterAnchor(ctx, tab, tabs) {
  if (tab.groupId === NO_GROUP) return unsafeOf(tabs).has(tab.id) ? null : { kind: "after", tabId: tab.id };
  if (ctx.created.has(tab.groupId)) return null;
  return { kind: "after", tabId: ordered(tabs).filter((t) => t.groupId === tab.groupId).at(-1).id };
}

// v1: the anchor for a run whose first tab belongs at index f among the tabs that stay where they are: the first
// such tab whose index, not counting the run's tabs and the waiting restore tabs before it, reaches f; or the edge
// of the split or group it sits in. If that tab is the open tab, right after the tab before it (afterAnchor) when
// that can be, else on past it, carrying `skipped`. null: the end of the strip.
function indexAnchor(ctx, tabs, memberIds, waiting, f) {
  const unsafe = unsafeOf(tabs);
  let moving = 0;
  let prev = null;
  let skipped = null;
  const mark = (anchor) => (skipped ? { ...anchor, skipped: skipped.id } : anchor);
  for (const tab of ordered(tabs)) {
    if (memberIds.has(tab.id) || waiting.has(tab.id)) {
      moving++;
      continue;
    }
    if (tab.index - moving < f || tab.pinned) {
      prev = tab;
      continue;
    }
    if (tab.groupId === NO_GROUP) {
      if (!unsafe.has(tab.id)) return mark({ kind: "tab", tabId: tab.id });
      if (!skipped) {
        const after = prev && !prev.pinned ? afterAnchor(ctx, prev, tabs) : null;
        if (after) return after;
        skipped = tab;
      }
      prev = tab;
      continue;
    }
    if (isSplitLike(ctx, tab.groupId)) return mark({ kind: "split", groupId: tab.groupId });
    if (!ctx.created.has(tab.groupId)) return mark({ kind: "group", groupId: tab.groupId });
    prev = tab;
  }
  return skipped ? { kind: "end", skipped: skipped.id } : null;
}

// Where an anchor puts a run, comparable across anchors of one read: before the target's index, or just after the
// tab of an "after" anchor; the end is last.
function slotOf(anchor, tabs) {
  if (anchor.kind === "after") return (tabs.find((t) => t.id === anchor.tabId)?.index ?? Infinity) + 0.5;
  return targetTab(anchor, tabs)?.index ?? Infinity;
}

// The tab a run must end up right before: null for the end of the strip, undefined when the anchor is gone. Not for
// "after" anchors, which name the tab the run must end up right after.
function targetTab(anchor, tabs) {
  if (anchor.kind === "end") return null;
  if (anchor.kind === "tab") return tabs.find((t) => t.id === anchor.tabId);
  return ordered(tabs).find((t) => t.groupId === anchor.groupId);
}

// The run's tabs sit loose, in order, with nothing between them, where the anchor puts them: right before its
// target (last, for the end), or right after the tab of an "after" anchor.
function inPlace(tabs, memberIds, anchor) {
  const strip = ordered(tabs);
  const at = strip.findIndex((t) => t.id === memberIds[0]);
  if (at < 0) return false;
  for (let k = 0; k < memberIds.length; k++) {
    const tab = strip[at + k];
    if (!tab || tab.id !== memberIds[k] || tab.pinned || tab.groupId !== NO_GROUP) return false;
  }
  if (anchor.kind === "after") return at > 0 && strip[at - 1].id === anchor.tabId;
  const target = targetTab(anchor, tabs);
  if (target === undefined) return false;
  const next = strip[at + memberIds.length];
  return target === null ? next === undefined : next?.id === target.id;
}

// The tabs.move index that puts the run where the anchor says (header: a batch moved back lands with its first tab
// at the index, one moved forward with its last tab there), or undefined when the anchor is gone.
function moveIndex(anchor, tabs, memberIds) {
  const first = tabs.find((t) => t.id === memberIds[0]);
  if (anchor.kind === "after") {
    const prev = tabs.find((t) => t.id === anchor.tabId);
    return prev && (first.index < prev.index ? prev.index : prev.index + 1);
  }
  const target = targetTab(anchor, tabs);
  if (target === undefined) return undefined;
  return target === null ? -1 : target.index - (first.index < target.index ? 1 : 0);
}

// The run sits loose and in order right after the group's last tab: it joined the group at its front, and the
// ungroup that followed put it at the group's end.
function rightAfter(tabs, memberIds, groupId) {
  const strip = ordered(tabs);
  const at = strip.findIndex((t) => t.id === memberIds[0]);
  return at > 0 && strip[at - 1].groupId === groupId &&
    memberIds.every((id, k) => strip[at + k]?.id === id && strip[at + k].groupId === NO_GROUP);
}

async function placeRun(ctx, memberIds, anchor, tabs) {
  if (memberIds.length > MOVE_BATCH) return placeInChunks(ctx, memberIds, anchor, tabs);
  const result = await attempt(ctx, memberIds, anchor, tabs);
  if (result.ok) return result;
  // Joined at the front and ungrouped to the end. A "split" anchor that a run joined is an untitled plain group.
  if ((anchor.kind === "group" || anchor.kind === "split") && rightAfter(result.tabs, memberIds, anchor.groupId)) {
    return hoppable(ctx, anchor.groupId, result.tabs)
      ? hop(ctx, memberIds, anchor, result.tabs)
      : backThenForward(ctx, memberIds, anchor, result.tabs);
  }
  return memberIds.length > 1 ? oneByOne(ctx, memberIds, anchor, result.tabs) : result;
}

// One batch: a single tabs.move (none when the run is already in place), then any tab that joined a group is
// ungrouped again. Resolves to { ok, tabs } with tabs read after the last change; those reads stop undo if the Space
// changed (readHere), so a fallback never acts on ids a read of another Space can't vouch for.
async function attempt(ctx, memberIds, anchor, tabs) {
  const { api, windowId, begin, readHere } = ctx;
  const index = moveIndex(anchor, tabs, memberIds);
  if (index === undefined) return { ok: false, tabs };
  if (inPlace(tabs, memberIds, anchor)) return { ok: true, tabs };
  await suppressAround(ctx, tabs, memberIds, anchor);
  await begin();
  await api.tabs.move(memberIds, { index, windowId });
  const after = await unjoin(ctx, await readHere(), memberIds);
  return { ok: inPlace(after, memberIds, anchor), tabs: after };
}

// tabs.move has no "stay ungrouped" flag: a tab that landed next to a grouped tab may have joined it. Every run tab
// was loose right before the move, so a group it is in now is one the move put it in: never a split (tabs.move
// doesn't join one), even when it is untitled and looks like one (header), and an ungroup on a real split tab would
// do nothing anyway (M0). Ungrouped in reverse run order, which keeps the run's order whether it joined at the
// group's front or end.
async function unjoin(ctx, tabs, memberIds) {
  const joined = new Map(tabs.filter((t) => memberIds.includes(t.id) && t.groupId !== NO_GROUP).map((t) => [t.id, t]));
  if (!joined.size) return tabs;
  await ctx.api.tabs.ungroup(memberIds.filter((id) => joined.has(id)).reverse());
  const after = await ctx.readHere();
  await recollapse(ctx, new Set([...joined.values()].map((t) => t.groupId)));
  return after;
}

// Zen expands a collapsed group when a tab joins it (M0), so a group that was collapsed is collapsed again after
// such a join: any group undo found collapsed (a split never is, so an untitled one that was is a plain group). The
// joined groups step 5 sets wait for it until it has run, since it gives them their journaled state.
async function recollapse(ctx, groupIds) {
  const { api, groupInfo, collapseIds, onOwnGroupChange, fail } = ctx;
  for (const groupId of groupIds) {
    if (collapseIds.has(groupId) && !ctx.collapseRestored) continue;
    if (!groupInfo.get(groupId)?.collapsed) continue;
    try {
      if ((await api.tabGroups.get(groupId)).collapsed) continue;
      await onOwnGroupChange(groupId);
      await api.tabGroups.update(groupId, { collapsed: true });
    } catch (error) {
      fail("collapse", "Could not collapse a group again", error);
    }
  }
}

// The suppression window for collapsed groups on either side of where the run will land, opened before the move.
async function suppressAround(ctx, tabs, memberIds, anchor) {
  const rest = ordered(tabs).filter((t) => !memberIds.includes(t.id));
  let at;
  if (anchor.kind === "after") {
    at = rest.findIndex((t) => t.id === anchor.tabId) + 1;
  } else {
    const target = targetTab(anchor, tabs);
    at = target === null ? rest.length : rest.findIndex((t) => t.id === target.id);
  }
  await suppressNear(ctx, [rest[at - 1], rest[at]], "Could not mark a move as Zen Tidy's own");
}

// onOwnGroupChange for each collapsed group among `near`, the tabs on either side of a landing spot (a split is never
// collapsed, so an untitled group that is collapsed is a plain one, which a move can join and expand).
async function suppressNear(ctx, near, message) {
  const ids = near
    .filter((t) => t && t.groupId !== NO_GROUP && ctx.groupInfo.get(t.groupId)?.collapsed)
    .map((t) => t.groupId);
  for (const groupId of new Set(ids)) {
    try {
      await ctx.onOwnGroupChange(groupId);
    } catch (error) {
      ctx.fail("collapse", message, error);
    }
  }
}

// Only Zen Tidy's own groups hop: one the apply created or joined, or any tidy group (SIG title, not a folder),
// with every tab visible here and unpinned. Never a split, never the person's own group.
function hoppable(ctx, groupId, tabs) {
  if (isSplitLike(ctx, groupId)) return false;
  const info = ctx.groupInfo.get(groupId);
  const tidy = ctx.ours.has(groupId) || (info && isTidyTitle(info.title) && info.color !== FOLDER_COLOR);
  const members = tabs.filter((t) => t.groupId === groupId);
  return Boolean(tidy) && members.length > 0 && members.every((t) => !t.pinned);
}

// The run sits right after the group; the group moves forward over it (tabGroups.move: the index is the group's
// final position, verified in Zen by zen_flow 5b), so the group keeps its place among everything else.
async function hop(ctx, memberIds, anchor, tabs) {
  const { api, windowId, begin, readHere } = ctx;
  const size = tabs.filter((t) => t.groupId === anchor.groupId).length;
  const last = tabs.find((t) => t.id === memberIds.at(-1));
  await begin();
  await api.tabGroups.move(anchor.groupId, { index: last.index - size + 1, windowId });
  const after = await readHere();
  return { ok: inPlace(after, memberIds, anchor), tabs: after };
}

// The person's own group (named or untitled) is never moved. The run goes back past the tab before the group, then
// forward to the group's edge: a forward move lands after the tab at its target index, so it joins at most that tab's
// group (and comes out of it in place) if tabs.move joins only the neighbour at the target index.
async function backThenForward(ctx, memberIds, anchor, tabs) {
  const rest = ordered(tabs).filter((t) => !memberIds.includes(t.id));
  const at = rest.findIndex((t) => t.id === targetTab(anchor, tabs)?.id);
  const prev = at > 0 ? rest[at - 1] : null;
  if (!prev || prev.pinned) return { ok: false, tabs };
  const past = prev.groupId === NO_GROUP
    ? { kind: "tab", tabId: prev.id }
    : { kind: isSplitLike(ctx, prev.groupId) ? "split" : "group", groupId: prev.groupId };
  const back = await attempt(ctx, memberIds, past, tabs);
  if (inPlace(back.tabs, memberIds, anchor)) return { ok: true, tabs: back.tabs };
  return attempt(ctx, memberIds, anchor, back.tabs);
}

// A run longer than MOVE_BATCH, MOVE_BATCH tabs at a time: the last chunk where the anchor says, then each earlier
// chunk right before the first tab of the chunk after it, with a yield and a fresh read between chunks. A tab closed
// by then is counted missing, and one pinned or grouped by the person is left there and listed, as putBack does
// for a whole run; the run is in place when the tabs that went back sit together where the anchor says.
async function placeInChunks(ctx, memberIds, anchor, tabs) {
  const { yieldFn, readHere, report } = ctx;
  let current = tabs;
  let next = anchor;
  const back = [];
  for (let end = memberIds.length; end > 0; end -= MOVE_BATCH) {
    if (end < memberIds.length) {
      await yieldFn();
      current = await readHere();
    }
    const byId = new Map(current.map((t) => [t.id, t]));
    const chunk = [];
    for (const id of memberIds.slice(Math.max(0, end - MOVE_BATCH), end)) {
      const tab = byId.get(id);
      if (!tab) report.missing++;
      else if (tab.pinned || tab.groupId !== NO_GROUP) report.moved.push({ title: tab.title ?? "" });
      else chunk.push(id);
    }
    if (!chunk.length) continue;
    current = (await placeRun(ctx, chunk, next, current)).tabs;
    back.unshift(...chunk);
    next = { kind: "tab", tabId: chunk[0] };
  }
  return { ok: inPlace(current, back, anchor), tabs: current };
}

// Each tab on its own, last first, each right before the one after it (the last where the anchor says).
async function oneByOne(ctx, memberIds, anchor, tabs) {
  let next = anchor;
  let current = tabs;
  for (let i = memberIds.length - 1; i >= 0; i--) {
    current = (await placeRun(ctx, [memberIds[i]], next, current)).tabs;
    next = { kind: "tab", tabId: memberIds[i] };
  }
  return { ok: inPlace(current, memberIds, anchor), tabs: current };
}

// 4. A joined group's old title, only while its title is still the one apply set (re-read right before).
async function restoreTitles(ctx, titles, joins) {
  const { api, report, fail, onOwnGroupChange, begin, groupInfo } = ctx;
  for (const { groupId, title } of titles) {
    const join = joins.find((j) => j.groupId === groupId);
    let info;
    try {
      info = await api.tabGroups.get(groupId);
    } catch {
      continue; // gone since the plan: nothing to restore
    }
    if (!sameTitleHash(info.title, join?.titleHash)) {
      report.titlesKept++;
      continue;
    }
    await begin();
    try {
      await onOwnGroupChange(groupId);
    } catch (error) {
      fail("title", "Could not mark a rename as Zen Tidy's own", error);
    }
    try {
      await api.tabGroups.update(groupId, { title });
      report.titlesRestored++;
      if (groupInfo.has(groupId)) groupInfo.get(groupId).title = title;
    } catch (error) {
      fail("title", "Could not restore a group's old name", error);
    }
  }
}

// 5. Joined groups' collapsed state as journaled, while they are still tidy groups (re-read right before). What it
// finds or sets is what later re-collapsing (after a reopened tab joins one) goes by.
async function restoreCollapsed(ctx, collapse) {
  const { api, fail, onOwnGroupChange, begin, groupInfo } = ctx;
  const note = (groupId, collapsed) => {
    if (groupInfo.has(groupId)) groupInfo.get(groupId).collapsed = collapsed;
  };
  for (const { groupId, collapsed } of collapse) {
    let info;
    try {
      info = await api.tabGroups.get(groupId);
    } catch {
      continue;
    }
    note(groupId, Boolean(info.collapsed));
    if (Boolean(info.collapsed) === collapsed || !isTidyTitle(info.title) || info.color === FOLDER_COLOR) continue;
    await begin();
    try {
      await onOwnGroupChange(groupId);
    } catch (error) {
      fail("collapse", "Could not mark a collapse as Zen Tidy's own", error);
    }
    try {
      await api.tabGroups.update(groupId, { collapsed });
      note(groupId, collapsed);
    } catch (error) {
      fail("collapse", "Could not restore a group's collapsed state", error);
    }
  }
  ctx.collapseRestored = true;
}

// 6. Closed tabs come back live (tabs.create with no `discarded`, so Zen gives them a Space: M0 8b), each discarded
// right after its create resolved (settleReopened), at most REOPEN_CONCURRENCY in flight. Creates are serial, each
// placed from a fresh read: right before the tab that followed it at close time, else right after the one before it,
// else at its old index; at a group's or split's edge, never strictly inside one (Zen would absorb it into the split
// at the next restart), except inside the tidy group it goes back into (rejoinTarget, reopenPlace, rejoin). Each
// create is bracketed by a tab known to be in the tidied Space (header). It may run in two passes (undoAll: the closed
// tabs of a group the lift would empty go first), which share `state` (newReopening); countReopened reports once.
// What stops a reopen short leaves the journal for Try again (countReopened): a create Zen refused (until it has been
// refused REOPEN_ATTEMPTS times), one that outlived its guard, or a Space change. Each reopened tab gets its old key
// the moment its create resolves, and a create that outlives its guard gets it if its tab ever opens (labelLate), so
// a retry, which skips closed entries whose key is open, never reopens a tab twice.
async function reopenClosed(ctx, entries, snapshot, waitReady, createTimeoutMs, state) {
  if (state.stop) {
    // An earlier pass stopped (the Space changed, or Zen didn't respond): these are not tried either.
    state.stop.left += entries.length;
    return;
  }
  const { api, windowId, fail, begin, readTabs, yieldFn, placed } = ctx;
  const { reopened, verified, closedByKey } = state;
  const keyToTabId = new Map(snapshot.tabs.filter((t) => t.key).map((t) => [t.key, t.id]));
  // Unpinned tabs live in one Space, and the start snapshot was taken in the tidied one (the Space check).
  const startIds = snapshot.tabs.filter((t) => !t.pinned).map((t) => t.id);
  const inFlight = new Set();
  for (const [n, entry] of entries.entries()) {
    while (inFlight.size >= REOPEN_CONCURRENCY) await Promise.race(inFlight);
    const tabs = await readTabs();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const find = (key) => {
      const id = reopened.get(key) ?? keyToTabId.get(key);
      return id === undefined ? null : byId.get(id) ?? null;
    };
    const anchor = spaceAnchor([find(entry.after), find(entry.before)], [...placed, ...verified, ...startIds], byId);
    if (!anchor) {
      // No tab of the tidied Space in view: the Space changed. Before any change that is the re-check's answer.
      if (!ctx.started()) throw new UndoNotStartedError(new Error("the Space changed"), "wrong-space");
      state.stop = { left: entries.length - n, reason: "the Space changed" };
      break;
    }
    const group = await rejoinTarget(ctx, entry, tabs);
    // Going back into its group, a tab looks past the closed tabs after it that are not back yet: the first of a
    // closed run at the group's front would otherwise see neither neighbour in the group and land at its end.
    const placing = group === null ? entry : { ...entry, after: nextOpenKey(entry, closedByKey, find) };
    const place = reopenPlace(tabs, placing, find, group);
    await suppressNear(ctx, neighboursAt(tabs, place.index), "Could not mark a reopen as Zen Tidy's own");
    await begin();
    // The create itself, kept beside its guard: a tab that opens after the guard gave up is still labelled.
    const creating = api.tabs.create({ windowId, url: entry.url, index: place.index, active: false });
    let tab;
    try {
      tab = await guard(creating, createTimeoutMs);
    } catch (error) {
      if (error?.timedOut) {
        labelLate(ctx, creating, entry);
        state.stop = { left: entries.length - n, reason: "Zen didn't respond" };
        break;
      }
      // Refused: Try again tries it again, until Zen has refused it REOPEN_ATTEMPTS times (keepForRetry).
      state.refused.set(entry.key, failuresOf(entry) + 1);
      fail({ scope: "reopen", count: 1 }, "Could not reopen a closed tab", error);
      continue;
    }
    // Its old key at once, before anything else is awaited: a tab left without it (undo stopped, or Zen closed, before
    // settleReopened) would be reopened again by Try again. settleReopened writes it again, and reports a failure.
    try {
      await api.sessions.setTabValue(tab.id, TAB_KEY, entry.key);
    } catch {
      // See above.
    }
    const after = await readTabs();
    if (!after.some((t) => t.id === anchor.id)) {
      // The Space changed while the tab was created, so it opened in the other one: closed again (only if this
      // query returned it).
      if (after.some((t) => t.id === tab.id)) {
        try {
          await api.tabs.remove(tab.id);
        } catch (error) {
          fail("reopen", "Could not close a tab reopened in the wrong Space", error);
        }
      }
      state.stop = { left: entries.length - n, reason: "the Space changed" };
      break;
    }
    // Not in this Space although the Space didn't change (a Space Routing rule, or closed at once): left alone.
    if (!after.some((t) => t.id === tab.id)) {
      state.strays.add(entry.key);
      continue;
    }
    reopened.set(entry.key, tab.id);
    verified.push(tab.id);
    // Back into its group now, before the next create reads where it is.
    if (group !== null) await rejoin(ctx, tab.id, group, place.before, after);
    const task = settleReopened(ctx, tab.id, entry, waitReady, group).finally(() => inFlight.delete(task));
    inFlight.add(task);
    await yieldFn();
  }
  await Promise.all(inFlight);
}

// The reopen step's progress, shared by its passes: tabs reopened by key, those verified in this Space, the keys of
// strays (reopened outside this Space) and of refused creates (with how many times each has been refused now), why
// it stopped, and every closed entry of this undo by key (for nextOpenKey).
function newReopening(entries) {
  return {
    reopened: new Map(), verified: [], strays: new Set(), refused: new Map(), stop: null,
    closedByKey: new Map(entries.map((e) => [e.key, e])),
  };
}

// A tab whose create outlived its guard (the batch stopped there), labelled once it opens, best effort: its old key,
// so Try again sees it is back instead of opening the page a second time, then unloaded and given zt-reopen, as
// settleReopened does.
function labelLate(ctx, creating, entry) {
  const { api, now } = ctx;
  creating.then(async (tab) => {
    if (!Number.isInteger(tab?.id)) return;
    try {
      await api.sessions.setTabValue(tab.id, TAB_KEY, entry.key);
      await api.tabs.discard(tab.id);
      const title = typeof entry.title === "string" ? entry.title : "";
      await api.sessions.setTabValue(tab.id, REOPEN_KEY, { url: entry.url, title, at: now() });
    } catch {
      // Left as far as it got.
    }
  }, () => {});
}

// Right before undo rejects for Try again: the journal's closed entries learn what this attempt found. A refused
// create's count goes on its entry (reopenFailures; analyze stops trying it at REOPEN_ATTEMPTS), and a tab another
// Space took (a Space Routing rule) loses its entry: it was reopened, and each retry would only open it there again.
async function keepForRetry(ctx, state) {
  const { refused, strays } = state;
  if ((!refused.size && !strays.size) || ctx.kept === null || typeof ctx.kept !== "object") return;
  ctx.kept.closed = list(ctx.kept.closed)
    .filter((c) => !strays.has(c?.key))
    .map((c) => (refused.has(c?.key) ? { ...c, reopenFailures: refused.get(c.key) } : c));
  await ctx.record();
}

// The key of the first tab after `entry` at close time that is not a closed tab still waiting to be reopened,
// following each such tab's own `after` (a closed run anchors on the open tab past its end).
function nextOpenKey(entry, closedByKey, find) {
  let key = entry.after;
  for (const seen = new Set(); closedByKey.has(key) && !find(key) && !seen.has(key);) {
    seen.add(key);
    key = closedByKey.get(key).after;
  }
  return key;
}

// The joined groups the lift would empty: every tab in them now is a tab undo puts back.
function emptiedByLift(snapshot, restore, joinedIds) {
  const restoreIds = new Set(restore.map((r) => r.tabId));
  const emptied = new Set();
  for (const groupId of joinedIds) {
    const members = snapshot.tabs.filter((t) => t.groupId === groupId);
    if (members.length && members.every((t) => restoreIds.has(t.id))) emptied.add(groupId);
  }
  return emptied;
}

// The reopen step's report, once its passes are done. A reopened tab missing now (closed meanwhile) can only be told
// apart from a later Space switch while a tab of this Space is still in view; after a switch, the tabs verified at
// their create count as back.
// A create Zen refused (fewer than REOPEN_ATTEMPTS times so far), one that outlived its guard and a Space change all
// leave the journal for Try again (ctx.unfinished), which reopens only the entries whose key isn't open. A tab that
// showed up outside this Space (a Space Routing rule) does not: the rule would take it again on every retry.
async function countReopened(ctx, state, snapshot) {
  const { report, fail, readTabs, placed } = ctx;
  const { verified, strays, stop, refused } = state;
  const startIds = snapshot.tabs.filter((t) => !t.pinned).map((t) => t.id);
  const final = await readTabs();
  const known = new Set([...placed, ...verified, ...startIds]);
  const finalIds = new Set(final.map((t) => t.id));
  const stillHere = final.some((t) => known.has(t.id) && !t.pinned);
  const gone = stillHere ? verified.filter((id) => !finalIds.has(id)).length : 0;
  report.reopened = verified.length - gone;
  const lost = gone + strays.size;
  if (lost) fail({ scope: "reopen", count: lost }, `${lost} reopened tab(s) did not show up in this Space.`);
  if (stop) fail({ scope: "reopen", count: stop.left }, `${stop.left} closed tab(s) weren't reopened: ${stop.reason}.`);
  if (stop || [...refused.values()].some((tries) => tries < REOPEN_ATTEMPTS)) ctx.unfinished = true;
}

// 6, last part. A tidy group the apply's closes emptied (journal closedGroups) went away with its last tab, so its
// tabs came back loose (rejoinTarget found no group to go back into). They are grouped again as groups.js makes a
// group again: in strip order with a safe tab first (unsafeOf: never the open tab or a possible Glance tab), any
// before it moved back to the group's front. The new id goes into the journal (the entry's groupId, `recreated`, and
// the group's closed entries) before the group is named, since an untitled group looks exactly like a split view
// (M0) and Try again must find it; then the full title and the collapsed state, each with the suppression window
// first. The tabs were reopened in their places, side by side, so the group stands where it stood. A group an
// earlier attempt made again that is still here gets the tabs that came back loose since, and its title if it has
// none. Any other group that still exists was never emptied, and rejoin has put its tabs back.
async function remakeClosedGroups(ctx, view, snapshot, reopening) {
  const { api, windowId, readTabs } = ctx;
  const keyToTabId = new Map([...snapshot.tabs.filter((t) => t.key).map((t) => [t.key, t.id]), ...reopening.reopened]);
  for (const entry of view.closedGroups) {
    const existing = list(await api.tabGroups.query({})).find((g) => g?.id === entry.groupId);
    if (existing && (!entry.recreated || existing.windowId !== windowId)) continue;
    const tabs = await readTabs();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const loose = view.closed
      .filter((c) => c.groupId === entry.groupId)
      .map((c) => byId.get(keyToTabId.get(c.key)))
      .filter((t) => t && !t.pinned && t.groupId === NO_GROUP)
      .map((t) => t.id);
    let groupId = entry.groupId;
    if (existing) {
      const members = tabs.filter((t) => t.groupId === groupId);
      if (!members.length || members.some((t) => t.pinned)) continue;
      if (loose.length && !(await addToGroup(ctx, groupId, loose))) continue;
    } else {
      if (!loose.length) continue;
      groupId = await remakeGroup(ctx, entry, loose, tabs);
      if (groupId === null) continue;
    }
    if (!existing || existing.title === "") await nameRemade(ctx, groupId, entry.title);
    await collapseRemade(ctx, groupId, entry.collapsed);
  }
}

// The closed tabs' group made again from `ids` (strip order), its new id recorded (remakeClosedGroups). null when no
// tab can safely start it (they stay loose, reported) or tabs.group threw (left for Try again).
async function remakeGroup(ctx, entry, ids, tabs) {
  const { api, windowId, fail, begin, kept } = ctx;
  const unsafe = unsafeOf(tabs);
  const first = ids.findIndex((id) => !unsafe.has(id));
  if (first < 0) {
    fail({ scope: "reopen", count: ids.length }, `${ids.length} reopened tab(s) stayed loose: no tab could safely start their group again.`);
    return null;
  }
  const lead = ids.slice(0, first);
  await begin();
  let groupId;
  try {
    groupId = await api.tabs.group({ tabIds: [...ids.slice(first), ...lead], createProperties: { windowId } });
  } catch (error) {
    fail({ scope: "reopen", count: ids.length }, `Could not put ${ids.length} reopened tab(s) back in their group`, error);
    ctx.unfinished = true;
    return null;
  }
  if (kept !== null && typeof kept === "object") {
    kept.closedGroups = list(kept.closedGroups).map((g) => (g?.groupId === entry.groupId ? { ...g, groupId, recreated: true } : g));
    kept.closed = list(kept.closed).map((c) => (c?.groupId === entry.groupId ? { ...c, groupId } : c));
  }
  await ctx.record();
  if (lead.length) await leadToFront(ctx, groupId, lead);
  return groupId;
}

// Reopened tabs that came back loose, into the group an earlier attempt made again. Resolves to false when it threw.
async function addToGroup(ctx, groupId, ids) {
  const { api, fail, begin } = ctx;
  await begin();
  await suppressGroup(ctx, groupId, "reopen");
  try {
    await api.tabs.group({ tabIds: ids, groupId });
    return true;
  } catch (error) {
    fail({ scope: "reopen", count: ids.length }, `Could not put ${ids.length} reopened tab(s) back in their group`, error);
    ctx.unfinished = true;
    return false;
  }
}

// The tabs that went in at the group's end because none of them could start it, moved back to its front: a backward
// move onto a group's first index joins the group of the tab there (Zen 1.23.4b, measured in M3), this one.
async function leadToFront(ctx, groupId, lead) {
  const { api, windowId, readTabs, fail } = ctx;
  const members = ordered(await readTabs()).filter((t) => t.groupId === groupId);
  const ids = lead.filter((id) => members.some((t) => t.id === id));
  if (!ids.length) return;
  try {
    await api.tabs.move(ids, { index: members[0].index, windowId });
  } catch (error) {
    fail({ scope: "order", code: "near", count: ids.length }, `${ids.length} tab(s) were put next to their place`, error);
  }
}

// The suppression window before a change to `groupId`; a failing hook costs only the attribution.
async function suppressGroup(ctx, groupId, scope) {
  try {
    await ctx.onOwnGroupChange(groupId);
  } catch (error) {
    ctx.fail(scope, "Could not mark a change as Zen Tidy's own", error);
  }
}

// A group made again gets its full title. Left untitled it would look like a split view, so a failure leaves the
// journal (which names it) for Try again.
async function nameRemade(ctx, groupId, title) {
  await ctx.begin();
  await suppressGroup(ctx, groupId, "title");
  try {
    await ctx.api.tabGroups.update(groupId, { title });
  } catch (error) {
    ctx.fail("title", "Could not give a closed tabs' group its name back", error);
    ctx.unfinished = true;
  }
}

// ... and its collapsed state, re-read right before.
async function collapseRemade(ctx, groupId, collapsed) {
  let info;
  try {
    info = await ctx.api.tabGroups.get(groupId);
  } catch {
    return;
  }
  if (Boolean(info.collapsed) === collapsed) return;
  await ctx.begin();
  await suppressGroup(ctx, groupId, "collapse");
  try {
    await ctx.api.tabGroups.update(groupId, { collapsed });
  } catch (error) {
    ctx.fail("collapse", "Could not restore a group's collapsed state", error);
  }
}

// A visible tab known to be in the tidied Space: a closed tab's neighbour (open, or reopened and checked), else a tab
// put back, a reopened one or any unpinned tab of the start snapshot. Pinned tabs never: Essentials show everywhere.
function spaceAnchor(neighbours, ids, byId) {
  for (const tab of neighbours) if (tab && !tab.pinned) return tab;
  for (const id of ids) {
    const tab = byId.get(id);
    if (tab && !tab.pinned) return tab;
  }
  return null;
}

// The tabs on either side of where a tab created at `index` lands (-1: the end).
function neighboursAt(tabs, index) {
  const strip = ordered(tabs);
  const at = index === -1 ? -1 : strip.findIndex((t) => t.index >= index);
  const pos = at < 0 ? strip.length : at;
  return [strip[pos - 1], strip[pos]];
}

// Rejects with `timedOut` once `ms` pass before the promise settles.
function guard(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { timedOut: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One reopened tab: unloaded at once (its create resolving was the signal; waitReady is immediate by default),
// labelled with its old key, its URL and title (it reads about:blank until it is activated) and the time, and taken
// out of any group it landed in other than `keepGroupId`, the tidy group rejoin put it back in. A tab gone from
// tabs.query by then is left alone; the final check counts it. Never rejects.
async function settleReopened(ctx, tabId, entry, waitReady, keepGroupId = null) {
  const { api, fail, readTabs } = ctx;
  try {
    await waitReady(api, tabId);
  } catch {
    // A readiness wait that fails only means the tab is unloaded without it.
  }
  let tab;
  try {
    tab = (await readTabs()).find((t) => t.id === tabId);
  } catch (error) {
    fail("reopen", "A reopened tab could not be checked", error);
    return;
  }
  if (!tab) return;
  try {
    await api.tabs.discard(tabId);
  } catch (error) {
    fail("reopen", "A reopened tab could not be unloaded again", error);
  }
  try {
    // The old key, so a retry sees it is back (the planner skips closed entries whose key is open).
    await api.sessions.setTabValue(tabId, TAB_KEY, entry.key);
    const title = typeof entry.title === "string" ? entry.title : "";
    // `at`: once the tab has been activated since (tab.lastAccessed past it), takeSnapshot no longer trusts the value.
    await api.sessions.setTabValue(tabId, REOPEN_KEY, { url: entry.url, title, at: ctx.now() });
  } catch (error) {
    fail("reopen", "A reopened tab could not be labelled; it shows as a blank page until opened", error);
  }
  if (tab.groupId === NO_GROUP || tab.groupId === keepGroupId) return;
  if (isSplitLike(ctx, tab.groupId)) {
    fail("reopen", "A reopened tab landed inside a split view.");
    return;
  }
  try {
    await api.tabs.ungroup([tabId]);
    await recollapse(ctx, new Set([tab.groupId]));
  } catch (error) {
    fail("reopen", "A reopened tab could not be taken out of a group", error);
  }
}

// Where a closed tab is created: { index, before }. tabs.create puts it at exactly `index`; at a group's first index
// it lands before the group, at last + 1 after it, and strictly inside it joins it (M0). Anchors never the active tab
// or a Glance suspect, never pinned tabs. A tab going back into its tidy group (`group`, from rejoinTarget) goes right
// after the tab before it when that one is in the group (strictly inside the group it joins at once; after the
// group's last tab rejoin adds it, at the end, which is the same place), else right before the tab after it when that
// one is: `before` then names that tab, since a tab created at the group's first index lands outside it and rejoin
// must put it back there. Otherwise as any closed tab, and rejoin adds it at the group's end.
function reopenPlace(tabs, entry, find, group = null) {
  const unsafe = unsafeOf(tabs);
  const usable = (t) => t && !t.pinned && !unsafe.has(t.id);
  const span = (t) => {
    const members = t.groupId === NO_GROUP ? [t] : ordered(tabs).filter((m) => m.groupId === t.groupId);
    return [members[0].index, members.at(-1).index];
  };
  const next = find(entry.after);
  const prev = find(entry.before);
  if (group !== null && usable(prev) && prev.groupId === group) {
    return { index: safeIndex(tabs, prev.index + 1, group), before: null };
  }
  if (group !== null && usable(next) && next.groupId === group) {
    return { index: safeIndex(tabs, next.index, group), before: next.id };
  }
  let index;
  if (usable(next)) index = span(next)[0];
  else if (usable(prev)) index = span(prev)[1] + 1;
  else index = Number.isFinite(entry.index) ? entry.index : -1;
  return { index: safeIndex(tabs, index), before: null };
}

// Inside the loose area, and never strictly between two tabs of one group or split: there it snaps to the group's
// first index, before it. The one exception is `group`, a tidy group the tab goes back into.
function safeIndex(tabs, index, group = null) {
  const strip = ordered(tabs);
  const loose = strip.filter((t) => !t.pinned);
  const end = strip.length ? strip.at(-1).index + 1 : 0;
  const start = loose.length ? loose[0].index : end;
  let at = index === -1 || index > end ? end : Math.max(index, start);
  const before = strip.filter((t) => t.index < at).at(-1);
  const after = strip.find((t) => t.index >= at);
  if (before && after && before.groupId !== NO_GROUP && before.groupId === after.groupId && before.groupId !== group) {
    at = strip.find((t) => t.groupId === before.groupId).index;
  }
  return at;
}

// The tidy group a closed tab goes back into: its journaled groupId, while that group is still a tidy group here (a
// SIG title, not a Zen folder, in this window, with tabs in `tabs`, every one unpinned), read right before; else null.
// The collapsed state read here is what rejoin collapses the group back to.
async function rejoinTarget(ctx, entry, tabs) {
  const { groupId } = entry;
  if (!Number.isInteger(groupId) || groupId === NO_GROUP) return null;
  const members = tabs.filter((t) => t.groupId === groupId);
  if (!members.length || members.some((t) => t.pinned)) return null;
  let info;
  try {
    info = await ctx.api.tabGroups.get(groupId);
  } catch {
    return null; // gone since the read
  }
  if (!isTidyTitle(info?.title) || info.color === FOLDER_COLOR || info.windowId !== ctx.windowId) return null;
  const { title, color, collapsed } = info;
  ctx.groupInfo.set(groupId, { ...ctx.groupInfo.get(groupId), id: groupId, title, color, collapsed: Boolean(collapsed) });
  return groupId;
}

// A reopened tab back into its tidy group, right after its create (`tabs`: the read that verified it). Created strictly
// inside the group, it is in it already. Otherwise tabs.group({ tabIds: [id], groupId }) adds it: Zen 1.23.4b takes a
// tab right before the group in at its front and one right after it at its end, in place (measured in the M4
// integration); a browser that appends it at the end instead leaves a tab that belongs right before `beforeId`, the
// group's tab that followed it, to move there (a backward move onto a group's first index joins its front: Zen
// 1.23.4b, measured in M3), and if a browser joins another group instead it is added again, at the end. A tab inside a split, or a group undo can't tell from one, is
// never passed on (settleReopened reports it). Zen expands a collapsed group a tab joins (M0), so the suppression
// window opens first, and every group the tab went into is collapsed again after if it was (recollapse).
async function rejoin(ctx, tabId, groupId, beforeId, tabs) {
  const { api, windowId, readTabs, fail } = ctx;
  let current = tabs;
  const self = () => current.find((t) => t.id === tabId);
  const touched = new Set([groupId]);
  // Into the group unless it is there, or in a split; resolves to false when the tab can't go in.
  const addTo = async () => {
    const tab = self();
    if (!tab || (tab.groupId !== NO_GROUP && tab.groupId !== groupId && isSplitLike(ctx, tab.groupId))) return false;
    if (tab.groupId === groupId) return true;
    if (tab.groupId !== NO_GROUP) touched.add(tab.groupId);
    await suppressNear(ctx, current.filter((t) => t.groupId === groupId).slice(0, 1), "Could not mark a reopen as Zen Tidy's own");
    await api.tabs.group({ tabIds: [tabId], groupId });
    current = await readTabs();
    return true;
  };
  try {
    if ((await addTo()) && beforeId !== null) {
      const strip = ordered(current);
      const tab = self();
      const next = current.find((t) => t.id === beforeId);
      if (tab?.groupId === groupId && next?.groupId === groupId && strip[strip.indexOf(tab) + 1] !== next) {
        const rest = strip.filter((t) => t !== tab);
        await suppressNear(ctx, [rest[rest.indexOf(next) - 1], next], "Could not mark a reopen as Zen Tidy's own");
        await api.tabs.move([tabId], { index: next.index - (tab.index < next.index ? 1 : 0), windowId });
        current = await readTabs();
        await addTo();
      }
    }
  } catch (error) {
    fail("reopen", "A reopened tab could not be put back in its group", error);
  }
  await recollapse(ctx, touched);
}
