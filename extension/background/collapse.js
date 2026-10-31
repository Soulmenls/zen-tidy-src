// Collapsed-state memory for tidy groups. Rules: notes/m5-contracts.md, section 3 (binding); implementation-notes,
// "Collapsed state (M0)" and tabGroups.onRemoved. The browser comes in as `api` and storage as `store` (store.js:
// getCollapsedGroups, setGroupCollapsed, forgetCollapsedGroups, on storage.local.collapsed with serialized writes).
//
// Why. Zen expands every collapsed plain group on restore, before the background loads and without an onUpdated
// event, and SessionStore then saves them expanded. So the state lives in storage.local, by group id (ids survive a
// restart, window ids don't), and runtime.onStartup puts it back.
//
// Attribution. A user collapse and an API collapse look the same in tabGroups.onUpdated, so only suppression windows
// tell them apart. Apply, undo and the groups view call suppress(groupId) (the router's onOwnGroupChange) before every
// change they make to a group: for SUPPRESS_MS after the latest call, that group's events are not the person's. When
// the window closes, the group is read back (tabGroups.get) and, if it is still a tidy group, its state as it now is
// gets recorded. So our own changes record their final state (apply re-collapsing a group it joined, undo putting
// a state back, the groups view's toggle, which is the person's choice made through us), and a collapse the person
// made during the window is caught too. Outside a window, an event for a tidy group is the person's and is recorded.
// A tidy group here is a SIG title that isn't a Zen folder; the event or the read-back carries no tabs to check.
//
// Settling. The read-back comes SUPPRESS_MS after the last change, and a background gone by then (Zen quitting, the
// add-on reloading) never runs it. So once apply, undo or a groups-view action is done, settle(groupIds) reads back
// the groups it changed at once (main.js). Their windows stay open, so an event that comes later is still covered by
// the read-back when each closes.
//
// Moves. A group moved to another window is rebuilt expanded with the same id, and Zen sends only tabGroups.onMoved
// for it (no onUpdated). So a move opens the group's window, unless one is open already, and the read-back records
// the group as it is after the move; inside that window the collapse and expand of a drag go to the read-back too. A
// move never collapses a group again: the drag's collapse was the person's, and recorded as theirs.
//
// Startup. Events from the background's load until runtime.onStartup or onInstalled are held. onStartup drops them
// (the restore's, not the person's); onInstalled applies them, as does STARTUP_HOLD_MS passing with neither (an event
// page woken by the event itself gets neither). onStartup then collapses every recorded group that exists and is still
// a tidy group again, under suppression, and looks once more after STARTUP_RECHECK_MS: a recorded group expanded by
// then (again, or one that only turned up since) is collapsed again, unless our own change or the person's recorded
// one touched it meanwhile, and the entries of groups still missing are dropped. Until that look, no read-back
// records a recorded group: the re-check decides it. An expand the person makes inside the startup window can't be
// told from Zen's restore, so the re-check collapses that group again too. When onStartup can't read the recorded
// groups, the re-check's own reading stands in: it decides every group it finds recorded that nothing touched since.
//
// Removals. tabGroups.onRemoved fires for every group of a closing window (isWindowClosing: true), shutdown included,
// and the page may die before it handles them all: those are ignored, so the groups come back collapsed. Any other
// removal drops the entry once tabGroups.get confirms the group is gone. Zen fires the removal and then animates the
// group out before it takes it away, and tabGroups.get finds it until then: a group that still answers is looked at
// once more after REMOVAL_SETTLE_MS. A held event for a group confirmed gone is dropped too, so it can't write the
// entry back.

import { isTidyTitle } from "./markers.js";
import { FOLDER_COLOR } from "./snapshot.js";

export const SUPPRESS_MS = 1500;
export const STARTUP_HOLD_MS = 3000;
export const STARTUP_RECHECK_MS = 1500;
// Well above Zen's 100 ms animation of a removed group (ZenVerticalTabsManager animateItemClose; tabgroup.mjs fires
// TabGroupRemoved before it).
export const REMOVAL_SETTLE_MS = 500;

const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const defaultSetTimer = (fn, ms) => setTimeout(fn, ms);
const defaultClearTimer = (id) => clearTimeout(id);
const isGroupId = (value) => Number.isSafeInteger(value) && value >= 0;
const isTidyGroup = (group) => isTidyTitle(group?.title) && group.color !== FOLDER_COLOR;
const errorName = (err) => ({ name: err?.name ?? null });
const heldEvent = (group) =>
  ({ id: group.id, title: group.title, color: group.color, collapsed: group.collapsed === true });

// createCollapseTracker({ api, store, now, setTimer, clearTimer, log }) returns
// { suppress(groupId), settle(groupIds), onUpdated(group), onMoved(group), onRemoved(group, removeInfo), onStartup(),
// onInstalled() }. The handlers resolve once their work is stored and never reject: a failure is logged and costs only
// that one record. Holding starts here, so the tracker is made when the background loads. setTimer and clearTimer work
// like setTimeout and clearTimeout, and now like Date.now.
export function createCollapseTracker({
  api, store, now = Date.now, setTimer = defaultSetTimer, clearTimer = defaultClearTimer, log = SILENT,
}) {
  // groupId -> { until, timer }: the open suppression windows.
  const windows = new Map();
  // groupId -> how many of the person's changes have been recorded: a read-back that began before one is stale.
  const userChanges = new Map();
  // The recorded groups at onStartup, whose state the re-check still decides: no read-back records them before it. An
  // own change or a recorded change of the person's takes a group out of its hands.
  const owned = new Set();
  // Set when onStartup could not read the recorded groups: until the re-check has looked, it decides every group but
  // those taken out of its hands since (`taken`), as it would have decided the ones onStartup read.
  let unread = false;
  const taken = new Set();
  // Events held since load (null once released), and the timer that applies them.
  let held = [];
  let holdTimer = setTimer(() => {
    holdTimer = null;
    applyHeld(release());
  }, STARTUP_HOLD_MS);

  async function readGroup(groupId) {
    try {
      return await api.tabGroups.get(groupId);
    } catch {
      return null;
    }
  }

  // Whether the startup re-check still decides the group.
  const owns = (groupId) => owned.has(groupId) || (unread && !taken.has(groupId));

  // Takes the group out of the re-check's hands.
  function take(groupId) {
    owned.delete(groupId);
    if (unread) taken.add(groupId);
  }

  async function record(groupId, collapsed) {
    try {
      await store.setGroupCollapsed(groupId, collapsed);
    } catch (err) {
      log.warn("could not store a group's collapsed state", errorName(err));
    }
  }

  async function forget(groupIds) {
    try {
      await store.forgetCollapsedGroups(groupIds);
    } catch (err) {
      log.warn("could not drop the collapsed state of removed groups", errorName(err));
    }
  }

  async function collapseAgain(groupId) {
    try {
      await api.tabGroups.update(groupId, { collapsed: true });
    } catch (err) {
      log.warn("could not collapse a group again", errorName(err));
    }
  }

  // Opens a window, or moves its end later; a window never ends sooner than it already would.
  function open(groupId) {
    const until = now() + SUPPRESS_MS;
    const current = windows.get(groupId);
    if (current && current.until >= until) return;
    if (current) clearTimer(current.timer);
    windows.set(groupId, { until, timer: setTimer(() => close(groupId), SUPPRESS_MS) });
  }

  function close(groupId) {
    windows.delete(groupId);
    return readBack(groupId);
  }

  // The group as it now is, recorded when it is still a tidy group. A group that is gone records nothing and keeps its
  // entry: onRemoved or the next startup's re-check drops it. The reading is stale, and dropped, when a window opened
  // or moved its end meanwhile (its own read-back comes later) or the person's change was recorded since; the startup
  // re-check's groups wait for it. A window already open when the reading begins (settle's) doesn't make it stale.
  async function readBack(groupId) {
    const changes = userChanges.get(groupId) ?? 0;
    const atStart = windows.get(groupId);
    const stale = () => owns(groupId) || windows.get(groupId) !== atStart || (userChanges.get(groupId) ?? 0) !== changes;
    if (stale()) return;
    const group = await readGroup(groupId);
    if (!stale() && group && isTidyGroup(group)) await record(groupId, group.collapsed === true);
  }

  // The person's change, from an event outside any window.
  async function recordUser(group) {
    if (!isTidyGroup(group)) return;
    userChanges.set(group.id, (userChanges.get(group.id) ?? 0) + 1);
    take(group.id);
    await record(group.id, group.collapsed === true);
  }

  // Ends holding; returns the events held.
  function release() {
    const events = held ?? [];
    held = null;
    if (holdTimer !== null) clearTimer(holdTimer);
    holdTimer = null;
    return events;
  }

  // In the order they came: each record joins the store's chain as it is called, so the last event for a group wins.
  async function applyHeld(events) {
    await Promise.all(events.map(recordUser));
  }

  // One look, STARTUP_RECHECK_MS after onStartup, at every recorded group: one recorded at onStartup (any, when
  // onStartup couldn't read them) that is a tidy group and is expanded (again, or since it turned up), with nothing
  // changing it since, is collapsed again; the entries of groups still missing go.
  async function recheck() {
    let ids = [];
    try {
      ids = await store.getCollapsedGroups();
    } catch (err) {
      log.warn("could not read the collapsed groups", errorName(err));
    }
    const gone = [];
    await Promise.all([...new Set([...ids, ...owned])].map(async (groupId) => {
      const group = await readGroup(groupId);
      const decides = owns(groupId);
      take(groupId);
      if (!group) {
        gone.push(groupId);
      } else if (decides && isTidyGroup(group) && group.collapsed !== true) {
        open(groupId);
        await collapseAgain(groupId);
      }
    }));
    unread = false;
    taken.clear();
    if (gone.length) await forget(gone);
  }

  return {
    // Opens (or extends) the group's suppression window. A held event for the group is older than the read-back this
    // window ends with, so it goes; and the re-check no longer decides the group.
    suppress(groupId) {
      if (!isGroupId(groupId)) return;
      open(groupId);
      take(groupId);
      if (held) held = held.filter((event) => event.id !== groupId);
    },

    // Reads back each group at once, as its window's read-back will, and leaves the window open: for apply, undo and
    // the groups view once they are done, with the groups they changed.
    async settle(groupIds) {
      const ids = new Set((Array.isArray(groupIds) ? groupIds : []).filter(isGroupId));
      await Promise.all([...ids].map(readBack));
    },

    // Attributed when it comes: inside a window it is ours and the read-back covers it, so it is never held.
    async onUpdated(group) {
      const groupId = group?.id;
      if (!isGroupId(groupId) || windows.has(groupId)) return;
      if (held) {
        held.push(heldEvent(group));
        return;
      }
      await recordUser(group);
    },

    // The group's state after the move goes to a window's read-back (header, "Moves"); held like onUpdated. A window
    // already open reads it back after the move too, and isn't moved on: apply's last changes are group moves, and its
    // settle's reading would go stale.
    async onMoved(group) {
      const groupId = group?.id;
      if (!isGroupId(groupId) || !isTidyGroup(group)) return;
      if (held) held.push(heldEvent(group));
      else if (!windows.has(groupId)) open(groupId);
    },

    async onRemoved(group, removeInfo) {
      const groupId = group?.id;
      if (!isGroupId(groupId) || removeInfo?.isWindowClosing === true) return;
      if (await readGroup(groupId)) {
        // Zen may still be animating it out.
        await new Promise((resolve) => setTimer(resolve, REMOVAL_SETTLE_MS));
        if (await readGroup(groupId)) return;
      }
      if (held) held = held.filter((event) => event.id !== groupId);
      await forget([groupId]);
    },

    async onStartup() {
      release();
      setTimer(() => recheck(), STARTUP_RECHECK_MS);
      let ids;
      try {
        ids = await store.getCollapsedGroups();
      } catch (err) {
        log.warn("could not read the collapsed groups", errorName(err));
        // The re-check's reading stands in. It queues behind this one on the store's chain, so this is set before the
        // re-check looks.
        unread = true;
        return;
      }
      // Each one the re-check's to decide, a group not there yet (still being restored) included.
      for (const groupId of ids) owned.add(groupId);
      await Promise.all(ids.map(async (groupId) => {
        const group = await readGroup(groupId);
        if (!group || !isTidyGroup(group) || !owned.has(groupId)) return;
        open(groupId);
        await collapseAgain(groupId);
      }));
    },

    async onInstalled() {
      await applyHeld(release());
    },
  };
}
