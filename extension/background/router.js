// Message handlers for the popup and options page (runtime.sendMessage), plus the sender check.
// Every response is a plain JSON object; errors are { error: <code>, message? }. No handler ever
// returns the API key: the only key data that leaves is getKeyStatus's last 4 characters (the settings messages'
// views are built field by field, and settings never hold the key), and no
// handler returns the undo journal's URLs or titles (getState's `undo` is counts and times only), or the group
// journal's (getGroups' `groupUndo` is counts and times only, its rows group names and counts).

import { ACTIVE_STATES, MAX_STALE_DAYS, SENSITIVE_LISTS, idleRun, redactKeys } from "./store.js";
import { describeError, ERROR_MESSAGES, undoFailedError } from "./run.js";
import { MAX_EDIT_STRING, validateEdits } from "./preview.js";
import { APPLY_NOT_STARTED } from "./apply.js";
import { UNDO_NOT_STARTED } from "./undo.js";
import { GROUP_JOURNAL_VERSION, confirmIds } from "./groups.js";
import { redact } from "./log.js";

// Extension pages allowed to send messages. The dev build adds its self-test page.
export const PAGE_PATHS = Object.freeze(["/popup/", "/options/"]);
export const SELFTEST_PATH = "/selftest/";

const STALE_RUN_MESSAGE = "This preview is out of date. Tidy again.";
const MULTI_WINDOW_MESSAGE = "More than one window is open. Confirm to apply anyway.";
const WRONG_SPACE_MESSAGE = "Switch back to the Space you tidied, then Apply.";
const NOT_STARTED_MESSAGE = "Apply couldn't start, so nothing was changed. Try again.";
// The undo message's refusals and the failure before its first change; a failure after that is the run's error
// (ERROR_MESSAGES["undo-failed"]).
const UNDO_MESSAGES = Object.freeze({
  // No window id from the popup, and no last focused window either: the person can only open Zen Tidy again.
  "invalid-request": "Zen Tidy couldn't tell which window to undo in. Open it from the window you tidied and try again.",
  busy: "Another action is running. Try again once it finishes.",
  "no-journal": "There is no tidy to undo.",
  // Tabs that aren't seen here may still come back (another Space whose groups are gone, another window, an older
  // session restored), so it never says they are closed, and the offer stays.
  "nothing-to-undo": "The tidied tabs aren't open here. Undo works again if they come back.",
  "wrong-space": "Switch to the Space you tidied, then Undo.",
  // The tidy's groups are all in another window: no Space of this one can show them.
  "other-window": "Open Zen Tidy from the window you tidied, then Undo.",
  "multi-window-unconfirmed": "More than one window is open, or was during the tidy. Confirm to undo anyway.",
  "not-started": "Undo couldn't start, so nothing was changed. Try again.",
});
// nothing-to-undo with 2+ normal windows open: the tabs may be in another window, ungrouped since, with no group of
// the tidy left to show where.
const NOTHING_HERE_MANY_WINDOWS =
  "The tidied tabs aren't open in this window. If you tidied another window, open Zen Tidy there and Undo.";
// Journal states undo can work from: a finished apply, or one Zen cut short. "undone" is spent (undo is one step).
const UNDOABLE_STATES = Object.freeze(["done", "applying"]);
const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

// The groups view (notes/m4-contracts.md, "Group actions" and "Messages"). Its actions and the ones with an undo.
export const GROUP_ACTIONS = Object.freeze(["rename", "icon", "collapse", "ungroup", "closeAll", "removeAll"]);
const GROUP_UNDO_TYPES = Object.freeze(["ungroup", "closeAll", "removeAll"]);
const BUSY_MESSAGE = "Another action is running. Try again once it finishes.";
// A rename that meets the lock waits for it, up to RENAME_WAIT_MS, polling every LOCK_POLL_MS: the popup sends a
// changed name straight away when it closes (pagehide), and a page that is gone can't try again on busy. That send
// can meet the popup's own rename from Enter still holding the lock. Only a rename waits; every other action (and a
// rename still blocked after the wait) answers busy.
const RENAME_WAIT_MS = 2000;
const LOCK_POLL_MS = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// groupAction's refusals and failures, by code. The popup words most of them itself; these are the fallback.
const GROUP_MESSAGES = Object.freeze({
  // No window id from the popup and no last focused window, or a malformed action.
  "invalid-request": "Zen Tidy couldn't read that request. Open it again from this window and try again.",
  busy: BUSY_MESSAGE,
  // The group is gone, renamed by hand into a plain group, or no longer has tabs in this Space.
  "not-found": "That group isn't one of Zen Tidy's groups in this Space any more.",
  // Close all on a group holding tabs Undo couldn't reopen (not http(s)): the popup names them first (SPEC F4).
  "confirm-needed": "Undo can't reopen some of these tabs. Confirm to close them anyway.",
  "wrong-space": "Switch to the Space with this group, then try again.",
  // groups.js answers it only when nothing changed: a call that may have changed something is read back and reported.
  "action-failed": "Zen didn't make that change. Try again.",
  // Close all on a group that is every tab in view in the window: its last tab stays, so nothing was closed.
  "last-tab": "Zen Tidy keeps the last tab in this Space open.",
});
// Remove all asks for its confirmation every time until it is sent with confirm: true; no tab is closed.
const REMOVE_ALL_CONFIRM_MESSAGE = "Confirm to remove every Zen Tidy group in this Space.";
// undoGroupAction's refusals and failures, by code.
const GROUP_UNDO_MESSAGES = Object.freeze({
  "invalid-request": "Zen Tidy couldn't tell which window to undo in. Open it from that window and try again.",
  busy: BUSY_MESSAGE,
  "no-journal": "There is no group change to undo.",
  "wrong-space": "Switch to the Space you changed, then Undo.",
  // As for a tidy: tabs not seen here may still come back, so it never says they are closed.
  "nothing-to-undo": "Those tabs aren't open here. Undo works again if they come back.",
  "undo-failed": "Undo didn't finish. Some tabs may already be back. Try Undo again.",
});

// The settings messages (notes/m6-contracts.md, "Messages"). The settings the options page shows and saves; thinking
// is not one (SPEC F5: the benchmark picks it), so no message reads or changes it. What resetSettings can put back:
// each of them, the sensitive lists one by one.
export const PAGE_SETTINGS = Object.freeze(["model", "effort", "precision", "preferences", "staleDays", "sensitive"]);
export const RESETTABLE_SETTINGS = Object.freeze([
  ...PAGE_SETTINGS.filter((field) => field !== "sensitive"), ...SENSITIVE_LISTS.map((name) => `sensitive.${name}`),
]);
// A malformed settings message: no patch or fields, or a field the page can't set. The value refusals are store.js's.
const SETTINGS_REQUEST_MESSAGE = "Zen Tidy couldn't read that change. Reload Settings and try again.";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isWindowId = (value) => Number.isInteger(value) && value >= 0;
const list = (value) => (Array.isArray(value) ? value : []);
const isGroupId = (value) => Number.isInteger(value) && value >= 0;
// The same cap as the preview's saved edits: groups.js cleans and caps a name as a preview rename is.
const isEditString = (value) => typeof value === "string" && value.length <= MAX_EDIT_STRING;

// Responses cross the messaging boundary; a JSON round trip guarantees nothing else rides along.
const toJson = (value) => JSON.parse(JSON.stringify(value));

const undoError = (code, message = UNDO_MESSAGES[code]) => ({ error: code, message });
const groupError = (code) => ({ error: code, message: GROUP_MESSAGES[code] });
const groupUndoError = (code) => ({ error: code, message: GROUP_UNDO_MESSAGES[code] });

// The groupAction message's own fields for its action, checked and copied, so nothing else the page sent reaches
// groups.js; null when the action is unknown or a field it needs is missing or malformed. `confirm` is true only
// when sent as true. Close all also carries `confirmTabIds`: the ids of the tabs its confirmation named (whole
// numbers >= 0, each once, capped; [] for anything else), which groups.js holds the confirmation to.
export function cleanGroupAction(message) {
  const action = isObject(message) ? message.action : undefined;
  if (!GROUP_ACTIONS.includes(action)) return null;
  const confirm = message.confirm === true;
  if (action === "removeAll") return { action, confirm };
  const { groupId } = message;
  if (!isGroupId(groupId)) return null;
  if (action === "rename") return isEditString(message.name) ? { action, groupId, name: message.name } : null;
  if (action === "icon") return isEditString(message.icon) ? { action, groupId, icon: message.icon } : null;
  if (action === "collapse") {
    return typeof message.collapsed === "boolean" ? { action, groupId, collapsed: message.collapsed } : null;
  }
  if (action === "closeAll") return { action, groupId, confirm, confirmTabIds: confirmIds(message.confirmTabIds) };
  return { action, groupId };
}

// The options page's view of a settings object (store.js's merged settings, or its defaults), field by field: the
// page settings only, so neither the key nor anything else stored can ride along, and never `thinking`, so a page that
// saves back what it was given never sends it. A key-shaped string is scrubbed: store.js refuses one on save, so only
// damaged storage could hold one.
export function settingsView(settings) {
  const sensitive = isObject(settings?.sensitive) ? settings.sensitive : {};
  return redactKeys({
    model: settings?.model ?? null,
    effort: settings?.effort ?? null,
    precision: settings?.precision ?? null,
    preferences: settings?.preferences ?? null,
    staleDays: settings?.staleDays ?? null,
    sensitive: Object.fromEntries(SENSITIVE_LISTS.map((name) => [name, list(sensitive[name])])),
  });
}

// saveSettings' patch, checked for its shape and copied, or null: a plain object naming at least one page setting and
// nothing else, its `sensitive` (when an object) naming only the three lists. Each value is store.js's to check (the
// single gate), which names the field it refuses.
export function cleanSettingsPatch(patch) {
  if (!isObject(patch)) return null;
  const fields = Object.keys(patch);
  if (!fields.length || !fields.every((field) => PAGE_SETTINGS.includes(field))) return null;
  if (isObject(patch.sensitive) && !Object.keys(patch.sensitive).every((name) => SENSITIVE_LISTS.includes(name))) {
    return null;
  }
  return Object.fromEntries(fields.map((field) => [field, patch[field]]));
}

// resetSettings' field names, each once, or null unless every one is in RESETTABLE_SETTINGS (and there is one). A hole
// in a sparse list (structured clone keeps them) reads as undefined, which no field is.
export function cleanResetFields(fields) {
  const known = (field) => RESETTABLE_SETTINGS.includes(field);
  if (!Array.isArray(fields) || !fields.length || !Array.from(fields).every(known)) return null;
  return [...new Set(fields)];
}

// getGroups' `groupUndo`: whether the last group action can be undone, which kind it was, when, and how many groups
// it touched. Built field by field, so the journal's titles, keys and URLs never leave the background. "done" is the
// only undoable state ("undone" is spent: the undo is one step). Only a journal groups.js's undo would accept is
// offered: its version, with at least one group (it refuses any other as no-journal), so the popup never shows an
// Undo that can only answer "There is no group change to undo".
export function groupUndoStatus(journal) {
  // Only groups that are objects count, as groups.js's journalView reads them.
  const groups = isObject(journal) ? list(journal.groups).filter(isObject) : [];
  if (
    !isObject(journal) || journal.version !== GROUP_JOURNAL_VERSION || journal.state !== "done" ||
    !GROUP_UNDO_TYPES.includes(journal.type) || groups.length === 0
  ) {
    return { available: false };
  }
  return {
    available: true,
    type: journal.type,
    at: Number.isFinite(journal.at) ? journal.at : null,
    groupCount: groups.length,
  };
}

// A report's failures as a refusal may carry them: scope and code (strings) and count (a positive whole number),
// field by field, never the message (it can hold the browser's error text).
export function failureCodes(failures) {
  return list(failures).filter(isObject).map((f) => ({
    scope: typeof f.scope === "string" ? f.scope : null,
    ...(typeof f.code === "string" ? { code: f.code } : {}),
    ...(Number.isInteger(f.count) && f.count > 0 ? { count: f.count } : {}),
  }));
}

// A groups-view row, field by field (listGroups' shape): names and counts only, never a tab's title or address.
const groupRow = (group) => ({
  id: group?.id, name: group?.name, icon: group?.icon, collapsed: group?.collapsed, tabCount: group?.tabCount,
  nonReopenable: group?.nonReopenable,
});

// getState's `undo`: whether the last tidy can be undone, and what the popup needs to offer it (when, how many tabs,
// whether more than one window was open, whether an undo already began on it). Built field by field from the
// journal, so its URLs and old titles never leave the background. `at` is when the apply finished, or when it started
// for one that never finished. `resumable`: an undo stopped partway on this journal (it failed, or Zen closed under
// it; undo.js marks the journal `undoStartedAt` before its first change), so some tabs may already be out of their
// groups and Undo finishes putting them back.
export function undoStatus(journal) {
  const undone = isObject(journal) && journal.undoneAt !== null && journal.undoneAt !== undefined;
  if (!isObject(journal) || undone || !UNDOABLE_STATES.includes(journal.state)) return { available: false };
  const at = journal.state === "done" ? journal.finishedAt : journal.startedAt;
  return {
    available: true,
    state: journal.state,
    at: Number.isFinite(at) ? at : null,
    tabCount: list(journal.tabs).length,
    multiWindow: journal.multiWindow === true,
    resumable: Number.isFinite(journal.undoStartedAt),
  };
}

// Every group id the journal's apply created or joined, as written (only integers).
function journalGroupIds(journal) {
  const joins = list(journal?.joins).map((join) => join?.groupId);
  return new Set([...list(journal?.createdGroupIds), ...joins].filter(Number.isInteger));
}

// The journal's startedAt, which tells one apply's journal from the next; null when it has none.
const startedAtOf = (journal) => (isObject(journal) && Number.isFinite(journal.startedAt) ? journal.startedAt : null);

// createRouter(deps) returns { handle(message, sender) }, which resolves to a JSON response.
// deps: { api, store, runner, validateApplyRequest, applyRequest, takeSnapshot, planUndo, undoTidy, listGroups,
//   groupAction, undoGroupAction, testKey, apiBase, fetchImpl, now = Date.now, newId, log, blockedSince,
//   allowSelftest = false, onOwnGroupChange, renameWaitMs = RENAME_WAIT_MS, wait = sleep }.
//   planUndo(journal, snapshot, allGroups) and undoTidy(api, plan, options) are undo.js's (notes/m3-contracts.md);
//   newId names the undo's run. listGroups(snapshot), groupAction(api, action, options) and
//   undoGroupAction(api, options) are groups.js's (notes/m4-contracts.md); `action` is cleanGroupAction's copy of
//   the message, and groupAction answers a refusal with { error: code, nonReopenable? }.
//   allowSelftest (the dev build's gecko id) admits the self-test page and its dev-only message.
//   renameWaitMs: how long a rename waits for the shared lock before it answers busy; wait(ms) is its timer.
export function createRouter(deps) {
  const {
    api, store, runner, validateApplyRequest, applyRequest, takeSnapshot, planUndo, undoTidy, listGroups, groupAction,
    undoGroupAction, testKey, apiBase, fetchImpl, now = Date.now, newId = () => crypto.randomUUID(), log = SILENT,
    blockedSince = async () => false, allowSelftest = false, onOwnGroupChange = () => {},
    renameWaitMs = RENAME_WAIT_MS, wait = sleep,
  } = deps;
  const allowedPaths = allowSelftest ? [...PAGE_PATHS, SELFTEST_PATH] : PAGE_PATHS;
  // { startedAt } of a journal this instance finished undoing but could not mark undone (spend), or null.
  let spentHere = null;

  // Content scripts' sender ids aren't verified by Firefox, but their URL is the web page's, so the
  // URL prefix rejects them. A sender.tab alone is fine: the options page opens in a tab.
  // Resolves to the allowed page's path prefix (PAGE_PATHS, or SELFTEST_PATH in the dev build), or null.
  function senderPage(sender) {
    if (!isObject(sender) || sender.id !== api.runtime.id) return null;
    const base = api.runtime.getURL("");
    if (typeof sender.url !== "string" || typeof base !== "string" || !base || !sender.url.startsWith(base)) return null;
    let path;
    try {
      // The parsed path has its dot segments resolved, so "/popup/../x" can't pass as a popup page.
      path = new URL(sender.url).pathname;
    } catch {
      return null;
    }
    return allowedPaths.find((prefix) => path.startsWith(prefix)) ?? null;
  }

  // A run write that ends an apply or an undo (or puts back the run from before one that never started). Left
  // "applying" or "undoing", the run would show as still at work, then (getState's stale check) as stopped partway,
  // for work that is over. So it is tried twice, and if storage.session refuses both, the run is removed: getState
  // then shows idle, with the journal's undo offer as it now stands.
  async function settleRun(write) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await write();
        return;
      } catch (err) {
        log.warn("could not store the run", { name: err?.name ?? null, attempt });
      }
    }
    try {
      await store.clearRun();
    } catch (err) {
      log.warn("could not clear the run", { name: err?.name ?? null });
    }
  }

  // cancel and dismiss: back to idle from the states each one may discard.
  async function resetRun(runId, allowedStates) {
    let response = { ok: true };
    await store.updateRun((run) => {
      if (!run || run.state === "idle") return undefined;
      if (run.id !== runId) response = { error: "stale-run" };
      else if (ACTIVE_STATES.has(run.state)) response = { error: "busy" };
      else if (!allowedStates.includes(run.state)) response = { error: "invalid-state" };
      else return idleRun({ id: run.id, windowId: run.windowId });
      return undefined;
    });
    return response;
  }

  // Normal windows open now. The preview's count is stale (a window may have opened since), so Apply reads it
  // again. null when it can't be read; the caller then asks for confirmation to be safe.
  async function countWindows() {
    try {
      return (await api.windows.getAll({ windowTypes: ["normal"] })).length;
    } catch (err) {
      log.warn("could not count windows", { name: err?.name ?? null });
      return null;
    }
  }

  // tabs.query only sees the active Space. When none of the request's tabs (those it groups and those it closes,
  // and, for a rename-only request, none of its existing groups) are in it but some still exist (tabs.get and
  // tabGroups.get see every Space), the person has most likely switched Space since the preview. Tabs that are
  // simply gone are left to applyRequest, which reports them as skipped.
  async function inOtherSpace(windowId, cleaned) {
    const groups = list(cleaned?.groups).filter(isObject);
    const tabIds = [...groups.flatMap((group) => list(group.tabIds)), ...list(cleaned?.close)];
    const groupIds = groups.filter((group) => group.kind === "existing").map((group) => group.groupId);
    if (!tabIds.length && !groupIds.length) return false;
    let visible;
    try {
      visible = await api.tabs.query({ windowId });
    } catch {
      // applyRequest's own snapshot fails the same way, and that is reported.
      return false;
    }
    const visibleTabs = new Set(visible.map((tab) => tab.id));
    const visibleGroups = new Set(visible.map((tab) => tab.groupId));
    if (tabIds.some((id) => visibleTabs.has(id)) || groupIds.some((id) => visibleGroups.has(id))) return false;
    const exists = (lookup) => lookup().then(() => true, () => false);
    const found = await Promise.all([
      ...tabIds.map((id) => exists(() => api.tabs.get(id))),
      ...groupIds.map((id) => exists(() => api.tabGroups.get(id))),
    ]);
    return found.some(Boolean);
  }

  // Runs under the runner's lock, so no tidy can start (or replace the run) meanwhile.
  async function applyLocked(run, cleaned) {
    const isThisPreview = (current) =>
      current?.id === run.id && current.state === "preview" && current.preview?.id === run.preview.id;
    // Checked before the run leaves "preview": in the wrong Space nothing changes at all (no journal, edits kept).
    if (await inOtherSpace(run.windowId, cleaned)) {
      if (!isThisPreview(await store.getRun())) return { error: "stale-run", message: STALE_RUN_MESSAGE };
      return { error: "wrong-space", message: WRONG_SPACE_MESSAGE };
    }
    const { changed } = await store.updateRun((current) =>
      isThisPreview(current) ? { ...current, state: "applying", phase: "apply", heartbeatAt: now() } : undefined,
    );
    if (!changed) return { error: "stale-run", message: STALE_RUN_MESSAGE };

    let report;
    let failure = null;
    try {
      report = await applyRequest(api, cleaned, { windowId: run.windowId, store, now, onOwnGroupChange });
    } catch (err) {
      const notStarted = err?.code === APPLY_NOT_STARTED;
      log.warn("apply failed", { name: err?.name ?? null, notStarted });
      // Nothing changed yet: back to the same preview, edits and all, so the person can simply try again.
      if (notStarted) {
        await settleRun(() => store.updateRun((current) =>
          current?.id === run.id && current.state === "applying"
            ? { ...current, state: "preview", phase: null, heartbeatAt: now() }
            : undefined,
        ));
        return { error: "apply-failed", message: NOT_STARTED_MESSAGE, previewKept: true };
      }
      failure = { kind: "apply-failed", message: ERROR_MESSAGES["apply-failed"], requestId: null };
    }
    // Key-only scrub: the report names groups, and log.js's Bearer rule would rewrite "Bearer bonds".
    const done = failure
      ? { state: "error", error: failure, report: null }
      : { state: "applied", error: null, report: redactKeys(report ?? null) };
    await settleRun(() => store.updateRun((current) =>
      current?.id === run.id && current.state === "applying"
        ? { ...current, ...done, phase: null, preview: null, edits: null, heartbeatAt: now() }
        : undefined,
    ));
    return failure ? { error: failure.kind, message: failure.message } : { ok: true, report: done.report };
  }

  // The window to undo or act in (undo and the groups view). The popup sends its own; without one, the last focused
  // normal window, which is the one whose popup was clicked. Resolved once, so every call after this names the same
  // concrete window. null when the message's id is malformed or no window can be found.
  async function targetWindow(windowId) {
    if (windowId !== undefined) return isWindowId(windowId) ? windowId : null;
    try {
      const focused = await api.windows.getLastFocused({ windowTypes: ["normal"] });
      return isWindowId(focused?.id) ? focused.id : null;
    } catch (err) {
      log.warn("could not find the window to act in", { name: err?.name ?? null });
      return null;
    }
  }

  // Whether this journal was finished with but could not be marked undone (spend). A mark that can't be read counts
  // as none.
  async function isSpent(journal) {
    const startedAt = startedAtOf(journal);
    if (spentHere?.startedAt === startedAt) return true;
    try {
      return (await store.getSpentJournal())?.startedAt === startedAt;
    } catch (err) {
      log.warn("could not read the spent-journal mark", { name: err?.name ?? null });
      return false;
    }
  }

  // Undo finished but could not mark the journal undone (both of undoTidy's final writes failed, its report's
  // "journal" failure). Left as it is, the journal would stay offered, and a second undo would take tabs the person
  // moved loose since for tabs this one lifted out (its undoStartedAt mark). So it is no longer offered: marked spent
  // in this instance and in storage.session (in memory, so independent of a failing storage.local), and removed if
  // storage.local lets it (a remove often goes through where a set failed, on a full quota).
  async function spend(journal) {
    spentHere = { startedAt: startedAtOf(journal) };
    try {
      await store.markJournalSpent(spentHere.startedAt);
    } catch (err) {
      log.warn("could not mark the journal spent", { name: err?.name ?? null });
    }
    try {
      await store.removeJournal();
    } catch (err) {
      log.warn("could not remove the spent journal", { name: err?.name ?? null });
    }
  }

  // A journal undo has nothing to work on anywhere: no tab, no closed tab, and none of its groups left in any Space or
  // window (an apply whose every tab dropped out of its groups). Undo could only answer nothing-to-undo. When the
  // groups can't be read, it counts as something left.
  async function nothingLeft(journal) {
    if (list(journal.tabs).length > 0 || list(journal.closed).length > 0) return false;
    const ids = journalGroupIds(journal);
    if (!ids.size) return true;
    try {
      return !list(await api.tabGroups.query({})).some((group) => ids.has(group?.id));
    } catch (err) {
      log.warn("could not read the groups", { name: err?.name ?? null });
      return false;
    }
  }

  // The refusal for tabs that aren't in this Space: wrong-space, or other-window when every group of the tidy still
  // there is in another window (allGroups: tabGroups.query({}), every window), which no Space of this one can show.
  function spaceRefusal(journal, allGroups, windowId) {
    const ids = journalGroupIds(journal);
    const found = list(allGroups).filter((group) => ids.has(group?.id) && Number.isInteger(group.windowId));
    return found.length > 0 && found.every((group) => group.windowId !== windowId)
      ? undoError("other-window")
      : undoError("wrong-space");
  }

  // nothing-to-undo. With 2+ normal windows open the tabs may be in another one, ungrouped since, so the message
  // says where else to look.
  async function nothingRefusal() {
    const windowCount = await countWindows();
    return windowCount > 1 ? undoError("nothing-to-undo", NOTHING_HERE_MANY_WINDOWS) : undoError("nothing-to-undo");
  }

  // Runs under the runner's lock, so no tidy or apply can start, or write a new journal, meanwhile. Everything up to
  // undoTidy only reads (the journal, a fresh snapshot, every Space's groups), so each refusal before it leaves the
  // run and the journal exactly as they were. The refusals come before the multi-window confirmation: confirming
  // would only lead to them.
  async function undoLocked(windowId, confirmed) {
    let journal;
    let allGroups;
    let plan;
    try {
      journal = await store.readJournal();
      if (!undoStatus(journal).available || (await isSpent(journal))) return undoError("no-journal");
      const snapshot = await takeSnapshot(api, { windowId });
      // tabGroups.query({}) sees every Space and window: it is how planUndo tells "in another Space" from "gone".
      allGroups = await api.tabGroups.query({});
      plan = planUndo(journal, snapshot, allGroups);
    } catch (err) {
      log.warn("undo could not start", { name: err?.name ?? null });
      return undoError("undo-failed", UNDO_MESSAGES["not-started"]);
    }
    if (plan?.status === "wrong-space") return spaceRefusal(journal, allGroups, windowId);
    if (plan?.status !== "ready") return nothingRefusal();
    // Counted now, like Apply's: a window opened since the tidy counts too. A tidy made with 2+ windows open is
    // flagged in the journal (window sync may have lost groups and keys), so it needs the same confirmation.
    const windowCount = await countWindows();
    const multiWindow =
      journal.multiWindow === true || plan.multiWindow === true || windowCount === null || windowCount > 1;
    if (multiWindow && !confirmed) {
      return { ...undoError("multi-window-unconfirmed"), windowCount };
    }

    // A run of its own: whatever the popup showed before (an applied report, an idle view) is replaced, and comes
    // back if undo stops before changing anything.
    const runId = String(newId());
    let previous = null;
    await store.updateRun((current) => {
      previous = current;
      const at = now();
      return idleRun({ id: runId, state: "undoing", windowId, startedAt: at, heartbeatAt: at, phase: "undo" });
    });
    const isThisUndo = (current) => current?.id === runId && current.state === "undoing";

    let report;
    let failure = null;
    try {
      report = await undoTidy(api, plan, { windowId, store, journal, onOwnGroupChange, now });
    } catch (err) {
      // UndoNotStartedError: undoTidy stopped before its first change, so the browser and the journal are untouched
      // and the run goes back to what it was. Its re-check may have found the tabs gone or in another Space since the
      // plan above; that gets the same answer as a refusal here.
      const notStarted = err?.code === UNDO_NOT_STARTED;
      log.warn("undo failed", { name: err?.name ?? null, notStarted });
      if (notStarted) {
        await settleRun(() => store.updateRun((current) => (isThisUndo(current) ? (previous ?? idleRun()) : undefined)));
        if (err.status === "wrong-space") {
          let groups = [];
          try {
            groups = await api.tabGroups.query({});
          } catch (readErr) {
            log.warn("could not read the groups", { name: readErr?.name ?? null });
          }
          return spaceRefusal(journal, groups, windowId);
        }
        if (err.status === "nothing") return nothingRefusal();
        return undoError("undo-failed", UNDO_MESSAGES["not-started"]);
      }
      // Some tabs may be back already. undoTidy marks the journal undone only when it finishes, so it is still
      // "done" (or "applying") and the same undo can be tried again. undoTidy flags the journal right before its
      // first change, so that retry also puts back the tabs the first attempt had lifted out but not yet placed.
      failure = undoFailedError();
    }
    if (!failure && report?.retryable === true) {
      // undoTidy got through but left tabs it could not place, and wrote the journal back as undoable (with its
      // mark) rather than undone: the same answer as a throw after the first change, so Try again finishes it.
      failure = undoFailedError();
    } else if (!failure && list(report?.failures).some((f) => f?.scope === "journal")) {
      await spend(journal);
    }
    // Key-only scrub, as for Apply: the report lists the current titles of the tabs it left alone.
    const done = failure
      ? { state: "error", error: failure, report: null }
      : { state: "undone", error: null, report: redactKeys(report ?? null) };
    await settleRun(() => store.updateRun((current) =>
      isThisUndo(current) ? { ...current, ...done, phase: null, heartbeatAt: now() } : undefined,
    ));
    return failure ? { error: failure.kind, message: failure.message } : { ok: true, report: done.report };
  }

  // getState's `undo`. An unreadable journal hides the offer rather than failing the whole getState, and so does a
  // journal undo already finished with (isSpent) or one with nothing left to undo anywhere (nothingLeft).
  async function readUndoStatus() {
    try {
      const journal = await store.readJournal();
      const status = undoStatus(journal);
      if (!status.available || (await isSpent(journal)) || (await nothingLeft(journal))) return { available: false };
      return status;
    } catch (err) {
      log.warn("could not read the undo journal", { name: err?.name ?? null });
      return { available: false };
    }
  }

  // getGroups' `groupUndo`. An unreadable group journal hides the offer rather than failing the view.
  async function readGroupUndoStatus() {
    try {
      return groupUndoStatus(await store.readGroupJournal());
    } catch (err) {
      log.warn("could not read the group journal", { name: err?.name ?? null });
      return { available: false };
    }
  }

  // What groups.js answered, as a response: a refusal ({ error: code }) keeps its code when the message knows it,
  // with the router's own text, and close-all's confirm-needed keeps the titles of the tabs Undo couldn't reopen
  // (strings only, shown in the popup, never stored; remove all's has none) and their ids (whole numbers only, no
  // address or title), which the popup sends back as confirmTabIds; anything else is the report. Of
  // undo-failed's partial report only its failures' scope, code and count go out (failureCodes), so the popup can
  // say why (no tab could safely start a group: switch tabs first); never a message, title or moved tab. Nothing
  // else a refusal carries goes out. Key-only scrub, as for Apply: the report names groups and tabs.
  function groupOutcome(result, messages, fallback) {
    if (!isObject(result) || typeof result.error !== "string") return { ok: true, report: redactKeys(result ?? null) };
    const code = Object.hasOwn(messages, result.error) ? result.error : fallback;
    const refusal = { error: code, message: messages[code] };
    if (code === "confirm-needed" && Array.isArray(result.nonReopenable)) {
      refusal.nonReopenable = redactKeys(result.nonReopenable.filter((title) => typeof title === "string"));
    }
    if (code === "confirm-needed" && Array.isArray(result.nonReopenableIds)) {
      refusal.nonReopenableIds = confirmIds(result.nonReopenableIds);
    }
    if (code === "undo-failed" && result.error === "undo-failed" && Array.isArray(result.report?.failures)) {
      refusal.failures = failureCodes(result.report.failures);
    }
    return refusal;
  }

  // A throw from groups.js: its code when the message knows it (a refusal it throws rather than returns), else the
  // fallback. Only the error's name and code are logged: its text may hold a title.
  function groupFailure(err, messages, fallback, what) {
    const code = typeof err?.code === "string" && Object.hasOwn(messages, err.code) ? err.code : fallback;
    log.warn(what, { name: err?.name ?? null, code });
    return { error: code, message: messages[code] };
  }

  // Runs under the runner's lock, so no tidy, apply, undo or other group action overlaps it. groups.js re-checks
  // the group right before acting and writes its own journal (never the tidy one). No run is written: the actions
  // are short, and the run the popup shows (a preview, an applied report) stays as it was.
  async function groupActionLocked(windowId, action) {
    let result;
    try {
      result = await groupAction(api, action, { windowId, store, now, onOwnGroupChange });
    } catch (err) {
      return groupFailure(err, GROUP_MESSAGES, "action-failed", "group action failed");
    }
    const response = groupOutcome(result, GROUP_MESSAGES, "action-failed");
    if (response.error === "confirm-needed" && action.action === "removeAll") {
      response.message = REMOVE_ALL_CONFIRM_MESSAGE;
    }
    return response;
  }

  // The same for the group action's undo. The journal is checked first, so a missing, damaged or spent one is
  // refused before groups.js reads any tab.
  async function undoGroupActionLocked(windowId) {
    let result;
    try {
      if (!groupUndoStatus(await store.readGroupJournal()).available) return groupUndoError("no-journal");
      result = await undoGroupAction(api, { windowId, store, now, onOwnGroupChange });
    } catch (err) {
      return groupFailure(err, GROUP_UNDO_MESSAGES, "undo-failed", "group undo failed");
    }
    return groupOutcome(result, GROUP_UNDO_MESSAGES, "undo-failed");
  }

  // Dev build only: the self-test page's messages. zen_flow sets the stale-days setting to 0 (tabs.create sets
  // lastAccessed to now, so nothing it seeds is stale otherwise) and back. A release build never has them: its id
  // isn't the dev id, so this table is empty and the self-test page is refused like any other sender.
  const devHandlers = allowSelftest
    ? {
      async devSetStaleDays({ staleDays }) {
        try {
          return { ok: true, staleDays: (await store.saveSettings({ staleDays })).staleDays };
        } catch (err) {
          if (err?.code !== "invalid-settings") throw err;
          return { error: "invalid-request", message: `Stale days must be a whole number from 0 to ${MAX_STALE_DAYS}.` };
        }
      },
    }
    : {};

  const handlers = {
    async getState({ windowId }) {
      // The stale check lives here, so a popup opened after the background died shows the failure.
      const run = (await runner.expireStale()) ?? idleRun();
      const { saved } = await store.getKeyStatus();
      // Both null when unknown. canTidy is start's own nothing-to-tidy rule, so the popup never offers a tidy that
      // would be refused (one loose tab and no group to join).
      let looseCount = null;
      let canTidy = null;
      // A snapshot writes tab keys; while a tidy or apply is running, it would race with theirs.
      if (isWindowId(windowId) && !runner.isBusy()) {
        try {
          ({ looseCount, canTidy } = await runner.looseStatus(windowId));
        } catch (err) {
          log.warn("could not count loose tabs", { name: err?.name ?? null });
        }
      }
      return { run, hasKey: saved, looseCount, canTidy, undo: await readUndoStatus() };
    },

    async startTidy({ windowId }) {
      return runner.start(windowId);
    },

    // The popup's whole editor state (popup-state.js Edits), checked against the stored preview and stored as a
    // fresh copy, so reopening the popup restores exactly what the person saw.
    async saveEdits({ runId, edits }) {
      if (!isObject(edits)) return { error: "invalid-request" };
      let response = { error: "stale-run" };
      await store.updateRun((run) => {
        if (run?.id !== runId || run.state !== "preview") return undefined;
        const checked = validateEdits(edits, run.preview);
        response = checked.ok ? { ok: true } : { error: "invalid-request" };
        return checked.ok ? { ...run, edits: checked.edits } : undefined;
      });
      return response;
    },

    async cancel({ runId }) {
      return resetRun(runId, ["preview"]);
    },

    async apply({ runId, request, confirmMultiWindow }) {
      if (!isObject(request)) return { error: "invalid-request", message: "The apply request is malformed." };
      const run = await store.getRun();
      if (!run || run.id !== runId || run.state !== "preview" || !run.preview || request.previewId !== run.preview.id) {
        return { error: "stale-run", message: STALE_RUN_MESSAGE };
      }
      // Counted now, not taken from the preview: a window opened since the tidy counts too.
      const windowCount = await countWindows();
      if ((windowCount === null || windowCount > 1) && confirmMultiWindow !== true) {
        return { error: "multi-window-unconfirmed", windowCount, message: MULTI_WINDOW_MESSAGE };
      }
      const checked = validateApplyRequest(request, run.preview);
      if (!checked?.ok) {
        // validateApplyRequest reports a short code ("too-many-tabs", ...); keep it for debugging.
        const code = typeof checked?.error === "string" && checked.error ? ` (${checked.error})` : "";
        return { error: "invalid-request", message: redact(`The changes can't be applied${code}.`) };
      }
      try {
        return await runner.withLock(() => applyLocked(run, checked.request));
      } catch (err) {
        if (err?.code === "busy") return { error: "busy" };
        throw err;
      }
    },

    // Undoes the last tidy (notes/m3-contracts.md, "Messages"). Under the shared lock, so it never overlaps a tidy
    // or an apply. Run state "undoing", then "undone" with the UndoReport.
    async undo({ windowId, confirmMultiWindow }) {
      const target = await targetWindow(windowId);
      if (target === null) return undoError("invalid-request");
      try {
        return await runner.withLock(() => undoLocked(target, confirmMultiWindow === true));
      } catch (err) {
        if (err?.code === "busy") return undoError("busy");
        throw err;
      }
    },

    // The groups view (notes/m4-contracts.md, "Messages"): the tidy groups in the window's current Space, in strip
    // order, and whether the last group action can be undone. No URLs: rows are names and counts.
    async getGroups({ windowId }) {
      const target = await targetWindow(windowId);
      if (target === null) return groupError("invalid-request");
      // A snapshot writes tab keys; while a tidy, an apply, an undo or a group action runs it would race with theirs.
      if (runner.isBusy()) return groupError("busy");
      const snapshot = await takeSnapshot(api, { windowId: target });
      const groups = list(listGroups(snapshot)).map(groupRow);
      return { groups: redactKeys(groups), groupUndo: await readGroupUndoStatus() };
    },

    // Rename, re-icon, collapse, ungroup, close all, or remove every tidy group, under the shared lock. A rename
    // waits for the lock (RENAME_WAIT_MS) rather than answering busy at once; groups.js re-checks the group anyway.
    async groupAction(message) {
      const action = cleanGroupAction(message);
      const target = action ? await targetWindow(message.windowId) : null;
      if (target === null) return groupError("invalid-request");
      const patience = action.action === "rename" && Number.isFinite(renameWaitMs) ? Math.max(0, renameWaitMs) : 0;
      for (let waited = 0; ; ) {
        try {
          return await runner.withLock(() => groupActionLocked(target, action));
        } catch (err) {
          if (err?.code !== "busy") throw err;
          if (waited >= patience) return groupError("busy");
        }
        const step = Math.min(LOCK_POLL_MS, patience - waited);
        await wait(step);
        waited += step;
      }
    },

    // Undoes the last ungroup, close all or remove all, under the shared lock. Never the tidy undo: its own slot.
    async undoGroupAction({ windowId }) {
      const target = await targetWindow(windowId);
      if (target === null) return groupUndoError("invalid-request");
      try {
        return await runner.withLock(() => undoGroupActionLocked(target));
      } catch (err) {
        if (err?.code === "busy") return groupUndoError("busy");
        throw err;
      }
    },

    async dismiss({ runId }) {
      return resetRun(runId, ["applied", "error", "undone"]);
    },

    // Settings (notes/m6-contracts.md, "Messages"). None of them takes the shared lock: saving while a tidy runs is
    // allowed, and that tidy keeps the settings it read when it started (run.js reads them once, before its first
    // call); the next tidy reads the new ones.
    async getSettings() {
      const settings = await store.getSettings();
      return { settings: settingsView(settings), defaults: settingsView(store.getDefaultSettings()) };
    },

    // The patch holds only the fields being changed, each list whole as edited. A value store.js refuses is
    // { error: "invalid-settings", field, message }, with store.js's message (it never holds the value).
    async saveSettings({ patch }) {
      const clean = cleanSettingsPatch(patch);
      if (!clean) return { error: "invalid-request", message: SETTINGS_REQUEST_MESSAGE };
      try {
        return { ok: true, settings: settingsView(await store.saveSettings(clean)) };
      } catch (err) {
        if (err?.code !== "invalid-settings") throw err;
        return { error: "invalid-settings", field: err.field ?? null, message: err.message };
      }
    },

    async resetSettings({ fields }) {
      const names = cleanResetFields(fields);
      if (!names) return { error: "invalid-request", message: SETTINGS_REQUEST_MESSAGE };
      return { ok: true, settings: settingsView(await store.resetSettings(names)) };
    },

    async getKeyStatus() {
      return store.getKeyStatus();
    },

    async saveKey({ key }) {
      try {
        await store.saveKey(key);
        return { ok: true };
      } catch (err) {
        if (err?.code === "invalid-key-format") return { error: "invalid-key-format" };
        throw err;
      }
    },

    async clearKey() {
      await store.clearKey();
      return { ok: true };
    },

    async testKey() {
      const apiKey = await store.readKey();
      if (!apiKey) return { error: "no-key", message: "No API key is saved." };
      const startedAt = now();
      const result = await testKey(apiKey, { fetchImpl, apiBase });
      if (result?.ok) return { ok: true };
      const blocked = result?.error?.kind === "network" && (await blockedSince(startedAt));
      const { kind, message } = describeError(result?.error, { blocked, secret: apiKey });
      return { error: kind, message };
    },
  };

  async function handle(message, sender) {
    try {
      const page = senderPage(sender);
      if (!page) return { error: "forbidden" };
      const type = isObject(message) ? message.type : undefined;
      if (typeof type === "string" && Object.hasOwn(devHandlers, type)) {
        // Even in the dev build, only the self-test page may send these, never the popup or Settings.
        if (page !== SELFTEST_PATH) return { error: "forbidden" };
        return toJson(await devHandlers[type](message));
      }
      if (typeof type !== "string" || !Object.hasOwn(handlers, type)) return { error: "unknown-message" };
      return toJson(await handlers[type](message));
    } catch (err) {
      log.error("message handler failed", { name: err?.name ?? null });
      return { error: "internal", message: ERROR_MESSAGES.internal };
    }
  }

  return { handle };
}
