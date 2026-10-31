// Snapshot of the current window's active Space: loose tabs, tidy groups and everything we must not touch.
// Takes a `browser`-like `api` so tests can pass a fake. Rules: notes/implementation-notes.md ("Zen / Firefox facts").

import { isTidyTitle, parseTitle } from "./markers.js";

// sessions value that identifies a tab across restarts (tab ids don't survive one).
export const TAB_KEY = "zt-key";
// sessions value { url, title, at? } that undo writes on a closed tab it reopens (`at`: ms, when it wrote it). Reopened
// and discarded before it loaded, such a tab reads about:blank with no title, even after a restart, until it is
// activated (M3 spike).
export const REOPEN_KEY = "zt-reopen";
const BLANK_URL = "about:blank";
// Zen folders report this colour; plain groups never use it.
export const FOLDER_COLOR = "zen-workspace-color";
const NO_GROUP = -1;
// Glance width heuristic: narrower than this share of the widest loaded loose tab.
const GLANCE_WIDTH_RATIO = 0.9;

export async function takeSnapshot(api, { windowId, newKey = () => crypto.randomUUID(), now = Date.now } = {}) {
  // tabs.query({windowId: undefined}) would return every window's tabs, and the negative sentinels
  // (WINDOW_ID_CURRENT -2, WINDOW_ID_NONE -1) re-resolve at apply time to whichever window is focused then.
  // Apply re-checks tabs against snapshot.windowId and passes it to tabs.group, so it must be a real id.
  if (!Number.isInteger(windowId) || windowId < 0) throw new TypeError("takeSnapshot needs a concrete windowId");

  const [rawTabs, rawGroups, windows] = await Promise.all([
    api.tabs.query({ windowId }),
    api.tabGroups.query({ windowId }),
    api.windows.getAll({ windowTypes: ["normal"] }),
  ]);

  const tabs = rawTabs.map(toTab);
  await Promise.all([assignKeys(api, tabs, newKey), readReopened(api, tabs)]);

  // tabGroups.query returns groups from every Space; keep only those with a tab we can actually see.
  const visibleGroupIds = new Set(tabs.map((t) => t.groupId));
  const groups = rawGroups.filter((g) => visibleGroupIds.has(g.id)).map(toGroup);

  const tidyGroups = [];
  const untouchableGroupIds = [];
  for (const group of groups) {
    const members = tabs.filter((t) => t.groupId === group.id);
    if (isTidyGroup(group, members)) {
      const { name, icon } = parseTitle(group.title);
      tidyGroups.push({ id: group.id, name, icon, collapsed: group.collapsed, tabIds: members.map((t) => t.id) });
    } else {
      untouchableGroupIds.push(group.id);
    }
  }

  // Split views look exactly like unnamed groups, so every "" group is treated as a split. A tab whose group
  // tabGroups.query didn't return (created between the two parallel queries) may be in a new split, so it is
  // listed too: M2 uses splitTabIds to refuse anchors, and anchoring inside a split corrupts it at restart.
  const knownGroupIds = new Set(groups.map((g) => g.id));
  const splitGroupIds = new Set(groups.filter((g) => g.title === "").map((g) => g.id));
  const isSplitTab = (t) => splitGroupIds.has(t.groupId) || (t.groupId !== NO_GROUP && !knownGroupIds.has(t.groupId));

  return {
    windowId,
    takenAt: now(),
    tabs,
    groups,
    tidyGroups,
    looseTabIds: tabs.filter(isLoose).map((t) => t.id),
    splitTabIds: tabs.filter(isSplitTab).map((t) => t.id),
    untouchableGroupIds,
    glanceSuspectIds: glanceSuspects(tabs),
    activeTabId: tabs.find((t) => t.active)?.id ?? null,
    windowCount: windows.length,
  };
}

// Tidy group: SIG title, not a Zen folder, and every visible tab unpinned. Callers pass only groups with ≥1 visible tab.
function isTidyGroup(group, members) {
  return isTidyTitle(group.title) && group.color !== FOLDER_COLOR && members.length > 0 && members.every((t) => !t.pinned);
}

function isLoose(tab) {
  return !tab.pinned && tab.groupId === NO_GROUP;
}

// Glance tabs can't be detected reliably (M0). These signals only pre-untick tabs in the preview; never refuse on them.
// Returns ids of loose tabs that are narrower than 0.9x the widest loaded loose tab, or whose index is out of order.
export function glanceSuspects(tabs) {
  const loose = tabs.filter(isLoose);
  // Discarded tabs report width 0 (or a stale one), so they neither set the reference nor get flagged.
  const measured = loose.filter((t) => !t.discarded && Number.isFinite(t.width) && t.width > 0);
  const widest = measured.reduce((max, t) => Math.max(max, t.width), 0);
  const suspects = new Set(measured.filter((t) => t.width < widest * GLANCE_WIDTH_RATIO).map((t) => t.id));
  for (const id of outOfOrderIds(tabs)) suspects.add(id);
  return loose.filter((t) => suspects.has(t.id)).map((t) => t.id);
}

// Indices have gaps (zen-empty-tab), so "in order" means strictly increasing along the array. A tab is in order only
// if it belongs to every longest strictly increasing run: [0, 1, 9, 2, 3] flags just the 9, not its neighbours.
// When the culprit is ambiguous ([0, 5, 1], or a repeated index) both candidates are flagged; over-flagging only
// pre-unticks a tab, while missing a Glance breaks it.
function outOfOrderIds(tabs) {
  const items = tabs.filter((t) => Number.isInteger(t.index));
  const indices = items.map((t) => t.index);
  const endingAt = runLengths(indices);
  const startingAt = runLengths(indices.map((x) => -x).reverse()).reverse();
  const longest = endingAt.reduce((max, len) => Math.max(max, len), 0);
  // Positions on some longest run, counted by their place in it; a place shared by several positions is ambiguous.
  const onRun = endingAt.map((len, i) => len + startingAt[i] - 1 === longest);
  const perPlace = new Map();
  endingAt.forEach((len, i) => onRun[i] && perPlace.set(len, (perPlace.get(len) ?? 0) + 1));
  return items.filter((_, i) => !onRun[i] || perPlace.get(endingAt[i]) > 1).map((t) => t.id);
}

// Length of the longest strictly increasing run ending at each position (patience sorting, O(n log n)).
function runLengths(values) {
  const tails = []; // tails[k] = smallest last value of an increasing run of length k + 1
  return values.map((x) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
    return lo + 1;
  });
}

// Read each tab's key; give keyless tabs a new one, and on a shared key (copied by duplicate/restore) re-key the
// higher id. Only tabs in this query are compared, so a twin in another Space is caught when that Space is active.
async function assignKeys(api, tabs, newKey) {
  const stored = await Promise.all(tabs.map((t) => readKey(api, t.id)));
  // A fresh key must also avoid keys stored on tabs not processed yet, or it would turn a unique key into a
  // "duplicate" and overwrite it, and the undo journal could no longer find that tab.
  const taken = new Set(stored.filter((key) => key !== null));
  const seen = new Set();
  const writes = [];
  const byId = tabs.map((tab, i) => ({ tab, key: stored[i] })).sort((a, b) => a.tab.id - b.tab.id);
  for (const entry of byId) {
    let key = entry.key;
    if (key === null || seen.has(key)) {
      key = freshKey(newKey, taken);
      taken.add(key);
      writes.push(writeKey(api, entry.tab.id, key));
    }
    seen.add(key);
    entry.tab.key = key;
  }
  await Promise.all(writes);
}

// Bounded so a broken injected generator fails loudly instead of spinning forever.
function freshKey(newKey, taken) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = String(newKey());
    if (key !== "" && !taken.has(key)) return key;
  }
  throw new Error("newKey keeps returning keys already in use");
}

// A tab can close between tabs.query and here; treat an unreadable or malformed value as missing.
async function readKey(api, tabId) {
  try {
    const value = await api.sessions.getTabValue(tabId, TAB_KEY);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

// A tab undo reopened shows its stored url and title while it still reads about:blank and is discarded, so the
// payload, the preview and undo's fingerprint match all see the page it is. Once it has loaded it no longer reads
// about:blank, and the stale value is ignored. Only an http(s) url is taken: undo reopens nothing else.
// The value is never removed when the tab loads, so a tab activated since and blank again (navigated to about:blank,
// then discarded) would still read as the old page. A value with `at` (ms, when undo wrote it) therefore counts only
// while the tab hasn't been activated since (lastAccessed <= at); a stale one is ignored and removed. A value without
// `at` (written before undo stored one) is taken as before.
async function readReopened(api, tabs) {
  const blank = tabs.filter((t) => t.url === BLANK_URL && t.discarded);
  await Promise.all(blank.map(async (tab) => {
    let value;
    try {
      value = await api.sessions.getTabValue(tab.id, REOPEN_KEY);
    } catch {
      return; // closed since tabs.query: it keeps what tabs.query said
    }
    if (typeof value?.url !== "string" || !/^https?:\/\//i.test(value.url)) return;
    if (Number.isFinite(value.at) && tab.lastAccessed > value.at) {
      await removeValue(api, tab.id, REOPEN_KEY);
      return;
    }
    tab.url = value.url;
    tab.title = typeof value.title === "string" ? value.title : "";
  }));
}

// Best effort: a tab that closed meanwhile has nothing left to clear, and the stale check above runs again next time.
async function removeValue(api, tabId, key) {
  try {
    await api.sessions.removeTabValue(tabId, key);
  } catch {
    // Nothing to do.
  }
}

// If the write fails the tab most likely just closed; undo already treats "no tabs matched" as a normal outcome.
async function writeKey(api, tabId, key) {
  try {
    await api.sessions.setTabValue(tabId, TAB_KEY, key);
  } catch {
    // Nothing to do: the in-memory key still keeps this snapshot consistent.
  }
}

function toTab(t) {
  return {
    id: t.id,
    index: t.index,
    windowId: t.windowId,
    url: t.url ?? "",
    title: t.title ?? "",
    pinned: Boolean(t.pinned),
    groupId: Number.isInteger(t.groupId) ? t.groupId : NO_GROUP,
    discarded: Boolean(t.discarded),
    active: Boolean(t.active),
    lastAccessed: t.lastAccessed ?? 0,
    width: t.width ?? 0,
    key: null, // filled by assignKeys
  };
}

function toGroup(g) {
  return { id: g.id, title: g.title ?? "", color: g.color, collapsed: Boolean(g.collapsed), windowId: g.windowId };
}
