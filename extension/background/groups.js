// The groups view's actions and their own one-step undo: listGroups, groupAction and undoGroupAction.
// Rules: notes/m4-contracts.md, "Group actions" (binding); notes/m3-contracts.md with its "As built" sections (tab
// matching, the reopen path and the M3 spike rules); implementation-notes (Space scope, split views, the tabs.ungroup,
// tabs.move, tabs.create and tabGroups.move facts, Glance, collapsed state). The browser comes in as `api` and storage
// as `store`. The router runs every call here under the shared lock (tidy / apply / undo / group actions).
//
// Re-checks. The groups view stays open while the person looks at it, so every action asks the browser again right
// before each call: the group must still be a tidy group in this window's current Space (SIG title, not a Zen folder,
// a tab visible here, every tab unpinned), and only tabs the current tabs.query({ windowId }) returned reach a tab
// API. A tidy group's own tabs are never in a split: a tab is in one group, and a split is an untitled group of its
// own, so a tab put in a split meanwhile has left the tidy group and is never touched.
//
// Close all closes the tabs the journal lists, as apply closes Extras (apply.js, "Closing"): CLOSE_BATCH per
// tabs.remove from the group's end, each batch cut once from the journal's list (never from the live group, whose
// tabs can still be listed while Zen closes them) and re-checked against a fresh snapshot right before its call, with
// a yield between batches. What closed is read back with tabs.get (it works in every Space and fails for a closed
// tab); tabs.remove need not wait for Zen's close animation, and a page can ask before it unloads, so a tab that
// still reads open is read once more after CLOSE_SETTLE_MS. Every tab sent to tabs.remove keeps its closed entry,
// even one that still reads open: undo skips an entry whose key is on a visible tab, so in doubt the entry stays. A
// tab that was never sent (the re-check refused it) leaves the journal, and a title-only entry (a tab Undo can't
// reopen) stays only for a tab that reads closed, since nothing at undo time could tell it is still open. One more
// rule keeps Undo possible, as apply's "last-tab" does: undo finds the changed Space by an unpinned tab holding a key
// the journal knows (undoGroupAction, "The Space check"), so when closing a batch would leave none open here, the
// batch's last http(s) tab stays open (code "last-tab") and keeps its closed entry, which undo then finds the Space
// by and skips; but only while another tab Undo can reopen is closed with it, since otherwise holding it protects
// nothing: then it closes too, and the journal, which no undo could find this Space for, goes. And closing never
// takes the window's last tab in view: one stays, an http(s) one when it can ("last-tab" again; alone, a refusal).
// When no http(s) tab is sent at all, the journal can reopen nothing and goes (below). The tabs Undo can't reopen are
// named before any closes (confirm-needed), and the confirmation counts only for the tabs it named, by id.
//
// Group journal (store.readGroupJournal / writeGroupJournal: storage.local.groupJournal). One step, in a slot of its
// own: nothing here reads or writes the tidy journal (store.readJournal / writeJournal / removeJournal), and a tidy
// apply or undo never touches this one. Only ungroup, closeAll and removeAll write it: right before their first
// change, and once more when done. A new one replaces it; one that ends up changing nothing puts the previous one
// back (removeGroupJournal when there was none), so it never costs the last group action its undo. A close all that
// sent no tab Undo could reopen (none on an http(s) page) to tabs.remove removes its own instead of finishing it:
// there is nothing for an undo to put back, and an Undo offer would only be refused.
//   {
//     version: 1,
//     type: "ungroup" | "closeAll" | "removeAll",
//     at,                     // ms, when the action started
//     finishedAt,             // ms, set by the second write; null while the action runs, or if Zen cut it short
//     state: "done" | "undone", // "done" from the first write, so an action Zen cut short can be undone too
//     urlSalt,                // 8 random hex digits, fresh for every journal (shared/hash.js newUrlSalt)
//     groups: [{              // strip order
//       groupId,              // the group's id: an undo after an action cut short puts the rest back into what is
//                             // left of it. An undo that has to make the group again writes the new id here, with
//       recreated?,           // recreated: true, before it titles it: an untitled new group looks exactly like a
//                             // split view (M0), and a retry must find it.
//       title,                // the full title, markers included, so it comes back exactly
//       collapsed,
//       position: { beforeKey, afterKey }, // the first visible tab after the group (null: the end of the strip) and
//                             // the last unpinned tab before it (null: the top of the loose area). Undo puts the group
//                             // right before the first, else right after the second; both prove the Space.
//       tabs: [{ key, urlHash }],          // ungroup / removeAll: keys and fingerprints only, in strip order
//                             // (urlHash = fnv1a32(urlSalt + url), as in the tidy journal v3)
//       closed: [...],        // closeAll, in strip order: { key, url, title, index, before, after } for an http(s) tab
//                             // (the full URL is the reopen exception; before/after are its strip neighbours' keys,
//                             // which the reopen path anchors on), and { title } for any other tab, which undo can't
//                             // reopen. That title is "" when it holds the tab's address (an untitled page's title is
//                             // its address, a local path for a file): no other address goes in a journal. The first
//                             // write lists every tab of the group; the last keeps those "Close all" (above) keeps.
//     }],
//   }
// Undo spends it: { version, type, at, finishedAt, state: "undone", undoneAt, undoReport }, where undoReport has
// counts and each failure's scope, code and count only. No salt, key, fingerprint, URL or title is left.
//
// How undo finds the tabs. Ungroup and removeAll leave the tabs loose where they were. Undo finds each journal tab
// as tidy undo does, by key with a strong or weak match (planUndo, on a stand-in journal that says every tab went
// into this group: a tab still loose or already in what is left of the group is "as left", one the person has put
// in another group, pinned or put in a split is "moved" and listed, never touched). Close all's tabs come back
// through tidy undo's own reopen path (undoTidy, on a stand-in journal holding only those closed entries, with a
// scratch store, so its writes never reach either journal): live, then discarded, under the M3 spike rules (the 5 s
// guard, zt-reopen, the anchor check), at their old places. Reopened tabs keep their old keys, so they are found
// the same way afterwards. The tabs found are grouped again (a safe tab first: never the open tab or a possible
// Glance tab), get the exact title back, move to their old place and get their collapsed state back.

import { takeSnapshot, FOLDER_COLOR } from "./snapshot.js";
import { makeTitle, withIcon, isTidyTitle, parseTitle, cleanVisibleName, MAX_NAME_LENGTH } from "./markers.js";
import { groupMoveIndex, CLOSE_BATCH, CLOSE_SETTLE_MS } from "./apply.js";
// unsafeOf: the tabs that never anchor a group, a move or a create (implementation-notes, Glance: user-approved):
// the open tab, the Glance suspects and the Glance of an Essential, by undo's own rule.
import { planUndo, undoTidy, unsafeOf, UndoNotStartedError, UndoIncompleteError, MOVE_BATCH } from "./undo.js";
import { holdsKey } from "./store.js";
import { FALLBACK_NAME } from "./plan.js";
import { MAX_EDIT_STRING } from "./preview.js";
import { ICONS, iconIndex } from "../shared/icons.js";
import { urlHash, newUrlSalt } from "../shared/hash.js";

export const GROUP_JOURNAL_VERSION = 1;
const ACTIONS = new Set(["rename", "icon", "collapse", "ungroup", "closeAll", "removeAll"]);
const UNDOABLE = new Set(["ungroup", "closeAll", "removeAll"]);
const NO_GROUP = -1;

// Fallback texts by code; the router answers with its own and the popup words most of them itself.
const ACTION_MESSAGES = Object.freeze({
  "invalid-request": "Zen Tidy couldn't read that request.",
  "not-found": "That group isn't one of Zen Tidy's groups in this Space any more.",
  "wrong-space": "Switch to the Space with this group, then try again.",
  "confirm-needed": "Undo can't reopen some of these tabs. Confirm to close them anyway.",
  // Only ever answered when nothing changed (a call that may have changed something is read back and reported).
  "action-failed": "Zen didn't make that change. Try again.",
  // Close all on a group that is every tab left in the window: its last tab stays, so nothing was closed.
  "last-tab": "Zen Tidy keeps the last tab in this Space open.",
});
// The most tab ids a Close all confirmation may carry back (the tabs it named).
const MAX_CONFIRM_IDS = 1000;
const REMOVE_ALL_CONFIRM = "Confirm to remove every Zen Tidy group in this Space.";
const UNDO_MESSAGES = Object.freeze({
  "invalid-request": "Zen Tidy couldn't tell which window to undo in.",
  "no-journal": "There is no group change to undo.",
  "wrong-space": "Switch to the Space you changed, then Undo.",
  "nothing-to-undo": "Those tabs aren't open here. Undo works again if they come back.",
  "undo-failed": "Undo didn't finish. Some tabs may already be back. Try Undo again.",
});

const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));
const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const list = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isKey = (value) => typeof value === "string" && value !== "";
const keyOrNull = (value) => (isKey(value) ? value : null);
const isWebUrl = (url) => typeof url === "string" && /^https?:\/\//i.test(url);
// A tab Undo can reopen: on an http(s) page whose address holds no key-shaped string (the journal scrubs one, so undo
// would open another address: store.js holdsKey). Any other is journaled by title only and named before Close all.
const isReopenable = (url) => isWebUrl(url) && !holdsKey(url);
const errorText = (error) => error?.message ?? String(error);
const byIndex = (tabs) => [...tabs].sort((a, b) => a.index - b.index);
const isLoose = (tab) => Boolean(tab) && !tab.pinned && tab.groupId === NO_GROUP;
const refuse = (code, extra = {}) => ({ error: code, message: ACTION_MESSAGES[code], ...extra });
const refuseUndo = (code, extra = {}) => ({ error: code, message: UNDO_MESSAGES[code], ...extra });

// tabs.query follows the active Space: a read with no tab undo knows to be in the changed Space means the person
// switched Space meanwhile.
class SpaceChangedError extends Error {
  constructor() {
    super("the Space changed");
    this.name = "SpaceChangedError";
  }
}

// listGroups(snapshot): the tidy groups in the snapshot's Space (takeSnapshot keeps only groups with a visible tab,
// whose tabs are all unpinned, that are not Zen folders), in strip order, as the groups view shows them:
// [{ id, name, icon, collapsed, tabCount, nonReopenable }]. nonReopenable counts the tabs a close all couldn't bring
// back: any that isn't on an http(s) page (a tab undo reopened reads as its page, takeSnapshot's zt-reopen rule), or
// whose address holds a key-shaped string (isReopenable).
export function listGroups(snapshot) {
  const byId = new Map(list(snapshot?.tabs).map((t) => [t.id, t]));
  return list(snapshot?.tidyGroups)
    .map((group) => ({ group, members: list(group.tabIds).map((id) => byId.get(id)).filter(Boolean) }))
    .filter(({ members }) => members.length > 0)
    .map((row) => ({ ...row, first: Math.min(...row.members.map((t) => t.index)) }))
    .sort((a, b) => a.first - b.first)
    .map(({ group, members }) => ({
      id: group.id,
      name: group.name,
      icon: group.icon,
      collapsed: Boolean(group.collapsed),
      tabCount: members.length,
      nonReopenable: members.filter((t) => !isReopenable(t.url)).length,
    }));
}

// ---------------------------------------------------------------------------------------------------------------
// Shared plumbing

function context(api, options) {
  const {
    windowId, store, now = Date.now, yieldFn = defaultYield, onOwnGroupChange = () => {}, snapshot = takeSnapshot,
    waitReady, createTimeoutMs, delay = defaultDelay,
  } = options;
  const ctx = {
    api, windowId, store, now, yieldFn, onOwnGroupChange, snap: snapshot, waitReady, createTimeoutMs, delay,
    failures: [],
    // A change reached the browser (a call that went through, or might have).
    changed: false,
    // Undo: a group it could not put back because a call threw, so the journal is kept for Undo again.
    unfinished: false,
    // Undo: the journal learned something Undo again needs (keepForRetry writes it).
    journalChanged: false,
    // Undo: unpinned tabs known to be in the changed Space (readHere), and each tab key's id.
    known: new Set(),
    keyToId: new Map(),
    // Failure entries never name a tab or group; the browser's error text goes only into what is returned. `code`
    // marks a failure the popup may word itself ("last-tab").
    fail(scope, message, count, error, code) {
      ctx.failures.push({
        message: error === undefined ? message : `${message}: ${errorText(error)}`,
        scope,
        ...(typeof code === "string" ? { code } : {}),
        ...(Number.isInteger(count) && count > 0 ? { count } : {}),
      });
    },
    async readTabs() {
      return list(await api.tabs.query({ windowId })).map((t) => ({
        ...t, groupId: Number.isInteger(t.groupId) ? t.groupId : NO_GROUP, pinned: Boolean(t.pinned),
      }));
    },
    // readTabs for undo, which acts on what it sees: the read must still show the Space it is undoing in.
    async readHere() {
      const tabs = await ctx.readTabs();
      if (tabs.some((t) => !t.pinned && ctx.known.has(t.id))) return tabs;
      throw new SpaceChangedError();
    },
  };
  return ctx;
}

// The suppression window (collapsed-state attribution), opened before every change to a group. A failing hook only
// costs the attribution, never the change itself.
async function suppress(ctx, groupId) {
  try {
    await ctx.onOwnGroupChange(groupId);
  } catch (error) {
    ctx.fail("group", "Could not mark a change as Zen Tidy's own", undefined, error);
  }
}

// The group as it is right now, from a fresh tabGroups.get and tabs.query: { info, members (strip order), tabs }, or
// { error }: "not-found" when it is gone, no longer a tidy group or in another window, "wrong-space" when it has no
// tab visible here (tabGroups.get answers for every Space).
async function recheck(ctx, groupId) {
  let info;
  try {
    info = await ctx.api.tabGroups.get(groupId);
  } catch {
    return { error: "not-found" };
  }
  const tabs = await ctx.readTabs();
  const members = byIndex(tabs.filter((t) => t.groupId === groupId));
  if (!isTidyTitle(info?.title) || info.color === FOLDER_COLOR || info.windowId !== ctx.windowId) return { error: "not-found" };
  if (!members.length) return { error: "wrong-space" };
  if (members.some((t) => t.pinned)) return { error: "not-found" };
  return { info, members, tabs };
}

// ---------------------------------------------------------------------------------------------------------------
// groupAction

// groupAction(api, action, { windowId, store, now, yieldFn, onOwnGroupChange, snapshot, delay }).
// - action: { action, groupId?, name?, icon?, collapsed?, confirm?, confirmTabIds? }, the router's cleaned
//   groupAction message (notes/m4-contracts.md, "Group actions"); checked again here, since it comes from a page.
// - Resolves to the report, or to a refusal { error, message, nonReopenable?, nonReopenableIds? }: "invalid-request",
//   "not-found", "wrong-space", "confirm-needed" (closeAll on a group holding tabs Undo can't reopen, with their
//   current titles and their ids; removeAll, always, until sent with confirm: true), "last-tab" (closeAll on a group
//   that is every tab in view in the window: its last tab stays, so nothing closed) or "action-failed" (nothing
//   changed). A Close all is confirmed only for the tabs it named: sent with confirm: true and confirmTabIds holding
//   the ids of every tab Undo couldn't reopen in the group now, else it answers confirm-needed again with the new list,
//   so a tab that joined the group (or turned into one Undo can't reopen) after the list was shown is never closed
//   unnamed (SPEC F4).
// - Report: { action, undoable, groupCount, tabCount, failures: [{ message, scope, count? }] }, plus groupId, name,
//   icon and changed for rename and icon, groupId, collapsed and changed for collapse, and nonReopenable (how many
//   closed tabs Undo can't bring back) for closeAll. failures: [{ message, scope, code?, count? }], scope "ungroup",
//   "close", "group" or "journal"; code "last-tab" for the tab close all keeps open (header, "Close all").
//   An undoable action that changed something resolves to its report even when some calls failed (a tabs.remove
//   that went through counts as a change, even if every tab still reads open). undoable is false for a close all
//   that closed no tab Undo could reopen (header: it leaves no journal).
// - store: { readGroupJournal, writeGroupJournal, removeGroupJournal? }, used only by the undoable actions.
//   onOwnGroupChange(groupId): the suppression window, awaited before every change to a group. snapshot: (api,
//   { windowId }) => Snapshot, and delay: (ms) => Promise, the wait before a tab that still reads open is read again
//   (header, "Close all"); both for tests.
export async function groupAction(api, action, options = {}) {
  const ctx = context(api, options);
  const request = checkRequest(action);
  if (!request || !Number.isInteger(ctx.windowId) || ctx.windowId < 0) return refuse("invalid-request");
  try {
    if (request.action === "rename" || request.action === "icon") return await retitle(ctx, request);
    if (request.action === "collapse") return await collapse(ctx, request);
    return await runUndoable(ctx, request);
  } catch {
    // Only reads before the journal's first write throw past here: every change handles its own failure, and
    // runUndoable catches what throws once its journal is written.
    return refuse("action-failed");
  }
}

// The action's own fields, checked; null when it is unknown or one it needs is missing or malformed. A name's length
// is checked against the group's current name later (a long one Zen allows may come back unchanged).
function checkRequest(action) {
  if (!isObject(action) || !ACTIONS.has(action.action)) return null;
  const confirm = action.confirm === true;
  if (action.action === "removeAll") return { action: "removeAll", confirm };
  if (!Number.isInteger(action.groupId) || action.groupId < 0) return null;
  const base = { action: action.action, groupId: action.groupId, confirm };
  if (action.action === "closeAll") return { ...base, confirmTabIds: confirmIds(action.confirmTabIds) };
  if (action.action === "rename") return typeof action.name === "string" ? { ...base, name: action.name } : null;
  if (action.action === "icon") return iconIndex(action.icon) >= 0 ? { ...base, icon: ICONS[iconIndex(action.icon)] } : null;
  if (action.action === "collapse") return typeof action.collapsed === "boolean" ? { ...base, collapsed: action.collapsed } : null;
  return base;
}

// The tab ids a Close all confirmation carries back: whole numbers >= 0, each once, at most MAX_CONFIRM_IDS; [] for
// anything else.
export function confirmIds(value) {
  return Array.isArray(value) ? [...new Set(value.filter((id) => Number.isInteger(id) && id >= 0))].slice(0, MAX_CONFIRM_IDS) : [];
}

// rename: a new name is cleaned and capped as a preview rename is (markers, invisible characters and emoji go; at
// most 32 characters, or the current name's length when that is longer; "Group" when nothing is left), and keeps the
// group's icon; the current name sent back unchanged is no change. icon: the same title with only its icon code
// swapped (withIcon), so the name stays exactly as Zen shows it. Neither is undoable (both reversible by hand).
async function retitle(ctx, request) {
  const { api } = ctx;
  const check = await recheck(ctx, request.groupId);
  if (check.error) return refuse(check.error);
  const { title: old } = check.info;
  const current = parseTitle(old);
  let title = old;
  if (request.action === "icon") {
    title = withIcon(old, request.icon);
  } else if (request.name !== current.name) {
    if (request.name.length > MAX_EDIT_STRING) return refuse("invalid-request");
    const maxLength = Math.max(MAX_NAME_LENGTH, [...current.name].length);
    title = makeTitle(cleanVisibleName(request.name, maxLength) || FALLBACK_NAME, current.icon, Number.MAX_SAFE_INTEGER);
  }
  const changed = title !== old;
  if (changed) {
    await suppress(ctx, request.groupId);
    try {
      await api.tabGroups.update(request.groupId, { title });
    } catch {
      return refuse("action-failed");
    }
  }
  const shown = parseTitle(title);
  return {
    action: request.action, undoable: false, groupCount: changed ? 1 : 0, tabCount: 0, groupId: request.groupId,
    name: shown.name, icon: shown.icon, changed, failures: ctx.failures,
  };
}

// collapse: the collapsed flag, with the suppression window opened first (a user collapse and an API collapse look
// alike in onUpdated). Not undoable.
async function collapse(ctx, request) {
  const check = await recheck(ctx, request.groupId);
  if (check.error) return refuse(check.error);
  const changed = Boolean(check.info.collapsed) !== request.collapsed;
  if (changed) {
    await suppress(ctx, request.groupId);
    try {
      await ctx.api.tabGroups.update(request.groupId, { collapsed: request.collapsed });
    } catch {
      return refuse("action-failed");
    }
  }
  return {
    action: "collapse", undoable: false, groupCount: changed ? 1 : 0, tabCount: 0, groupId: request.groupId,
    collapsed: request.collapsed, changed, failures: ctx.failures,
  };
}

// ungroup, closeAll and removeAll: the journal from a snapshot (keys, fingerprints, neighbours) and a fresh re-check
// of every group, written right before the first change; then each group in turn, with a yield between; then the
// journal once more.
async function runUndoable(ctx, request) {
  const { api, windowId, store, now } = ctx;
  if (request.action === "removeAll" && !request.confirm) return refuse("confirm-needed", { message: REMOVE_ALL_CONFIRM });
  const snapshot = await ctx.snap(api, { windowId });
  const groupIds = request.action === "removeAll" ? listGroups(snapshot).map((g) => g.id) : [request.groupId];
  if (!groupIds.length) return refuse("not-found");

  const urlSalt = newUrlSalt();
  const items = [];
  let refusal = null;
  for (const groupId of groupIds) {
    const check = await recheck(ctx, groupId);
    if (check.error) {
      refusal ??= check.error;
      continue;
    }
    // Close all fills sent (the ids passed to tabs.remove, as the calls go out, so a close that throws partway still
    // leaves the journal what it sent), kept (the tab kept open as the Space's last) and unprovable (closing left no
    // tab here undo could find this Space by).
    items.push({ groupId, sent: [], kept: [], unprovable: false, ...journalGroup(snapshot, check, request.action, urlSalt) });
  }
  if (!items.length || (request.action !== "removeAll" && refusal)) return refuse(refusal ?? "not-found");
  // Close all is confirmed only for the tabs Undo can't reopen that the confirmation named, by id (groupAction).
  if (request.action === "closeAll") {
    const ids = items.flatMap((item) => item.nonWebIds);
    const named = new Set(request.confirm ? request.confirmTabIds : []);
    if (ids.some((id) => !named.has(id))) {
      return refuse("confirm-needed", { nonReopenable: items.flatMap((item) => item.nonWebTitles), nonReopenableIds: ids });
    }
  }

  const journal = {
    version: GROUP_JOURNAL_VERSION, type: request.action, at: now(), finishedAt: null, state: "done", urlSalt,
    groups: items.map((item) => item.entry),
  };
  // The journal this one replaces, to put back if nothing changes after all: { journal } (null for none), or null
  // when it can't be read.
  const previous = await readPrevious(store);
  try {
    await store.writeGroupJournal(structuredClone(journal));
  } catch {
    return refuse("action-failed");
  }

  const closing = request.action === "closeAll";
  const report = { action: request.action, undoable: true, groupCount: 0, tabCount: 0, failures: ctx.failures };
  if (closing) report.nonReopenable = 0;
  let lastRefusal = null;
  try {
    for (const [n, item] of items.entries()) {
      if (n > 0) await ctx.yieldFn();
      const result = closing ? await closeGroup(ctx, item) : await ungroupGroup(ctx, item);
      if (result.refusal) lastRefusal = result.refusal;
      if (!result.count) continue;
      report.groupCount++;
      report.tabCount += result.count;
    }
  } catch (error) {
    // A read that throws once the journal is written. Before the first change nothing changed, which the check
    // below answers; after it the changes stand, so they are reported and the journal is finished with them.
    if (ctx.changed) ctx.fail(closing ? "close" : "ungroup", "Stopped partway", undefined, error);
  }
  // Close all: whether an http(s) tab went to tabs.remove, so Undo has something to reopen.
  let reopenable = false;
  if (closing) {
    for (const item of items) {
      // Header, "Close all": each http(s) tab sent stays (undo skips one still open), and so does the one kept open
      // as the Space's last; a title-only entry only for a tab gone (read back, else every tab sent counts); no
      // other tab that was never sent.
      const sent = new Set(item.sent);
      const held = new Set(item.kept);
      const gone = item.gone ?? sent;
      const keep = item.memberIds.map((id, i) => {
        if (item.entry.closed[i].url === undefined) return gone.has(id);
        if (sent.has(id)) reopenable = true;
        return sent.has(id) || held.has(id);
      });
      item.entry.closed = item.entry.closed.filter((_, i) => keep[i]);
      report.nonReopenable += item.entry.closed.filter((c) => c.url === undefined).length;
    }
  }

  // Nothing changed after all (every re-check failed, the first call threw, or a read did before it): the previous
  // journal goes back.
  if (!ctx.changed) {
    await keepPrevious(store, previous);
    return refuse(lastRefusal ?? "action-failed");
  }
  // A close all that sent no tab Undo could reopen to tabs.remove (none was on an http(s) page, or the only one stayed
  // open as the Space's last) leaves a journal that can put nothing back, and one that left no tab here holding a key
  // it knows (unprovable: its only page Undo could reopen closed too, header "Close all") one whose undo could never
  // find this Space: it goes, rather than offer an Undo that could only be refused. Like any new group action, it has
  // still replaced the previous one.
  if (closing && (!reopenable || items.some((item) => item.unprovable))) {
    report.undoable = false;
    await dropJournal(ctx, store);
    return report;
  }
  journal.finishedAt = now();
  try {
    await store.writeGroupJournal(structuredClone(journal));
  } catch (error) {
    ctx.fail("journal", "Could not finish the undo record", undefined, error);
  }
  return report;
}

// One group's journal entry, from the snapshot's tabs of the group (keys, and takeSnapshot's URLs, which for a tab undo
// reopened are its page's). `memberIds` (strip order) lines up with entry.closed, and nonWebTitles and nonWebIds are
// the current titles and the ids of the tabs Undo couldn't reopen (isReopenable), for the confirmation (the titles
// never stored as they are).
function journalGroup(snapshot, check, type, urlSalt) {
  const fresh = new Set(check.members.map((t) => t.id));
  const strip = byIndex(list(snapshot.tabs));
  const members = strip.filter((t) => fresh.has(t.id) && t.groupId === check.info.id && isKey(t.key));
  const ids = new Set(members.map((t) => t.id));
  const first = strip.indexOf(members[0]);
  const last = strip.indexOf(members.at(-1));
  const next = members.length ? strip.slice(last + 1).find((t) => !ids.has(t.id)) : undefined;
  const prev = members.length ? strip.slice(0, first).reverse().find((t) => !t.pinned && !ids.has(t.id)) : undefined;
  const entry = {
    groupId: check.info.id,
    title: check.info.title,
    collapsed: Boolean(check.info.collapsed),
    position: { beforeKey: keyOrNull(next?.key), afterKey: keyOrNull(prev?.key) },
    tabs: [],
    closed: [],
  };
  const memberIds = members.map((t) => t.id);
  // How many tabs the group holds right now (a tab that joined after the snapshot has no journal entry but still
  // leaves the group on ungroup), for the number of batches.
  const memberCount = check.members.length;
  if (type !== "closeAll") {
    entry.tabs = members.map((t) => ({ key: t.key, urlHash: urlHash(urlSalt, t.url) }));
    return { entry, memberIds, memberCount, nonWebTitles: [], nonWebIds: [] };
  }
  // A reopened tab is placed right before the tab that followed it, else right after the one before it: the
  // neighbours that can be there at undo time, unpinned tabs outside the group or members that come back (the reopen
  // path never anchors on a pinned tab, and an Essential proves no Space).
  const anchorable = strip.filter((t) => !t.pinned && (!ids.has(t.id) || isReopenable(t.url)));
  entry.closed = members.map((t) => {
    // A page whose address holds a key-shaped string: its title can hold it too, and only the address could reopen it.
    if (isWebUrl(t.url) && !isReopenable(t.url)) return { title: "" };
    if (!isWebUrl(t.url)) return { title: addressFreeTitle(t.title, t.url) };
    const at = anchorable.indexOf(t);
    return {
      key: t.key, url: t.url, title: typeof t.title === "string" ? t.title : "", index: t.index,
      before: keyOrNull(anchorable[at - 1]?.key), after: keyOrNull(anchorable[at + 1]?.key),
    };
  });
  const nonWeb = members.filter((t) => !isReopenable(t.url));
  const nonWebTitles = nonWeb.map((t) => (typeof t.title === "string" ? t.title : ""));
  return { entry, memberIds, memberCount, nonWebTitles, nonWebIds: nonWeb.map((t) => t.id) };
}

// A title kept only to name a tab Undo can't reopen. An untitled page's title is its address (Firefox shows the URL
// without its scheme: a local path for a file), and no journal holds an address but a closed http(s) tab's
// (m3-contracts, "No address in the journal"), so a title holding the address, or any scheme://, is kept as "".
function addressFreeTitle(title, url) {
  const text = typeof title === "string" ? title : "";
  const address = typeof url === "string" ? url : "";
  const bare = address.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "");
  const lower = text.toLowerCase();
  const holds = (part) => part.length >= 3 && lower.includes(part.toLowerCase());
  return holds(address) || holds(bare) || /[a-z][a-z0-9+.-]*:\/\//i.test(text) ? "" : text;
}

// tabs.ungroup on the group's tabs, at most MOVE_BATCH per call from the group's end, each call re-checked right
// before it (still a tidy group here) with a yield between. Passed last first: Zen takes tabs at a group's front out
// before it and any others out after its last tab, in strip order whatever the order passed, so from the end every
// batch comes out in place; a browser that ungroups one tab at a time to the group's end keeps their order only that
// way round. As many rounds as the group needed at the start, so tabs an ungroup leaves in place are not asked for
// forever. A re-check read that throws before the first call throws on (nothing changed); after it, ungrouping stops
// and what went out is read back. A call that throws may still have taken tabs out, so it is read back too: any tab
// it took out is a change (so "action-failed" only ever means nothing changed), and its failure counts only the tabs
// it left in. Resolves to { count, refusal? }.
async function ungroupGroup(ctx, item) {
  const { api, yieldFn } = ctx;
  const sent = new Set();
  // The chunk of a call that threw, and its failure entry (its count is set from the read back).
  let thrown = [];
  let thrownFailure = null;
  let refusal = null;
  await suppress(ctx, item.groupId);
  const rounds = Math.max(1, Math.ceil(item.memberCount / MOVE_BATCH));
  try {
    for (let round = 0; round < rounds; round++) {
      if (round > 0) await yieldFn();
      const check = await recheck(ctx, item.groupId);
      if (check.error) {
        if (!sent.size) refusal = check.error;
        else ctx.fail("ungroup", "The group changed while it was being ungrouped.");
        break;
      }
      const chunk = check.members.slice(-MOVE_BATCH).map((t) => t.id);
      try {
        await api.tabs.ungroup([...chunk].reverse());
      } catch (error) {
        ctx.fail("ungroup", `Could not take ${chunk.length} tab(s) out of the group`, chunk.length, error);
        thrown = chunk;
        thrownFailure = ctx.failures.at(-1);
        break;
      }
      ctx.changed = true;
      for (const id of chunk) sent.add(id);
    }
  } catch (error) {
    if (!sent.size) throw error;
    ctx.fail("ungroup", "Ungrouping stopped partway", undefined, error);
  }
  if (!sent.size && !thrown.length) return { count: 0, refusal };
  // Read back (M0: an ungroup that resolves can leave a tab in, as Zen does for a split tab). If the read fails,
  // every tab asked for in a call that went through counts as out (the changes are made, so the report and the
  // journal's last write still go), and none of a call that threw.
  let after;
  try {
    after = new Map((await ctx.readTabs()).map((t) => [t.id, t]));
  } catch {
    return { count: sent.size, refusal: sent.size ? null : refusal };
  }
  const left = thrown.filter((id) => after.has(id) && after.get(id).groupId !== item.groupId);
  if (left.length) ctx.changed = true;
  for (const id of left) sent.add(id);
  const stuck = new Set(thrown.filter((id) => after.get(id)?.groupId === item.groupId));
  if (thrownFailure) {
    if (stuck.size) thrownFailure.count = stuck.size;
    else ctx.failures.splice(ctx.failures.indexOf(thrownFailure), 1);
  }
  if (!sent.size) return { count: 0, refusal };
  const out = [...sent].filter((id) => after.get(id)?.groupId !== item.groupId).length;
  // The tabs still in the group, less those the failed call already counted.
  const stayed = [...after.values()].filter((t) => t.groupId === item.groupId && !stuck.has(t.id)).length;
  if (stayed) ctx.fail("ungroup", `${stayed} tab(s) stayed in the group.`, stayed);
  return { count: out };
}

// tabs.remove on the group's journaled tabs (header, "Close all"): the journal's ids in strip order, cut into batches
// of at most CLOSE_BATCH from the end (so a close Zen cuts short leaves the group's front, and undo puts the rest back
// after it), with a yield between. Each batch is re-checked right before its call against a fresh snapshot: still a
// tidy group here, and each tab still in it, unpinned, with the key the journal holds (undo skips a closed entry whose
// key is open, so a tab re-keyed since must not close); then the last-tab rule (lastSpaceTab). A read that throws
// before the first call throws on (nothing changed); after it, closing stops. Then what was sent is read back with
// tabs.get, once more after CLOSE_SETTLE_MS for a tab still open, and so is what was never sent, to report what stayed
// open. Fills item.sent, item.kept (the tabs kept open as the Space's last), item.unprovable and item.gone (the ids
// sent that read closed). Resolves to { count, refusal? }: count, the tabs gone; refusal "last-tab" when the window's
// last tab was kept and nothing else was sent. A call that threw is reported with the tabs it left open only.
async function closeGroup(ctx, item) {
  const { api, windowId, yieldFn, delay } = ctx;
  const ids = item.memberIds;
  const entryOf = new Map(ids.map((id, i) => [id, item.entry.closed[i]]));
  const isWeb = (id) => entryOf.get(id)?.url !== undefined;
  const keys = spaceKeys([item.entry]);
  const { sent, kept } = item;
  const thrown = new Set();
  let thrownFailure = null;
  let refusal = null;
  await suppress(ctx, item.groupId);
  try {
    for (let end = ids.length; end > 0; end -= CLOSE_BATCH) {
      if (end < ids.length) await yieldFn();
      const batch = ids.slice(Math.max(0, end - CLOSE_BATCH), end);
      const snapshot = await ctx.snap(api, { windowId });
      if (!list(snapshot.tidyGroups).some((g) => g.id === item.groupId)) {
        if (!sent.length) refusal = (await recheck(ctx, item.groupId)).error ?? "not-found";
        else ctx.fail("close", "The group changed while its tabs were being closed.");
        break;
      }
      const byId = new Map(list(snapshot.tabs).map((t) => [t.id, t]));
      const passing = batch.filter((id) => stillJournaled(byId.get(id), entryOf.get(id), item.groupId));
      const { hold, unprovable } = lastSpaceTab(list(snapshot.tabs), passing, sent, keys, isWeb);
      if (hold !== null) kept.push(hold);
      if (unprovable) item.unprovable = true;
      const chunk = passing.filter((id) => id !== hold);
      if (!chunk.length) continue;
      sent.push(...chunk);
      try {
        await api.tabs.remove(chunk);
      } catch (error) {
        for (const id of chunk) thrown.add(id);
        ctx.fail("close", `Could not close ${chunk.length} tab(s)`, chunk.length, error);
        thrownFailure = { entry: ctx.failures.at(-1), error };
        break;
      }
      ctx.changed = true;
    }
  } catch (error) {
    if (!sent.length) throw error;
    ctx.fail("close", "Closing stopped partway", undefined, error);
  }

  const openOf = async (some) => {
    const open = await Promise.all(some.map((id) => api.tabs.get(id).then(() => true, () => false)));
    return some.filter((_, i) => open[i]);
  };
  let open = await openOf(sent);
  if (open.length) {
    try {
      await delay(CLOSE_SETTLE_MS);
    } catch {
      // A wait that fails only means the second read comes sooner.
    }
    open = await openOf(open);
  }
  const stillOpen = new Set(open);
  item.gone = new Set(sent.filter((id) => !stillOpen.has(id)));
  // A call that threw may still have closed tabs: that is a change too, and its failure counts only those still open.
  if ([...thrown].some((id) => item.gone.has(id))) ctx.changed = true;
  if (thrownFailure) {
    const still = open.filter((id) => thrown.has(id)).length;
    if (still) {
      thrownFailure.entry.count = still;
      thrownFailure.entry.message = `Could not close ${still} tab(s): ${errorText(thrownFailure.error)}`;
    } else {
      ctx.failures.splice(ctx.failures.indexOf(thrownFailure.entry), 1);
    }
  }
  // Nothing sent: the only tab kept was the window's last, so nothing closed (a refusal, not a report).
  if (!sent.length) return { count: 0, refusal: refusal ?? (kept.length ? "last-tab" : null) };
  const sentIds = new Set(sent);
  const unsent = ids.filter((id) => !sentIds.has(id) && !kept.includes(id));
  // Tabs open now that close all meant to close, less the one it kept and those a call that threw already reported.
  const left = open.filter((id) => !thrown.has(id)).length + (await openOf(unsent)).length;
  if (kept.length) ctx.fail("close", `${kept.length} tab(s) were left open as the last in this Space.`, kept.length, undefined, "last-tab");
  if (left) ctx.fail("close", `${left} tab(s) were left open.`, left);
  return { count: item.gone.size, refusal };
}

// The batch's re-check for one tab: still in the group here, unpinned, and with the key the journal holds. A tab Undo
// can't reopen has no key in the journal: it closes while it is still a member.
function stillJournaled(tab, entry, groupId) {
  if (!tab || !entry || tab.pinned || tab.groupId !== groupId) return false;
  return entry.url === undefined || entry.key === tab.key;
}

// The tab close all keeps open (header, "Close all"): { hold, unprovable }. Closing `ids` (strip order) plus the
// tabs sent before:
// - would leave no tab at all in view in this window (pinned ones included): one of them stays, so closing never
//   takes the window's last tab; the last http(s) one, whose entry then proves the Space, else the last of them;
// - would leave no unpinned tab here that holds a key undo's Space check knows (`keys`): the last http(s) tab of them
//   stays, whose own entry then proves the Space, but only while another tab Undo can reopen goes to tabs.remove with
//   them or went before: then the hold is what lets Undo bring that one back. With none, holding the only page Undo
//   could reopen protects nothing (the person asked to close it): no tab is held, and the close leaves no tab undo
//   could find this Space by (unprovable: runUndoable then drops the journal). A batch with no http(s) tab holds
//   none either: what it closes was confirmed as beyond Undo, and a tab without a closed entry's key proves nothing.
function lastSpaceTab(tabs, ids, sent, keys, isWeb) {
  const closing = new Set([...ids, ...sent]);
  if (!tabs.some((t) => !closing.has(t.id))) {
    const last = ids.findLast(isWeb) ?? ids.at(-1) ?? null;
    return { hold: last, unprovable: last !== null && !isWeb(last) && [...sent, ...ids].some((id) => id !== last && isWeb(id)) };
  }
  if (tabs.some((t) => !t.pinned && !closing.has(t.id) && keys.has(t.key))) return { hold: null, unprovable: false };
  const hold = ids.findLast(isWeb) ?? null;
  const another = [...sent, ...ids].some((id) => id !== hold && isWeb(id));
  return hold !== null && another ? { hold, unprovable: false } : { hold: null, unprovable: true };
}

// The group journal this action's first write replaces, as { journal } (null when there is none), or null when the
// store can't read it.
async function readPrevious(store) {
  if (typeof store.readGroupJournal !== "function") return null;
  try {
    return { journal: (await store.readGroupJournal()) ?? null };
  } catch {
    return null;
  }
}

// Removes this action's journal (header: nothing in it could be undone). If that fails it stays, holding titles
// only, and its undo finds nothing to do.
async function dropJournal(ctx, store) {
  try {
    if (typeof store.removeGroupJournal !== "function") throw new Error("the store can't remove the undo record");
    await store.removeGroupJournal();
  } catch (error) {
    ctx.fail("journal", "Could not remove the undo record", undefined, error);
  }
}

// Puts back the journal readPrevious found (removed when there was none). Best effort: if it fails, this action's
// journal stays, and its undo finds nothing to do.
async function keepPrevious(store, previous) {
  if (!previous) return;
  try {
    if (previous.journal !== null) await store.writeGroupJournal(structuredClone(previous.journal));
    else if (typeof store.removeGroupJournal === "function") await store.removeGroupJournal();
  } catch {
    // Nothing more to do.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// undoGroupAction

// undoGroupAction(api, { windowId, store, now, yieldFn, onOwnGroupChange, snapshot, waitReady, createTimeoutMs })
// undoes the last ungroup, close all or remove all (header). Resolves to the report, or to a refusal
// { error, message }: "invalid-request", "no-journal" (none, damaged or spent), "wrong-space" (none of the journal's
// tabs or anchors visible here, or the Space changed before the first change), "nothing-to-undo" (none of its tabs
// is here at all: they may come back, so the journal stays), or "undo-failed" with `report` (a call threw, a group
// made again is still untitled, no tab could safely start a group to make again (only the open tab or possible
// Glance tabs were left), a closed tab's reopen stopped short (a create refused or unanswered), or the Space changed
// after changes began: the journal stays "done", holding the id of every group already made again and what the
// reopen path learned, so Undo again finishes the job, and spends the journal when an earlier attempt had put
// everything back already).
// - Report: { type, groupsRestored, tabsRestored, reopened, moved: [{ title }], missing, nonReopenable: [title],
//   titlesKept, failures: [{ message, scope, code?, count? }] }. moved: tabs left alone (in another group, pinned or
//   in a split), by current title. nonReopenable: closed tabs that weren't on an http(s) page, by their journaled
//   title. titlesKept: what was left of a group, renamed (or re-iconed) by the person since, which keeps its new name.
//   When every tab found was moved since, nothing is put back and the journal is spent with them listed.
//   failures' scope: "regroup", "title", "order", "collapse", "group", "reopen" (undoTidy's, as it reports them) or
//   "journal"; code "no-safe-tab" on the regroup failure when no tab could safely start the group (the router passes
//   failures' scope, code and count on with undo-failed, so the popup can say to switch tabs first).
// - waitReady and createTimeoutMs go to the reopen path (undoTidy's seams).
export async function undoGroupAction(api, options = {}) {
  const ctx = context(api, options);
  if (!Number.isInteger(ctx.windowId) || ctx.windowId < 0) return refuseUndo("invalid-request");
  let journal;
  try {
    journal = journalView(await ctx.store.readGroupJournal());
  } catch {
    return refuseUndo("undo-failed");
  }
  if (!journal) return refuseUndo("no-journal");
  const report = {
    type: journal.type, groupsRestored: 0, tabsRestored: 0, reopened: 0, moved: [], missing: 0, nonReopenable: [],
    titlesKept: 0, failures: ctx.failures,
  };
  try {
    const refusal = await undoAll(ctx, journal, report);
    if (refusal) return refusal;
  } catch (error) {
    if (error instanceof SpaceChangedError && !ctx.changed) return refuseUndo("wrong-space");
    if (!(error instanceof SpaceChangedError)) ctx.fail("group", "Undo stopped", undefined, error);
    await keepForRetry(ctx, journal);
    return refuseUndo("undo-failed", { report });
  }
  if (ctx.unfinished) {
    await keepForRetry(ctx, journal);
    return refuseUndo("undo-failed", { report });
  }
  await spend(ctx, journal, report);
  return report;
}

// The journal as undo reads it, or null when it is missing, damaged, of another version or spent. Normalized: every
// group with a title (a SIG one: an untitled group would look like a split), a position and both lists.
function journalView(journal) {
  if (!isObject(journal) || journal.version !== GROUP_JOURNAL_VERSION || !UNDOABLE.has(journal.type)) return null;
  if (journal.state !== "done") return null;
  const groups = list(journal.groups).filter(isObject).map((g) => ({
    groupId: Number.isInteger(g.groupId) ? g.groupId : null,
    ...(g.recreated === true ? { recreated: true } : {}),
    title: isTidyTitle(g.title) ? g.title : makeTitle(FALLBACK_NAME),
    collapsed: g.collapsed === true,
    position: { beforeKey: keyOrNull(g.position?.beforeKey), afterKey: keyOrNull(g.position?.afterKey) },
    tabs: list(g.tabs).filter((t) => isKey(t?.key) && typeof t.urlHash === "string").map((t) => ({ key: t.key, urlHash: t.urlHash })),
    closed: list(g.closed).filter(isObject).map((c) => (isKey(c.key) && isWebUrl(c.url)
      ? {
        key: c.key, url: c.url, title: typeof c.title === "string" ? c.title : "",
        index: Number.isFinite(c.index) ? c.index : null, before: keyOrNull(c.before), after: keyOrNull(c.after),
        // How many times Zen refused to reopen it (undo.js REOPEN_ATTEMPTS).
        ...(Number.isInteger(c.reopenFailures) && c.reopenFailures > 0 ? { reopenFailures: c.reopenFailures } : {}),
      }
      : { title: typeof c.title === "string" ? c.title : "" })),
  }));
  if (!groups.length) return null;
  return {
    version: GROUP_JOURNAL_VERSION, type: journal.type, at: Number.isFinite(journal.at) ? journal.at : null,
    finishedAt: Number.isFinite(journal.finishedAt) ? journal.finishedAt : null, state: "done",
    urlSalt: typeof journal.urlSalt === "string" ? journal.urlSalt : "", groups,
  };
}

// The journal again before undo answers undo-failed, when the reopen path learned what Undo again must know (a refused
// create's count, a tab another Space took: undo.js keepForRetry). Best effort: without it Undo again knows less.
async function keepForRetry(ctx, journal) {
  if (!ctx.journalChanged) return;
  try {
    await ctx.store.writeGroupJournal(structuredClone(journal));
  } catch {
    // See above.
  }
}

// Resolves to a refusal, or to null once every group has been worked on (the report filled in).
async function undoAll(ctx, journal, report) {
  const { api, windowId } = ctx;
  const snapshot = await ctx.snap(api, { windowId });
  const allGroups = list(await api.tabGroups.query({}));
  if (!inChangedSpace(journal, snapshot)) return refuseUndo("wrong-space");
  learn(ctx, snapshot);
  const plans = journal.groups.map((entry) => planGroup(journal, entry, snapshot, allGroups));
  if (!plans.some((plan) => hasWork(plan, snapshot))) {
    // Every tab found is back in what is left of its group, titled and collapsed as the journal says (an undo that
    // stopped after its last change has nothing left to do), or every tab found was moved since (into another group,
    // pinned, or in a split): Undo again spends the journal, listing those. Only when none of the journal's tabs is
    // here at all is there nothing to undo (the journal stays: they may come back).
    if (!plans.some((plan) => plan.restore.length || plan.moved.length)) return refuseUndo("nothing-to-undo");
    for (const plan of plans) {
      report.moved.push(...plan.moved.map((m) => ({ title: m.title })));
      report.missing += plan.missing;
      report.nonReopenable.push(...plan.nonReopenable);
    }
    return null;
  }
  // Last group first: each group's anchor (the tab that followed it) is then already where it belongs.
  for (const [n, plan] of [...plans].reverse().entries()) {
    if (n > 0) await ctx.yieldFn();
    await restoreGroup(ctx, journal, plan, report);
  }
  return null;
}

// The Space check: an unpinned tab here holds a key the journal knows (spaceKeys). tabs.query covers only the active
// Space (plus pinned Essentials, which show everywhere). Close all keeps a tab open for it (lastSpaceTab).
function inChangedSpace(journal, snapshot) {
  const keys = spaceKeys(journal.groups);
  return list(snapshot.tabs).some((t) => !t.pinned && keys.has(t.key));
}

// The keys whose tab, seen unpinned here, proves the changed Space: each journal tab's (a tab of a group), each closed
// tab's (one back already) and its neighbours', and each group's own neighbours'.
function spaceKeys(groups) {
  const keys = new Set();
  for (const entry of groups) {
    for (const t of list(entry.tabs)) if (isKey(t.key)) keys.add(t.key);
    for (const c of list(entry.closed)) for (const key of [c.key, c.before, c.after]) if (isKey(key)) keys.add(key);
    for (const key of [entry.position.beforeKey, entry.position.afterKey]) if (isKey(key)) keys.add(key);
  }
  return keys;
}

// What a snapshot of the changed Space teaches readHere and the anchors: its unpinned tabs, and each key's tab.
function learn(ctx, snapshot) {
  for (const t of list(snapshot.tabs)) {
    if (!t.pinned) ctx.known.add(t.id);
    if (isKey(t.key)) ctx.keyToId.set(t.key, t.id);
  }
}

// What is left of the group (the entry's groupId) as somewhere its tabs can go back into, or null: still here, not a
// folder, every visible tab unpinned, and still a tidy group, or the untitled group a previous undo made again.
function homeOf(entry, snapshot) {
  if (entry.groupId === null) return null;
  const group = list(snapshot.groups).find((g) => g.id === entry.groupId);
  const members = list(snapshot.tabs).filter((t) => t.groupId === entry.groupId);
  if (!group || group.color === FOLDER_COLOR || !members.length || members.some((t) => t.pinned)) return null;
  return isTidyTitle(group.title) || (entry.recreated === true && group.title === "") ? entry.groupId : null;
}

// One group's undo: the tabs to put back (ids, strip order: loose ones and those already in what is left of the
// group), those left alone, how many are gone, and close all's entries still to reopen and its titles Undo can't.
function planGroup(journal, entry, snapshot, allGroups) {
  const home = homeOf(entry, snapshot);
  const keysHere = new Set(list(snapshot.tabs).map((t) => t.key));
  const reopenable = entry.closed.filter((c) => c.url !== undefined);
  return {
    entry,
    home,
    // Not back yet. One Zen has refused to reopen REOPEN_ATTEMPTS times still counts here, so the undo runs and spends
    // the journal; the reopen path itself no longer tries it (undo.js reopenGivenUp).
    reopen: reopenable.filter((c) => !keysHere.has(c.key)),
    nonReopenable: entry.closed.filter((c) => c.url === undefined).map((c) => c.title),
    ...findTabs(wantedTabs(journal, entry), journal.urlSalt, home, entry, snapshot, allGroups),
  };
}

// The journal tabs a group's undo looks for: its fingerprints, or for close all its closed http(s) tabs, fingerprinted
// under the journal's salt from their URLs (a reopened tab reads as its zt-reopen URL).
function wantedTabs(journal, entry) {
  if (journal.type !== "closeAll") return entry.tabs;
  return entry.closed.filter((c) => c.url !== undefined).map((c) => ({ key: c.key, urlHash: urlHash(journal.urlSalt, c.url) }));
}

// Finds the group's tabs as tidy undo does (header): planUndo on a stand-in journal of an interrupted apply that was
// putting every one of them into `home` (or into no group known here). So a tab still loose, or in `home`, is put back;
// one in another group, pinned or in a split is moved; a key held by no tab here is missing; strong and weak matches
// and duplicate keys work as for a tidy. An untitled `home` (made again by a previous undo) is listed as created, so
// planUndo doesn't take it for a split.
function findTabs(wanted, urlSalt, home, entry, snapshot, allGroups) {
  if (!wanted.length) return { restore: [], moved: [], missing: 0 };
  const plan = planUndo({
    version: 3,
    state: "applying",
    urlSalt,
    strip: [],
    tabs: wanted.map((t, index) => ({ key: t.key, urlHash: t.urlHash, index, groupId: NO_GROUP, to: home })),
    joins: [],
    createdGroupIds: home !== null && entry.recreated === true ? [home] : [],
    closed: [],
    undoneAt: null,
  }, snapshot, allGroups);
  if (plan.status !== "ready") return { restore: [], moved: [], missing: plan.missing };
  return { restore: plan.restore.map((r) => r.tabId), moved: plan.moved, missing: plan.missing };
}

// Something to do for this group: closed tabs to reopen, a tab to group again, or a group left whose collapsed state
// isn't the journal's, or that has no title yet (one a previous undo made again). A Zen Tidy title other than the
// journal's is the person's own rename since, which undo keeps (restoreTitle).
function hasWork(plan, snapshot) {
  if (plan.reopen.length) return true;
  const byId = new Map(list(snapshot.tabs).map((t) => [t.id, t]));
  if (plan.restore.some((id) => isLoose(byId.get(id)))) return true;
  if (plan.home === null) return false;
  const group = list(snapshot.groups).find((g) => g.id === plan.home);
  return !isTidyTitle(group.title) || Boolean(group.collapsed) !== plan.entry.collapsed;
}

async function restoreGroup(ctx, journal, plan, report) {
  const { api, windowId } = ctx;
  let { restore, home } = plan;
  // Tabs this undo reopened: the reopen path may have put them straight back into what is left of the group.
  let reopened = new Set();
  if (journal.type === "closeAll") {
    if (plan.reopen.length) await reopen(ctx, plan, report);
    // The reopened tabs have new ids: found again by their old keys in a fresh snapshot, which must still show the
    // changed Space. A closed tab not found here was already reported by the reopen path.
    const snapshot = await ctx.snap(api, { windowId });
    if (!list(snapshot.tabs).some((t) => !t.pinned && ctx.known.has(t.id))) throw new SpaceChangedError();
    const seen = new Set(ctx.known);
    learn(ctx, snapshot);
    home = homeOf(plan.entry, snapshot);
    const found = findTabs(wantedTabs(journal, plan.entry), journal.urlSalt, home, plan.entry, snapshot,
      list(await api.tabGroups.query({})));
    restore = found.restore;
    reopened = new Set(restore.filter((id) => !seen.has(id)));
    report.moved.push(...found.moved.map((m) => ({ title: m.title })));
  } else {
    report.moved.push(...plan.moved.map((m) => ({ title: m.title })));
    report.missing += plan.missing;
  }
  report.nonReopenable.push(...plan.nonReopenable);
  await regroup(ctx, journal, plan.entry, restore, home, report, reopened);
}

// Close all's tabs, through tidy undo's reopen path (header): undoTidy on a stand-in journal holding only the closed
// entries still to reopen, with a scratch store that keeps nothing, so neither the tidy journal nor this one is
// written. An entry carries `home` as its group, so while what is left of the group is a tidy group here (a close
// Zen cut short) the tab goes back into it in place; otherwise it opens at its old place, loose, for regroup.
async function reopen(ctx, plan, report) {
  // The stand-in journal as undoTidy last wrote it: on a reopen it leaves for Try again, what it learned about each
  // closed entry (a refused create's count, an entry dropped for a tab another Space took) comes back to this journal.
  let last = null;
  const scratch = {
    async writeJournal(value) {
      last = value;
    },
    async removeJournal() {},
  };
  const journal = {
    version: 3, state: "done", startedAt: null, finishedAt: null, urlSalt: "", strip: [], tabs: [], joins: [],
    createdGroupIds: [], closed: plan.reopen.map((c) => ({ ...c, groupId: plan.home })), undoneAt: null,
  };
  try {
    const result = await undoTidy(ctx.api, { status: "ready" }, {
      windowId: ctx.windowId, store: scratch, journal, now: ctx.now, yieldFn: ctx.yieldFn,
      onOwnGroupChange: ctx.onOwnGroupChange, snapshot: ctx.snap,
      ...(ctx.waitReady ? { waitReady: ctx.waitReady } : {}),
      ...(Number.isFinite(ctx.createTimeoutMs) ? { createTimeoutMs: ctx.createTimeoutMs } : {}),
    });
    ctx.changed = true;
    report.reopened += result.reopened;
    for (const failure of list(result.failures)) ctx.failures.push({ ...failure });
  } catch (error) {
    if (error instanceof UndoNotStartedError) {
      if (error.status === "wrong-space") throw new SpaceChangedError();
      ctx.fail("reopen", `${plan.reopen.length} closed tab(s) weren't reopened.`, plan.reopen.length);
      // No status: a read or the mark failed before anything changed, so the same undo can run again (undo.js); the
      // journal is kept for Undo again instead of being spent with the tabs still closed. "nothing" means the tabs
      // are back or gone, which a retry would not change.
      if (error.status === null) ctx.unfinished = true;
      return;
    }
    ctx.changed = true;
    ctx.unfinished = true;
    if (!(error instanceof UndoIncompleteError)) {
      ctx.fail("reopen", "Could not reopen the closed tabs", plan.reopen.length, error);
      return;
    }
    // The reopen stopped short (a create refused or unanswered, the Space changed): what it did is reported, and the
    // journal is kept, so Undo again reopens the rest (undo.js, "Trying again").
    report.reopened += Number.isInteger(error.report?.reopened) ? error.report.reopened : 0;
    for (const failure of list(error.report?.failures)) ctx.failures.push({ ...failure });
    learnAttempts(ctx, plan, last);
  }
}

// The closed entries of this group as the reopen path left them for Try again (`stand`: its stand-in journal's last
// write): each refused create's count, and an entry it dropped (a tab another Space took) goes.
function learnAttempts(ctx, plan, stand) {
  if (!isObject(stand)) return;
  const after = new Map(list(stand.closed).filter((c) => isKey(c?.key)).map((c) => [c.key, c]));
  const tried = new Set(plan.reopen.map((c) => c.key));
  const before = plan.entry.closed;
  plan.entry.closed = before
    .filter((c) => c.url === undefined || !tried.has(c.key) || after.has(c.key))
    .map((c) => {
      const failures = after.get(c.key)?.reopenFailures;
      return c.url !== undefined && Number.isInteger(failures) && failures !== c.reopenFailures ? { ...c, reopenFailures: failures } : c;
    });
  if (plan.entry.closed.length !== before.length || plan.entry.closed.some((c, i) => c !== before[i])) ctx.journalChanged = true;
}

// The group again, from the tabs found (strip order): re-checked right before tabs.group (only tabs visible here,
// loose and unpinned go in; a loose tab is never in a split), added to what is left of the group or made into a new
// one, read back (M0: a call that went through can leave a tab out), then its exact title, its place and its collapsed
// state, in that order. `reopened`: tabs this undo reopened, which count as put back when the reopen path put them
// straight into what is left of the group.
async function regroup(ctx, journal, entry, restore, home, report, reopened) {
  const { api } = ctx;
  const tabs = await ctx.readHere();
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const homeId = home !== null && (await stillHome(ctx, entry, home, tabs)) ? home : null;
  const loose = [];
  let rejoined = 0;
  for (const id of restore) {
    const tab = byId.get(id);
    if (isLoose(tab)) loose.push(id);
    else if (homeId !== null && tab?.groupId === homeId && !tab.pinned) rejoined += reopened.has(id) ? 1 : 0;
    else if (!tab) report.missing++;
    else report.moved.push({ title: typeof tab.title === "string" ? tab.title : "" });
  }
  let groupId = homeId;
  if (loose.length) {
    try {
      if (homeId !== null) {
        await suppress(ctx, homeId);
        ctx.changed = true;
        await api.tabs.group({ tabIds: loose, groupId: homeId });
      } else {
        groupId = await createInOrder(ctx, journal, entry, loose, tabs);
      }
    } catch (error) {
      ctx.fail("regroup", `Could not put ${loose.length} tab(s) back in their group`, loose.length, error);
      ctx.unfinished = true;
      return;
    }
  }
  if (groupId === null) return;
  const after = await ctx.readHere();
  const inGroup = new Set(after.filter((t) => t.groupId === groupId).map((t) => t.id));
  const back = loose.filter((id) => inGroup.has(id));
  if (back.length < loose.length) {
    const left = loose.length - back.length;
    ctx.fail("regroup", `${left} tab(s) couldn't be put back in their group.`, left);
  }
  if (!inGroup.size) return;
  const title = await restoreTitle(ctx, groupId, entry.title, report);
  const place = await restorePosition(ctx, groupId, entry.position, groupId !== homeId);
  const collapsed = await restoreCollapsed(ctx, groupId, entry.collapsed);
  // Counted only when this undo put something back: a retry passes over a group an earlier attempt finished.
  if (back.length || rejoined || title || place || collapsed) report.groupsRestored++;
  report.tabsRestored += back.length + rejoined;
}

// `home` right before tabs.group: still in this window, not a folder, and still a tidy group (or the untitled group a
// previous undo made again), with every visible tab unpinned.
async function stillHome(ctx, entry, home, tabs) {
  let info;
  try {
    info = await ctx.api.tabGroups.get(home);
  } catch {
    return false;
  }
  const members = tabs.filter((t) => t.groupId === home);
  const titled = isTidyTitle(info?.title) || (entry.recreated === true && info?.title === "");
  return titled && info.color !== FOLDER_COLOR && info.windowId === ctx.windowId && members.length > 0 &&
    members.every((t) => !t.pinned);
}

// A new group of `ids` in this order. tabs.group puts the group at tabIds[0] and holds the tabs in tabIds order, and
// tabIds[0] must be a safe tab (never the open tab or a possible Glance tab), so the group starts at the first safe
// one; any before it go in at the end and are then moved back to the front: a tab moved back onto a group's first
// index joins the group of the tab there (Zen 1.23.4b, measured in M3), this one. The new id goes into the journal
// before anything else (header).
async function createInOrder(ctx, journal, entry, ids, tabs) {
  const unsafe = unsafeOf(tabs);
  const first = ids.findIndex((id) => !unsafe.has(id));
  if (first < 0) {
    // Usually only the open tab is left to start it: once the person opens another tab Undo again can, so the
    // journal is kept for it rather than spent on a group nothing went back into.
    ctx.fail("regroup", "No tab can safely start the group (the open tab and possible Glance tabs can't), so they stay loose. Switch to another tab, then Undo again.", ids.length, undefined, "no-safe-tab");
    ctx.unfinished = true;
    return null;
  }
  const lead = ids.slice(0, first);
  ctx.changed = true;
  const groupId = await ctx.api.tabs.group({
    tabIds: [...ids.slice(first), ...lead], createProperties: { windowId: ctx.windowId },
  });
  entry.groupId = groupId;
  entry.recreated = true;
  try {
    await ctx.store.writeGroupJournal(structuredClone(journal));
  } catch (error) {
    ctx.fail("journal", "Could not record the group made again", undefined, error);
  }
  if (lead.length) await leadToFront(ctx, groupId, lead);
  return groupId;
}

async function leadToFront(ctx, groupId, lead) {
  const tabs = await ctx.readHere();
  const members = byIndex(tabs.filter((t) => t.groupId === groupId));
  const ids = lead.filter((id) => members.some((t) => t.id === id && !t.pinned));
  if (!ids.length) return;
  try {
    await ctx.api.tabs.move(ids, { index: members[0].index, windowId: ctx.windowId });
  } catch (error) {
    ctx.fail("order", "Tabs inside the group may be in a slightly different order", ids.length, error);
    return;
  }
  const after = byIndex((await ctx.readHere()).filter((t) => t.groupId === groupId));
  if (!ids.every((id, i) => after[i]?.id === id)) {
    ctx.fail("order", "Tabs inside the group may be in a slightly different order.", ids.length);
  }
}

// The journal's exact title, re-read right before. Resolves to true when it changed the title. Only a group with no
// Zen Tidy title gets it (one made again is untitled): the actions never rename a group, so what is left of one that
// carries another Zen Tidy title was renamed or re-iconed by the person since, and keeps it (report.titlesKept), as
// tidy undo keeps a joined group's new name. A group left without a tidy title (it looks exactly like a split view)
// keeps the journal for Undo again, which finds it by the id the journal holds and names it.
async function restoreTitle(ctx, groupId, title, report) {
  let info;
  try {
    info = await ctx.api.tabGroups.get(groupId);
  } catch {
    return false;
  }
  if (info.title === title) return false;
  if (isTidyTitle(info.title)) {
    report.titlesKept++;
    return false;
  }
  await suppress(ctx, groupId);
  try {
    await ctx.api.tabGroups.update(groupId, { title });
    return true;
  } catch (error) {
    ctx.fail("title", "Could not give the group its name back", undefined, error);
    if (!isTidyTitle(info.title)) ctx.unfinished = true;
    return false;
  }
}

// The journal's collapsed state, re-read right before; the suppression window first. Resolves to true when it
// changed it.
async function restoreCollapsed(ctx, groupId, collapsed) {
  let info;
  try {
    info = await ctx.api.tabGroups.get(groupId);
  } catch {
    return false;
  }
  if (Boolean(info.collapsed) === collapsed) return false;
  await suppress(ctx, groupId);
  try {
    await ctx.api.tabGroups.update(groupId, { collapsed });
    return true;
  } catch (error) {
    ctx.fail("collapse", "Could not collapse the group again", undefined, error);
    return false;
  }
}

// The group back in its place (tabGroups.move, from a fresh read right before), then checked. Resolves to true when
// it moved the group. With nothing left to anchor on, a group this undo made (`made`) stays where tabs.group put it,
// which is reported; what was left of the group stays where the action left it, its old place.
async function restorePosition(ctx, groupId, position, made) {
  const tabs = await ctx.readHere();
  const anchor = positionAnchor(ctx, tabs, groupId, position);
  if (!anchor) {
    if (made) ctx.fail("order", "The group may not be exactly where it was.");
    return false;
  }
  const index = anchorIndex(tabs, groupId, anchor);
  const first = Math.min(...tabs.filter((t) => t.groupId === groupId).map((t) => t.index));
  if (index === null || index === first) return false;
  try {
    await ctx.api.tabGroups.move(groupId, { index, windowId: ctx.windowId });
  } catch (error) {
    ctx.fail("order", "Could not move the group back to its place", undefined, error);
    return false;
  }
  if (!placed(await ctx.readHere(), groupId, anchor)) ctx.fail("order", "The group may not be exactly where it was.");
  return true;
}

// Where the group goes: right before the tab that followed it (before the first tab of that tab's group or split,
// when it is in one: never inside one), else right after the tab that came before it (after the last tab of its group
// or split), else the top of the loose area or the end of the strip when that is where it was. Never on a pinned tab,
// one of the group's own, or a loose tab that may not anchor (unsafeOf). null: no anchor left.
function positionAnchor(ctx, tabs, groupId, { beforeKey, afterKey }) {
  const unsafe = unsafeOf(tabs);
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const others = byIndex(tabs.filter((t) => t.groupId !== groupId));
  const find = (key) => {
    const tab = key === null ? undefined : byId.get(ctx.keyToId.get(key));
    if (!tab || tab.pinned || tab.groupId === groupId) return null;
    return tab.groupId === NO_GROUP && unsafe.has(tab.id) ? null : tab;
  };
  const unit = (tab) => (tab.groupId === NO_GROUP ? [tab] : others.filter((t) => t.groupId === tab.groupId));
  const next = find(beforeKey);
  if (next) return { kind: "before", tabId: unit(next)[0].id };
  const prev = find(afterKey);
  if (prev) return { kind: "after", tabId: unit(prev).at(-1).id };
  if (afterKey === null) return { kind: "top" };
  if (beforeKey === null) return { kind: "end" };
  return null;
}

// tabGroups.move's index for the anchor, asked of groupMoveIndex (apply.js: the one place that knows what the index
// means): the top of the loose area as it has it, and "right after index `last`" as right after a one-tab stand-in
// group there.
const STAND_IN = Symbol("stand-in");
function anchorIndex(tabs, groupId, anchor) {
  if (anchor.kind === "top") return groupMoveIndex(tabs, groupId, null);
  const others = tabs.filter((t) => t.groupId !== groupId);
  const at = (id) => tabs.find((t) => t.id === id).index;
  let last;
  if (anchor.kind === "before") last = at(anchor.tabId) - 1;
  else if (anchor.kind === "after") last = at(anchor.tabId);
  else last = Math.max(-1, ...others.map((t) => t.index));
  return groupMoveIndex([...tabs, { id: null, index: last, groupId: STAND_IN, pinned: false }], groupId, STAND_IN);
}

// The group sits right before (or after) its anchor tab; the top and the end are taken as placed.
function placed(tabs, groupId, anchor) {
  const strip = byIndex(tabs);
  const first = strip.findIndex((t) => t.groupId === groupId);
  const last = strip.findLastIndex((t) => t.groupId === groupId);
  if (first < 0) return false;
  if (anchor.kind === "before") return strip[last + 1]?.id === anchor.tabId;
  if (anchor.kind === "after") return strip[first - 1]?.id === anchor.tabId;
  return true;
}

// Spent: only times and a report with counts and each failure's scope, code and count. Tried once more without the
// report, then removed, before a "journal" failure is reported.
async function spend(ctx, journal, report) {
  const { store } = ctx;
  const spent = {
    version: GROUP_JOURNAL_VERSION, type: journal.type, at: journal.at, finishedAt: journal.finishedAt, state: "undone",
    undoneAt: ctx.now(),
  };
  const undoReport = {
    groupsRestored: report.groupsRestored, tabsRestored: report.tabsRestored, reopened: report.reopened,
    moved: report.moved.length, missing: report.missing, nonReopenable: report.nonReopenable.length,
    titlesKept: report.titlesKept,
    failures: report.failures.map((f) => ({
      scope: f.scope, ...(typeof f.code === "string" ? { code: f.code } : {}), ...(Number.isInteger(f.count) ? { count: f.count } : {}),
    })),
  };
  try {
    await store.writeGroupJournal({ ...spent, undoReport });
  } catch (error) {
    try {
      await store.writeGroupJournal(spent);
    } catch {
      try {
        if (typeof store.removeGroupJournal !== "function") throw error;
        await store.removeGroupJournal();
      } catch {
        ctx.fail("journal", "Could not mark the group change as undone", undefined, error);
      }
    }
  }
}
