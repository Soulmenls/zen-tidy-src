// Apply a validated ApplyRequest to the browser: re-check, journal, joins, new groups, ordering, then closing the
// Extras ticked to close. Rules: notes/m2-contracts.md ("Apply"), notes/m4-contracts.md ("Preview and apply") and
// implementation-notes ("Applying a plan", "Zen / Firefox facts").
// The browser comes in as `api` and storage as `store`. Anything can change between the preview and Apply (tabs
// closed, pinned, regrouped or moved to another Space; groups renamed or removed), so every group is re-checked
// against a fresh tabs.query right before it is touched, and only verified loose tabs reach a tab API.
//
// Journal v3 (store.writeJournal; M3 undo reads v1, v2 and v3; notes/m3-contracts.md, "Journal v3"). Written right
// before the first change, so an apply that ends up changing nothing keeps the previous tidy's journal (and its
// undo); again after each new group is created (before it gets its title, so an untitled group never goes
// unrecorded); and once more at the end. If that first write landed but nothing was grouped, created, renamed or
// closed after all (every second re-check failed), the end puts the previous journal back instead (store.readJournal
// right before the first write; removed when there was none), unless it couldn't be read or written:
//   {
//     version: 3,
//     previewId,                     // the preview this apply came from
//     state: "applying" | "done",    // still "applying" at startup = the apply was interrupted: offer undo.
//                                    // Undo sets "undone" when it finishes.
//     startedAt, finishedAt,         // ms; finishedAt is null until done
//     multiWindow: boolean,          // 2+ normal windows were open: undo is unreliable (window sync)
//     urlSalt,                       // 8 random hex digits, fresh for every journal (shared/hash.js newUrlSalt),
//                                    // so an address fingerprints differently in every journal
//     strip: [{ key, kind: "loose" | "split" | "grouped" }], // every unpinned tab visible in the window before
//                                    // the change, in strip order (ascending index), keys only. These are the
//                                    // anchors that put tabs back in their exact places, leftovers and split
//                                    // views included. "grouped" = in any group that is not a split. Taken from
//                                    // the snapshot, so it is the same in every write.
//     tabs: [{ key, urlHash, index, groupId: -1, to }], // tabs with their strip position before the change; tab
//                                    // ids don't survive a restart, the key does. urlHash = fnv1a32(urlSalt + url)
//                                    // (shared/hash.js urlHash): the address's fingerprint, never the address, so
//                                    // undo can tell a tab that still shows its page (a strong match) from one
//                                    // that navigated since (a weak one). v1 and v2 kept the plain `url` here.
//                                    // While "applying": every tab the apply meant to group, since an
//                                    // interrupted apply may have grouped any of them. Once "done": only the
//                                    // tabs it really grouped, so undo never moves a tab that was skipped or
//                                    // that the browser left out. A tab whose tabs.group call went through but
//                                    // could not be read back counts as grouped.
//                                    // `to`: the group it went into (new or joined), or null while it is not
//                                    // grouped yet. Joins have no write of their own, so a joined tab's `to`
//                                    // first shows in the next write. A join reads its tabs back at once, so one
//                                    // the browser left out keeps `to: null`; a tab that drops out of a new
//                                    // group is only found by the final read, so it keeps that group's id in the
//                                    // "applying" writes and the final write leaves its entry out.
//     joins: [{ groupId, collapsed, title?, titleHash? }], // existing groups it touches, as they were. `title`
//                                    // (the full old title, markers included) only when the request renames the
//                                    // group; `titleHash` (shared/hash.js) of the exact title apply then set,
//                                    // added once that rename went through, so undo puts `title` back only if
//                                    // nobody renamed the group since.
//     createdGroupIds: number[],     // each new group, appended before its title is set
//     closed: [{ key, url, title, index, before, after, groupId }], // the Extras to close, for undo to reopen
//                                    // (M4; notes/m4-contracts.md). Every tab the apply means to close is in the
//                                    // first write already, since Zen can stop it between two batches; the final
//                                    // write keeps only the tabs really closed. `url` is the full http(s) address
//                                    // and `title` the tab's title: the one exception to "no address in the
//                                    // journal" (m3-contracts, "Closed entries"), since undo can't reopen a page
//                                    // from a fingerprint. `index` is the tab's position before the change, and
//                                    // `before` / `after` the keys of the unpinned tabs right before and after it
//                                    // then (null at an end), the strip's own neighbours, so other tabs closed
//                                    // with it included. `groupId`: the tidy group it was in, or null.
//     closedGroups?: [{ groupId, title, collapsed }], // the tidy groups the closes empty (every tab in them is
//                                    // closed, and no join adds a tab), which Zen removes with their last tab: their
//                                    // full title (markers included) and collapsed state, so undo can make them
//                                    // again around their reopened tabs. Only present when there is one; the final
//                                    // write keeps only the groups whose every tab really closed. Undo writes the id
//                                    // of a group it made again here, with `recreated: true`, before naming it.
//     undoneAt: null,                // ms, set by undo when it finishes
//     report: ApplyReport | null,    // set when done, with every failure's `name` set to null and its message
//                                    // without the browser's error text (see below)
//   }
// Never in what apply writes, outside `closed`: a tab's address (a fingerprint only: no URL, query, fragment or local
// path), new names in plain text (a rename only as titleHash) or any title other than a joined group's old one. Never
// anywhere: the API key or window ids (they change across restarts). The strip holds keys and kinds only, and the
// joins group ids, states and that old title. The report's failures carry the group's name and the browser's error
// text for the popup, which reads them from the run (storage.session); the journal sits in storage.local, so its copy
// keeps the key, the scope, the count and the fixed message, and drops the name and the error text (an error string
// can carry what was passed in).
//
// Closing (notes/m4-contracts.md). The request's `close` ids go last, after grouping and ordering, so the groups form
// around tabs that are still there, and a tab both grouped and ticked to close is only closed (closing wins, as
// validateApplyRequest already has it). They close CLOSE_BATCH at a time, each batch re-checked against a fresh
// snapshot right before its tabs.remove, with a yield between batches. A tab is closed only while it is still in
// tabs.query here, unpinned, outside any split, on an http(s) page (a tab undo reopened reads about:blank, so the
// snapshot's zt-reopen address counts) whose address holds no key-shaped string (store.js holdsKey: the journal would
// scrub it, and undo reopen another address), not the active tab (a ticked tab the person has opened since is in
// use), not right before an active loose tab other than the one the preview was made from (closeChecks' activeTabId:
// where a Glance opened from the tab since sits, which would close with it and which no undo brings back;
// implementation-notes, Glance), loose or in a tidy group (Extras offer nothing else: a tab the person has since
// dragged into their own group is theirs again, and undo could not put it back there), and, against the journal,
// still holds the key it recorded and is still in the group it recorded (loose, or that tidy group). With the
// request's closeChecks (validateApplyRequest) it must also still show the page the preview offered, and a
// duplicate's kept copy must still be open here on its page, so a tab that navigated since, or whose kept copy is
// gone, stays open. All of these count as "changed since the preview". One more rule keeps undo possible: the
// unpinned tabs still open next to the closed ones are how undo finds the tidied Space and anchors its reopens
// (undo.js, "The Space check"), and the active tab can be a pinned Essential, so when closing would leave no tab of
// the journal's strip open here, the last tab of the batch stays open (code "last-tab"). Which tabs a batch really
// closed is read back with tabs.get (it works in every Space, and fails for a closed tab), since tabs.remove can stop
// partway or leave a tab open (a page that asks before it unloads). tabs.remove need not wait for Zen's close
// animation, so a tab that still reads open is read once more after CLOSE_SETTLE_MS before it counts as left open and
// loses its closed[] entry: in doubt the entry stays, which is harmless, since undo skips an entry whose key is on a
// visible tab.

import { takeSnapshot, glanceSuspects, FOLDER_COLOR } from "./snapshot.js";
import { makeTitle, withIcon, isTidyTitle } from "./markers.js";
import { MIN_NEW_GROUP_TABS } from "./plan.js";
import { fnv1a32, urlHash, newUrlSalt } from "../shared/hash.js";
import { holdsKey } from "./store.js";

export const JOURNAL_VERSION = 3;
const NO_GROUP = -1;
// The most tabs one tabs.remove closes; more go in batches with a yield between them, so Zen's main thread is never
// held for long (as undo's MOVE_BATCH, measured for tabs.move and tabs.ungroup).
export const CLOSE_BATCH = 25;
// How long a tab that still reads open right after tabs.remove gets before it is read again (header, "Closing"): a
// real wait, not a yield, since it covers Zen's close animation.
export const CLOSE_SETTLE_MS = 250;
const isWebUrl = (url) => typeof url === "string" && /^https?:\/\//i.test(url);
const tabsText = (n) => (n === 1 ? "1 tab" : `${n} tabs`);

// Thrown when apply stops before its first change (the first snapshot or the first journal write failed, or
// anything else before that): the browser is untouched, so the caller may keep the preview. Any other throw may
// come after changes.
export const APPLY_NOT_STARTED = "apply-not-started";
export class ApplyNotStartedError extends Error {
  constructor(cause) {
    super(`Apply stopped before changing anything: ${cause?.message ?? cause}`, { cause });
    this.name = "ApplyNotStartedError";
    this.code = APPLY_NOT_STARTED;
  }
}

const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));
const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tabs a group may be stacked in front of. A Glance tab is loose but sits inside its parent in Zen's real strip,
// and its reported index can be stale or lie inside the pinned block (the Glance of an Essential), so moving to it
// lands the group somewhere unverified. Like anchorFirst, this never trusts a loose tab that could be one: the
// active tab, a suspect (`risky` from the snapshot, plus the heuristics on these tabs, which include an index out
// of order), or an unpinned tab at or before the last pinned one. A grouped tab is never a Glance (M0).
function stackable(tabs, risky = []) {
  const lastPinned = Math.max(-1, ...tabs.filter((t) => t.pinned).map((t) => t.index));
  const unsafe = new Set([...risky, ...glanceSuspects(tabs), ...tabs.filter((t) => t.active).map((t) => t.id)]);
  return tabs.filter((t) => !t.pinned && t.index > lastPinned && !(t.groupId === NO_GROUP && unsafe.has(t.id)));
}

// The only place that knows what `index` means to tabGroups.move, so it can be changed in one spot if Zen turns
// out to differ. M0: the index is the group's final position, the index its first tab has after the move.
// - No anchor: the top of the loose area, the lowest index among stackable tabs (see stackable), so a Glance or
//   the active tab at the top stays above the stacked groups.
// - After a group: right after the anchor's last tab. A group that starts before the anchor leaves that range
//   first, so the anchor ends up `size` places earlier.
// Unmodelled: a split nested inside a group may resolve as the neighbour and nest the new group in it; verify in Zen.
// Returns null when the group (or the anchor) has no tab in `tabs`.
export function groupMoveIndex(tabs, groupId, afterGroupId = null, risky = []) {
  const own = tabs.filter((t) => t.groupId === groupId).map((t) => t.index);
  if (!own.length) return null;
  if (afterGroupId === null) {
    const targets = stackable(tabs, risky).map((t) => t.index);
    return targets.length ? Math.min(...targets) : null;
  }
  const anchor = tabs.filter((t) => t.groupId === afterGroupId).map((t) => t.index);
  if (!anchor.length) return null;
  const anchorLast = Math.max(...anchor);
  return Math.min(...own) > anchorLast ? anchorLast + 1 : anchorLast + 1 - own.length;
}

function isLooseTab(tab) {
  return Boolean(tab) && !tab.pinned && tab.groupId === NO_GROUP;
}

function byIndex(tabs) {
  return [...tabs].sort((a, b) => a.index - b.index);
}

// The journal's strip (header): every unpinned tab the snapshot saw, by index rather than array order (a Glance
// tab can sit out of order in tabs.query), keys only. A tab whose group the snapshot couldn't read is a split
// there (it may be a new one), so undo must not anchor inside it either.
function stripOf(snapshot) {
  const split = new Set(snapshot.splitTabIds);
  const kindOf = (t) => (split.has(t.id) ? "split" : t.groupId === NO_GROUP ? "loose" : "grouped");
  return byIndex(snapshot.tabs.filter((t) => !t.pinned)).map((t) => ({ key: t.key, kind: kindOf(t) }));
}

// The tab right after the anchor's last tab (in index order; hidden tabs leave gaps) must be the group's first.
function followsDirectly(tabs, groupId, anchorId) {
  const ordered = byIndex(tabs);
  let last = -1;
  ordered.forEach((t, i) => {
    if (t.groupId === anchorId) last = i;
  });
  return last >= 0 && ordered[last + 1]?.groupId === groupId;
}

// Group ids in the order they open the loose area: the first `count` runs of stackable tabs, so a Glance or the
// active tab that groupMoveIndex left above (or between) the stacked groups is not mistaken for a misplacement.
function groupsAtTop(tabs, count, risky) {
  const runs = [];
  for (const t of byIndex(stackable(tabs, risky))) {
    if (runs.at(-1) === t.groupId) continue;
    runs.push(t.groupId);
    if (runs.length === count) break;
  }
  return runs;
}

// applyRequest(api, request, { windowId, store, now, yieldFn, onOwnGroupChange, snapshot, delay }) resolves to an
// ApplyReport: { groupsCreated, groupsJoined, groupsRenamed, tabsGrouped, tabsClosed, skippedTabIds, failures }.
// - groupsRenamed: existing groups whose title was rewritten (a new name, a new icon, or both).
// - tabsClosed: tabs ticked to close that are closed now.
// - failures: [{ key, name, scope, message, count?, code? }]. key is the group's key and name its cleaned name, both
//   null when the failure is not about one group (the ordering pass as a whole, closing, or the final journal write).
//   scope is "group" (creating, joining or renaming it), "order" (putting it, or all new groups, in place), "close"
//   (tabs ticked to close that are still open: changed since the preview, kept open as the last tab here (code
//   "last-tab"), or not closed by the browser; `count` says how many) or "journal" (the undo record).
// - request: the cleaned request from validateApplyRequest: { previewId, groups, close?, closeChecks? }. A request
//   that only closes tabs is valid and has a journal of its own. Without closeChecks (a caller other than the router)
//   the page checks are skipped; every other re-check still runs.
// - store: { writeJournal(journal), readJournal?(), removeJournal?() } (the optional two put the previous journal
//   back after an apply that changed nothing; header). onOwnGroupChange(groupId) opens the suppression window and
//   is awaited before the first change to each group. snapshot: optional (api, { windowId }) => Snapshot, and
//   delay: optional (ms) => Promise, the wait before a tab that still reads open is read again; both for tests.
// It rejects with ApplyNotStartedError when it stops before the first change (the first snapshot or the first
// journal write failed). Everything after that becomes a failure entry.
export async function applyRequest(api, request, options = {}) {
  const changes = { started: false };
  try {
    return await applyAll(api, request, options, changes);
  } catch (error) {
    // Until the first journal write has landed nothing has changed, whatever failed.
    if (changes.started || error instanceof ApplyNotStartedError) throw error;
    throw new ApplyNotStartedError(error);
  }
}

async function applyAll(api, request, options, changes) {
  const {
    windowId, store, now = Date.now, yieldFn = defaultYield, onOwnGroupChange = () => {}, snapshot: snap = takeSnapshot,
    delay = defaultDelay,
  } = options;
  const report = {
    groupsCreated: 0, groupsJoined: 0, groupsRenamed: 0, tabsGrouped: 0, tabsClosed: 0, skippedTabIds: [], failures: [],
  };
  // group: the request group the failure is about, or null. error: the browser's error, when there is one; its text
  // goes into the returned report for the popup, while the journal's copy keeps the fixed message only (header).
  // Returns the entry, so a caller can add a count.
  const fixedMessages = [];
  const fail = (group, message, scope = "group", ...error) => {
    const text = error.length ? `${message}: ${error[0]?.message ?? error[0]}` : message;
    const entry = { key: group?.key ?? null, name: group?.name || null, scope, message: text };
    report.failures.push(entry);
    fixedMessages.push(message);
    return entry;
  };
  const skipped = new Set();
  const skip = (tabIds) => {
    for (const tabId of tabIds) {
      if (skipped.has(tabId)) continue;
      skipped.add(tabId);
      report.skippedTabIds.push(tabId);
    }
  };
  const readTabs = async () =>
    (await api.tabs.query({ windowId })).map((t) => ({ ...t, groupId: Number.isInteger(t.groupId) ? t.groupId : NO_GROUP }));

  // 1. Re-check against a fresh snapshot: only tabs that are still loose and visible here go on.
  const snapshot = await snap(api, { windowId });
  const loose = new Set(snapshot.looseTabIds);
  for (const tabId of snapshot.splitTabIds) loose.delete(tabId);
  const tidyById = new Map(snapshot.tidyGroups.map((g) => [g.id, g]));
  const titleOf = new Map(snapshot.groups.map((g) => [g.id, g.title]));
  // Closing wins: a tab to close joins no group (validateApplyRequest has already taken it out of every one).
  const closeIds = [...new Set(Array.isArray(request?.close) ? request.close.filter(Number.isInteger) : [])];
  const closing = new Set(closeIds);
  const joins = [];
  const creates = [];
  for (const group of Array.isArray(request?.groups) ? request.groups : []) {
    const wanted = group.tabIds.filter((tabId) => !closing.has(tabId));
    // Closing alone left a new group too small: dropped, as validateApplyRequest drops it; nothing changed there.
    if (group.kind !== "existing" && wanted.length < MIN_NEW_GROUP_TABS && wanted.length < group.tabIds.length) continue;
    const tabIds = wanted.filter((tabId) => loose.has(tabId));
    skip(wanted.filter((tabId) => !loose.has(tabId)));
    if (group.kind === "existing") {
      if (!tidyById.has(group.groupId)) {
        fail(group, "The group is no longer a Zen Tidy group here; its tabs stay loose.");
        continue;
      }
      if (tabIds.length || group.rename) joins.push({ ...group, tabIds });
    } else if (tabIds.length >= MIN_NEW_GROUP_TABS) {
      creates.push({ ...group, tabIds });
    } else {
      fail(group, "Too few of its tabs are still loose; they stay loose.");
    }
  }
  // The tabs to close that this snapshot still lets close (header, "Closing"), less the last one when they are every
  // tab of the strip (the snapshot's unpinned tabs, as the journal's strip has them). Every tab ticked to close that
  // ends up open is counted in the tally, and reported once, at the end (noteClosing).
  const checks = pageChecks(request);
  const stripKeys = new Set(stripOf(snapshot).map((e) => e.key));
  const canClose = closableIn(snapshot, checks);
  const passing = closeIds.filter((tabId) => canClose(tabId));
  const lastTab = lastStripTab(snapshot.tabs, passing, stripKeys);
  const closes = passing.filter((tabId) => tabId !== lastTab);
  const tally = {
    refused: closeIds.length - passing.length, kept: passing.length - closes.length, notClosed: 0, error: undefined,
    handled: 0, closed: new Set(),
  };
  const noteClosing = () => {
    const { refused, kept, notClosed, error } = tally;
    if (refused) {
      const left = `${tabsText(refused)} to close changed since the preview and ${refused === 1 ? "was" : "were"} left alone.`;
      fail(null, left, "close").count = refused;
    }
    if (kept) {
      const left = `${tabsText(kept)} to close ${kept === 1 ? "was" : "were"} left open, so this Space keeps a tab for Undo.`;
      Object.assign(fail(null, left, "close"), { count: kept, code: "last-tab" });
    }
    if (notClosed) {
      const errors = error === undefined ? [] : [error];
      fail(null, `Could not close ${tabsText(notClosed)}`, "close", ...errors).count = notClosed;
    }
  };
  // Nothing will change, so keep the previous tidy's journal (and its undo).
  if (!joins.length && !creates.length && !closes.length) {
    noteClosing();
    return report;
  }

  // 2. Journal first: built now, written right before the first change (beginChanges). Each tab's address goes in
  // only as its fingerprint under this journal's own salt (header).
  const urlSalt = newUrlSalt();
  const affected = new Set([...joins, ...creates].flatMap((g) => g.tabIds));
  const journalTabs = snapshot.tabs.filter((t) => affected.has(t.id)).map((t) => ({
    id: t.id, entry: { key: t.key, urlHash: urlHash(urlSalt, t.url), index: t.index, groupId: NO_GROUP, to: null },
  }));
  // Each tab to close with its full address and title (the journal's one exception, header) and its neighbours in the
  // strip as it was before the change, so undo reopens it in its place.
  const unpinned = byIndex(snapshot.tabs.filter((t) => !t.pinned));
  const stripAt = new Map(unpinned.map((t, i) => [t.id, i]));
  const closedEntries = closes.map((tabId) => {
    const at = stripAt.get(tabId);
    const t = unpinned[at];
    return {
      id: tabId,
      entry: {
        key: t.key, url: t.url, title: t.title, index: t.index,
        before: unpinned[at - 1]?.key ?? null, after: unpinned[at + 1]?.key ?? null,
        groupId: tidyById.has(t.groupId) ? t.groupId : null,
      },
    };
  });
  // The tidy groups these closes empty (header, closedGroups): Zen removes a group with its last tab, and undo would
  // otherwise reopen its tabs loose, its name, icon and collapsed state gone. A group a join adds tabs to stays.
  const adding = new Set(joins.filter((g) => g.tabIds.length).map((g) => g.groupId));
  const closingNow = new Set(closes);
  const emptied = snapshot.tidyGroups
    .filter((g) => !adding.has(g.id))
    .filter((g) => {
      const members = snapshot.tabs.filter((t) => t.groupId === g.id);
      return members.length > 0 && members.every((t) => closingNow.has(t.id));
    })
    .map((g) => ({ groupId: g.id, title: titleOf.get(g.id), collapsed: Boolean(g.collapsed) }));
  const journal = {
    version: JOURNAL_VERSION,
    previewId: request.previewId ?? null,
    state: "applying",
    startedAt: now(),
    finishedAt: null,
    multiWindow: snapshot.windowCount > 1,
    urlSalt,
    strip: stripOf(snapshot),
    tabs: journalTabs.map(({ entry }) => entry),
    joins: joins.map((g) => ({
      groupId: g.groupId,
      collapsed: tidyById.get(g.groupId).collapsed,
      ...(g.rename ? { title: titleOf.get(g.groupId) } : {}),
    })),
    createdGroupIds: [],
    closed: closedEntries.map(({ entry }) => entry),
    ...(emptied.length ? { closedGroups: emptied } : {}),
    undoneAt: null,
    report: null,
  };
  // Tabs this apply put in a group, each with that group's id. A join's read-back drops a tab the browser left out
  // (later writes show `to: null`); orderGroups drops one missing from a new group, which only the final write
  // sees (its entry is left out). Every write copies this into the entries' `to`, so the journal never claims more.
  const grouped = new Map();
  const writeJournal = () => {
    for (const { id, entry } of journalTabs) entry.to = grouped.get(id) ?? null;
    return store.writeJournal(structuredClone(journal));
  };
  // The journal this apply's first write replaces: { journal } (null for none), read right before that write, or
  // null when it couldn't be read. An apply that ends up changing nothing after all puts it back (keepPrevious).
  let previous = null;
  // The first journal write, right before the first change; resolves to true when this call made it. If it fails,
  // nothing has changed yet.
  const beginChanges = async () => {
    if (changes.started) return false;
    previous = await readPrevious(store);
    try {
      await writeJournal();
    } catch (error) {
      throw new ApplyNotStartedError(error);
    }
    changes.started = true;
    return true;
  };

  const suspects = new Set(snapshot.glanceSuspectIds);
  const ctx = {
    api, windowId, report, fail, skip, readTabs, onOwnGroupChange, suspects, journal, writeJournal, beginChanges, grouped,
    snap, checks, stripKeys, delay,
  };

  // 3. Joins, then 4. new groups, one group at a time with a yield in between.
  for (const group of joins) {
    try {
      await joinGroup(ctx, group);
    } catch (error) {
      if (error instanceof ApplyNotStartedError) throw error;
      fail(group, "Could not add to the group", "group", error);
    }
    await yieldFn();
  }
  const created = [];
  for (const group of creates) {
    try {
      const made = await createGroup(ctx, group);
      if (made) created.push(made);
    } catch (error) {
      if (error instanceof ApplyNotStartedError) throw error;
      fail(group, "Could not create the group", "group", error);
    }
    await yieldFn();
  }
  // Every group failed its re-check before anything changed, and nothing is to be closed: keep the previous tidy's
  // journal (and its undo).
  if (!changes.started && !closedEntries.length) {
    noteClosing();
    return report;
  }

  // 5. Ordering (new groups only; existing groups keep their places).
  if (created.length) {
    try {
      await orderGroups(ctx, created, yieldFn);
    } catch (error) {
      fail(null, "Could not put the new groups in order", "order", error);
    }
  }

  // 6. Closing, last (header, "Closing"). Before the first change a throw means nothing changed; after it, the tabs
  // not handled yet are reported as not closed.
  if (closedEntries.length) {
    try {
      await closeTabs(ctx, closedEntries, tally, yieldFn);
    } catch (error) {
      if (error instanceof ApplyNotStartedError || !changes.started) throw error;
      tally.notClosed += closedEntries.length - tally.handled;
      tally.error ??= error;
    }
  }
  report.tabsClosed = tally.closed.size;
  noteClosing();
  // Every re-check failed before the first change: no journal was written.
  if (!changes.started) return report;

  // The first journal write landed, but every second re-check failed, so nothing was grouped, created, renamed or
  // closed after all: the previous tidy's journal (and its undo) goes back, as if this apply had written none.
  if (grouped.size === 0 && created.length === 0 && report.groupsRenamed === 0 && report.tabsClosed === 0 &&
    (await keepPrevious(store, previous))) {
    return report;
  }

  journal.state = "done";
  journal.finishedAt = now();
  journal.tabs = journalTabs.filter(({ id }) => grouped.has(id)).map(({ entry }) => entry);
  // Only the tabs really closed stay: undo reopens these, and a tab left open is no closed tab.
  journal.closed = closedEntries.filter(({ id }) => tally.closed.has(id)).map(({ entry }) => entry);
  // A group goes away only once every tab of it closed: one that kept a tab still stands, and undo rejoins it.
  const gone = emptied.filter((g) => closedEntries.every(({ id, entry }) => entry.groupId !== g.groupId || tally.closed.has(id)));
  if (gone.length) journal.closedGroups = gone;
  else delete journal.closedGroups;
  // A name-free copy: the journal must not hold model-chosen names or the browser's error text (header). The
  // returned report keeps both.
  journal.report = { ...report, failures: report.failures.map((f, i) => ({ ...f, name: null, message: fixedMessages[i] })) };
  try {
    await writeJournal();
  } catch (error) {
    fail(null, "Could not finish the undo record", "journal", error);
  }
  return report;
}

// The journal the first write is about to replace, as { journal } (null when there is none), or null when the store
// can't read it (the apply then writes its own as before).
async function readPrevious(store) {
  if (typeof store.readJournal !== "function") return null;
  try {
    return { journal: (await store.readJournal()) ?? null };
  } catch {
    return null;
  }
}

// Puts back the journal readPrevious found: rewritten as it was, or removed when there was none. Resolves to true when
// that went through; false (the caller then writes this apply's own journal) when it couldn't be read or written.
async function keepPrevious(store, previous) {
  if (!previous) return false;
  try {
    if (previous.journal !== null) await store.writeJournal(structuredClone(previous.journal));
    else if (typeof store.removeJournal === "function") await store.removeJournal();
    else return false;
    return true;
  } catch {
    return false;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The request's closeChecks (validateApplyRequest) as { salt, byTab: Map(tabId -> { urlHash, keep }) }, or null when
// it carries none (header, "Closing").
function pageChecks(request) {
  const checks = request?.closeChecks;
  if (!isObject(checks) || !Array.isArray(checks.tabs)) return null;
  const byTab = new Map();
  for (const check of checks.tabs) {
    if (isObject(check) && Number.isInteger(check.tabId) && !byTab.has(check.tabId)) byTab.set(check.tabId, check);
  }
  const activeTabId = Number.isInteger(checks.activeTabId) ? checks.activeTabId : null;
  return { salt: typeof checks.salt === "string" ? checks.salt : "", byTab, activeTabId };
}

// The re-check before closing (header, "Closing"), against one snapshot: whether tab `tabId` may still be closed, and,
// when its journal `entry` is given, still holds that entry's key and sits in its group (loose for null). `checks`
// (pageChecks, or null): for a tab with a check, the page it must still show, and for a duplicate its kept copy, open
// here on its own page (a tab without one, whose preview row had no fingerprint, has no page check; a malformed
// fingerprint never matches). The snapshot has already put a reopened tab's zt-reopen address in place of its
// about:blank, as the preview's did. With the preview's activeTabId, the tab right before (by index) an active loose
// tab other than that one stays open: a Glance tab is active and loose and sits right after its parent (M0), and one
// opened from a ticked tab since the preview (which takes activating that tab, so the active tab changed) would close
// with its parent, with no closed entry for undo. The active tab is a hard signal, unlike the Glance heuristics.
function closableIn(snapshot, checks) {
  const split = new Set(snapshot.splitTabIds);
  const tidy = new Set(snapshot.tidyGroups.map((g) => g.id));
  const byId = new Map(snapshot.tabs.map((t) => [t.id, t]));
  const strip = byIndex(snapshot.tabs);
  const opened = strip.findIndex((t) => t.active && !t.pinned && t.groupId === NO_GROUP && !split.has(t.id));
  const previewActive = checks?.activeTabId ?? null;
  const glanceParent = previewActive !== null && opened > 0 && strip[opened].id !== previewActive ? strip[opened - 1].id : null;
  const shows = (tab, hash) => Boolean(tab) && typeof hash === "string" && urlHash(checks.salt, tab.url) === hash;
  const samePage = (tabId) => {
    const check = checks?.byTab.get(tabId);
    if (!check) return true;
    if (!shows(byId.get(tabId), check.urlHash)) return false;
    if (check.keep === null) return true;
    const keepId = check.keep?.tabId;
    return Number.isInteger(keepId) && keepId !== tabId && shows(byId.get(keepId), check.keep.urlHash);
  };
  return (tabId, entry) => {
    const t = byId.get(tabId);
    if (!t || t.pinned || t.active || split.has(t.id) || !isWebUrl(t.url) || holdsKey(t.url)) return false;
    if (t.id === glanceParent) return false;
    if (t.groupId !== NO_GROUP && !tidy.has(t.groupId)) return false;
    if (entry !== undefined && (t.key !== entry.key || t.groupId !== (entry.groupId ?? NO_GROUP))) return false;
    return samePage(tabId);
  };
}

// The last of `ids` when closing all of them would leave no tab of the journal's strip (`stripKeys`) open and unpinned
// in `tabs` (one read of this Space), else null (header, "Closing").
function lastStripTab(tabs, ids, stripKeys) {
  if (!ids.length) return null;
  const closing = new Set(ids);
  return tabs.some((t) => !t.pinned && !closing.has(t.id) && stripKeys.has(t.key)) ? null : ids.at(-1);
}

// 6. The tabs to close, CLOSE_BATCH per tabs.remove, each batch re-checked against a fresh snapshot right before it,
// with a yield between batches (header, "Closing"). When nothing changed before (a request that only closes tabs) the
// journal's first write comes right before the first tabs.remove, and the batch is then checked once more, so the
// re-check stays the last thing before the change. `tally` ({ refused, kept, notClosed, error, handled, closed }) is
// filled as it goes, so a throw partway still leaves what was done: `handled` counts the entries settled either way.
async function closeTabs(ctx, entries, tally, yieldFn) {
  const { api, windowId, snap, beginChanges, checks, stripKeys, delay } = ctx;
  // The batch's entries that may still close, less `held`, the one kept open as the strip's last tab (or null).
  const recheck = async (batch) => {
    const fresh = await snap(api, { windowId });
    const canClose = closableIn(fresh, checks);
    const passing = batch.filter(({ id, entry }) => canClose(id, entry));
    const held = lastStripTab(fresh.tabs, passing.map(({ id }) => id), stripKeys);
    return { live: passing.filter(({ id }) => id !== held), held };
  };
  const stillOpen = async (ids) => {
    const open = await Promise.all(ids.map((id) => api.tabs.get(id).then(() => true, () => false)));
    return ids.filter((_, i) => open[i]);
  };
  for (let start = 0; start < entries.length; start += CLOSE_BATCH) {
    if (start > 0) await yieldFn();
    const batch = entries.slice(start, start + CLOSE_BATCH);
    let checked = await recheck(batch);
    if (checked.live.length && (await beginChanges())) checked = await recheck(batch);
    const { live, held } = checked;
    if (held !== null) tally.kept++;
    tally.refused += batch.length - live.length - (held === null ? 0 : 1);
    tally.handled += batch.length - live.length;
    if (!live.length) continue;
    const ids = live.map(({ id }) => id);
    try {
      await api.tabs.remove(ids);
    } catch (error) {
      tally.error ??= error;
    }
    // tabs.remove may stop partway, or leave a tab open; tabs.get fails for a closed tab, in any Space. One that still
    // reads open may only be in Zen's close animation, so it is read once more after a real wait (header).
    let open = await stillOpen(ids);
    if (open.length) {
      try {
        await delay(CLOSE_SETTLE_MS);
      } catch {
        // A wait that fails only means the second read comes sooner.
      }
      open = await stillOpen(open);
    }
    for (const id of ids) {
      if (open.includes(id)) tally.notClosed++;
      else tally.closed.add(id);
    }
    tally.handled += ids.length;
  }
}

// A join adds tabs to an existing tidy group and/or renames it. Zen expands a collapsed group synchronously when
// a tab is added (M0), so the state is read first, the suppression window opened, and the group re-collapsed.
async function joinGroup(ctx, group) {
  const { api, windowId, report, fail, skip, readTabs, onOwnGroupChange, beginChanges, grouped, journal } = ctx;
  // The re-check: the group's fresh info and the request's tabs that are still loose, or null (reported) when the
  // group is gone or no longer a tidy group here.
  const recheck = async () => {
    let info;
    try {
      info = await api.tabGroups.get(group.groupId);
    } catch {
      fail(group, "The group is gone; its tabs stay loose.");
      return null;
    }
    // Read last, so nothing is awaited between this re-check and tabs.group except the suppression callback.
    const tabs = await readTabs();
    const members = tabs.filter((t) => t.groupId === group.groupId);
    const stillTidy = isTidyTitle(info.title) && info.color !== FOLDER_COLOR && info.windowId === windowId &&
      members.length > 0 && members.every((t) => !t.pinned);
    if (!stillTidy) {
      fail(group, "The group is no longer a Zen Tidy group here; its tabs stay loose.");
      return null;
    }
    const byId = new Map(tabs.map((t) => [t.id, t]));
    return { info, tabIds: group.tabIds.filter((tabId) => isLooseTab(byId.get(tabId))) };
  };
  let checked = await recheck();
  // The apply's first change writes the journal first; the group is then checked again, so the re-check stays the
  // last thing before it is touched.
  if (checked && (checked.tabIds.length || group.rename) && (await beginChanges())) checked = await recheck();
  if (!checked) return;
  const { info, tabIds } = checked;
  skip(group.tabIds.filter((tabId) => !tabIds.includes(tabId)));
  if (!tabIds.length && !group.rename) return;

  await onOwnGroupChange(group.groupId);
  if (tabIds.length) {
    const collapsed = Boolean(info.collapsed);
    let sent;
    try {
      sent = await groupWithRetry(ctx, tabIds, (ids) => ({ tabIds: ids, groupId: group.groupId }), (live) => live);
      // Counted as grouped as soon as tabs.group went through, like createGroup does: if the re-collapse or the
      // readback below throws, the tabs are most likely in the group, and the final journal must list them for undo.
      for (const tabId of sent ?? []) grouped.set(tabId, group.groupId);
    } finally {
      if (collapsed) await api.tabGroups.update(group.groupId, { collapsed: true });
    }
    if (sent) {
      // M0: a "successful" call can leave a tab out (a split tab, say), so membership is read back.
      const after = new Map((await readTabs()).map((t) => [t.id, t]));
      const added = sent.filter((tabId) => after.get(tabId)?.groupId === group.groupId);
      skip(sent.filter((tabId) => !added.includes(tabId)));
      for (const tabId of sent) if (!added.includes(tabId)) grouped.delete(tabId);
      if (added.length) {
        report.groupsJoined++;
        report.tabsGrouped += added.length;
      }
    } else {
      fail(group, "None of its tabs could be added.");
    }
  }
  if (!group.rename) return;
  // An icon-only change keeps the name exactly as Zen shows it (it may be longer than 32 characters, or hold
  // emoji); a new name was already cleaned and capped by validateApplyRequest at max(32, the old name's length).
  const title = group.nameChanged === false
    ? withIcon(info.title, group.icon)
    : makeTitle(group.name, group.icon, Number.MAX_SAFE_INTEGER);
  try {
    await api.tabGroups.update(group.groupId, { title });
    // Hashed from the title just sent (fresh from the re-check for an icon-only change, not the snapshot's), and
    // only once it went through: a rename that failed left nothing for undo to put back.
    const entry = journal.joins.find((j) => j.groupId === group.groupId);
    if (entry) entry.titleHash = fnv1a32(title);
    report.groupsRenamed++;
  } catch (error) {
    fail(group, "Could not rename the group", "group", error);
  }
}

// Puts a safe anchor first: tabs.group places a new group at tabIds[0], and the active tab or a possible Glance
// tab must never be that anchor (grouping a Glance tab as the anchor breaks it). Returns null when none is safe.
function anchorFirst(tabIds, tabs, suspects) {
  const risky = new Set([...suspects, ...glanceSuspects(tabs), ...tabs.filter((t) => t.active).map((t) => t.id)]);
  const anchor = tabIds.find((tabId) => !risky.has(tabId));
  return anchor === undefined ? null : [anchor, ...tabIds.filter((tabId) => tabId !== anchor)];
}

async function createGroup(ctx, group) {
  const {
    api, windowId, report, fail, readTabs, onOwnGroupChange, suspects, journal, writeJournal, beginChanges, grouped, skip,
  } = ctx;
  const arrange = (live, tabs) => (live.length >= MIN_NEW_GROUP_TABS ? anchorFirst(live, tabs, suspects) : null);
  // The re-check: the request's tabs that are still loose, and those arranged with a safe anchor first (or null).
  const recheck = async () => {
    const tabs = await readTabs();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const live = group.tabIds.filter((tabId) => isLooseTab(byId.get(tabId)));
    return { live, tabIds: arrange(live, tabs) };
  };
  let { live, tabIds } = await recheck();
  // The apply's first change writes the journal first; the tabs are then read again, so the re-check stays the
  // last thing before tabs.group.
  if (tabIds && (await beginChanges())) ({ live, tabIds } = await recheck());
  skip(group.tabIds.filter((tabId) => !live.includes(tabId)));
  if (!tabIds) {
    fail(group, live.length < MIN_NEW_GROUP_TABS
      ? "Too few of its tabs are still loose; they stay loose."
      : "No tab can safely start the group (the active tab and possible Glance tabs can't); they stay loose.");
    return null;
  }

  let groupId;
  const sent = await groupWithRetry(ctx, tabIds, (ids) => ({ tabIds: ids, createProperties: { windowId } }), arrange, (id) => {
    groupId = id;
  });
  if (!sent) {
    fail(group, "Its tabs changed before they could be grouped; they stay loose.");
    return null;
  }
  for (const tabId of sent) grouped.set(tabId, groupId);
  // An untitled new group looks exactly like a split view (M0), so its id is recorded before anything else.
  journal.createdGroupIds.push(groupId);
  try {
    await writeJournal();
  } catch (error) {
    fail(group, "Could not record the new group for undo", "journal", error);
  }
  report.groupsCreated++;
  // Two separate steps: a failing suppression hook must not cost the group its title, or it would stay untitled
  // and look like a split view from then on.
  try {
    await onOwnGroupChange(groupId);
  } catch (error) {
    fail(group, "Could not mark the change as Zen Tidy's own", "group", error);
  }
  try {
    await api.tabGroups.update(groupId, { title: makeTitle(group.name, group.icon) });
  } catch (error) {
    fail(group, "The group was created but could not be named", "group", error);
  }
  return { key: group.key, name: group.name, id: groupId, tabIds: sent, placeAfterGroupId: group.placeAfterGroupId ?? null };
}

// tabs.group, retried once after a throw (most likely a tab closed in between): the tabs are re-read, ids that
// are no longer loose are dropped, and `arrange` rebuilds the list (or returns null to give up).
// Resolves to the tab ids of the call that went through, or null.
async function groupWithRetry(ctx, tabIds, props, arrange, onGroupId = () => {}) {
  const { api, readTabs, skip } = ctx;
  try {
    onGroupId(await api.tabs.group(props(tabIds)));
    return tabIds;
  } catch {
    const tabs = await readTabs();
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const live = tabIds.filter((tabId) => isLooseTab(byId.get(tabId)));
    skip(tabIds.filter((tabId) => !live.includes(tabId)));
    const retry = live.length ? arrange(live, tabs) : null;
    if (!retry) return null;
    onGroupId(await api.tabs.group(props(retry)));
    return retry;
  }
}

// New groups without a usable placeAfterGroupId stack at the top of the loose area in display order: moved in
// reverse, each to the lowest unpinned index, re-read before every move. A group with one goes right after that
// group; several after the same group keep their display order. Misplacement is reported, never fatal.
async function orderGroups(ctx, created, yieldFn) {
  const { api, windowId, report, fail, skip, readTabs, suspects, grouped } = ctx;
  let tabs = await readTabs();
  // Count what really ended up in each new group.
  for (const group of created) {
    const inGroup = new Set(tabs.filter((t) => t.groupId === group.id).map((t) => t.id));
    const missing = group.tabIds.filter((tabId) => !inGroup.has(tabId));
    skip(missing);
    for (const tabId of missing) grouped.delete(tabId);
    report.tabsGrouped += group.tabIds.length - missing.length;
  }
  const present = new Set(tabs.map((t) => t.groupId));
  const createdIds = new Set(created.map((g) => g.id));
  const anchored = (g) => g.placeAfterGroupId !== null && present.has(g.placeAfterGroupId) && !createdIds.has(g.placeAfterGroupId);
  const top = created.filter((g) => !anchored(g));
  const after = created.filter(anchored);
  const failed = new Set();

  const move = async (group, anchorId) => {
    try {
      const index = groupMoveIndex(tabs, group.id, anchorId, suspects);
      if (index === null) throw new Error("the group or its anchor is gone");
      const first = Math.min(...tabs.filter((t) => t.groupId === group.id).map((t) => t.index));
      if (first !== index) await api.tabGroups.move(group.id, { index, windowId });
    } catch (error) {
      failed.add(group.key);
      fail(group, "Could not move the group into place", "order", error);
    }
    await yieldFn();
  };

  for (const group of [...top].reverse()) {
    await move(group, null);
    tabs = await readTabs();
  }
  const lastAfter = new Map();
  for (const group of after) {
    const anchorId = lastAfter.get(group.placeAfterGroupId) ?? group.placeAfterGroupId;
    await move(group, anchorId);
    tabs = await readTabs();
    if (!failed.has(group.key) && !followsDirectly(tabs, group.id, anchorId)) {
      failed.add(group.key);
      fail(group, "The group did not land right after the group it belongs after.", "order");
    }
    // Only a group that landed becomes the next one's anchor: chained onto a misplaced group, the next one would
    // verify against the wrong place. It goes after the real anchor (or the last group that landed) instead.
    if (!failed.has(group.key)) lastAfter.set(group.placeAfterGroupId, group.id);
  }

  const order = groupsAtTop(tabs, top.length, suspects);
  top.forEach((group, i) => {
    if (order[i] !== group.id && !failed.has(group.key)) {
      fail(group, "The group is not in its place at the top of the loose tabs.", "order");
    }
  });
}
