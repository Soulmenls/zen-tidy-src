// Pure state for the popup's preview editor, plus the small view-model helpers popup.js renders from.
// No DOM and no browser APIs, so Node tests cover it. Reducers never mutate their input: each returns
// a new edits object, or the same object when the call changes nothing (popup.js skips the re-render).
//
// Edits = {
//   previewId,
//   groups: [{ key, kind, groupId, name, icon, placeAfterGroupId, tabs: [{ tabId, checked }] }],
//   leftovers: [tabId],   // tabs listed under "Stay loose"; they have no tick box
//   close: [tabId],       // extras (duplicates, stale tabs) ticked to close on Apply (m4-contracts)
// }
// The popup saves this whole object (saveEdits, toSavedEdits) so a reopened popup shows exactly what
// the user left: ticks, moves, leftovers, renames, icons and tabs to close. Apply sends toApplyRequest(edits).

import { ICONS, DEFAULT_ICON, iconIndex } from "../shared/icons.js";
import { MAX_NAME_LENGTH, cleanVisibleName } from "../background/markers.js";

export const LEFTOVERS = "leftovers";
// The background drops new groups with fewer tabs (preview.js validateApplyRequest).
export const MIN_NEW_GROUP_TABS = 2;
// Cards with more tabs than this start collapsed, so a 250-tab preview opens as a short list.
export const COLLAPSE_AFTER = 8;
// The stale-tab setting's default (store.js DEFAULT_STALE_DAYS; a test keeps the two equal). Only for the Extras
// heading of a preview that doesn't say which day count found its stale tabs.
export const DEFAULT_STALE_DAYS = 14;

const isObject = (value) => value !== null && typeof value === "object";

const tabIdsOf = (preview) => [
  ...(preview.groups ?? []).flatMap((g) => (g.tabs ?? []).map((t) => t.tabId)),
  ...(preview.leftovers ?? []).map((t) => t.tabId),
];

// The preview's extras (m4-contracts, "Preview and apply"), each tab offered once: an entry without an integer
// tabId, or for a tab already offered, is dropped, so one tab can never get two tick boxes.
export function extrasOf(preview) {
  const extras = isObject(preview?.extras) ? preview.extras : {};
  const seen = new Set();
  const take = (entries) => (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (!isObject(entry) || !Number.isInteger(entry.tabId) || seen.has(entry.tabId)) return false;
    seen.add(entry.tabId);
    return true;
  });
  return { duplicates: take(extras.duplicates), stale: take(extras.stale) };
}

export const extraTabIds = (preview) => {
  const { duplicates, stale } = extrasOf(preview);
  return [...duplicates, ...stale].map((entry) => entry.tabId);
};

const groupFromPreview = (g, overrides) => ({
  key: g.key,
  kind: g.kind,
  groupId: g.groupId ?? null,
  name: g.name ?? "",
  icon: g.icon ?? ICONS[0],
  placeAfterGroupId: g.placeAfterGroupId ?? null,
  tabs: [],
  ...overrides,
});

// Start from the preview, or from the edits the popup saved earlier for this same preview
// (run.edits, the Edits shape above). Saved edits that don't have that shape are ignored.
export function initEdits(preview, saved = null) {
  if (saved && saved.previewId === preview.id && Array.isArray(saved.groups) && Array.isArray(saved.leftovers)) {
    return restoreEdits(preview, saved);
  }
  const { duplicates, stale } = extrasOf(preview);
  return {
    previewId: preview.id,
    groups: (preview.groups ?? []).map((g) =>
      groupFromPreview(g, {
        tabs: (g.tabs ?? []).map((t) => ({ tabId: t.tabId, checked: t.checked ?? !t.suspect })),
      })),
    leftovers: (preview.leftovers ?? []).map((t) => t.tabId),
    // SPEC F4: extras start unticked. Only an entry the preview itself marks checked starts ticked.
    close: [...duplicates, ...stale].filter((entry) => entry.checked === true).map((entry) => entry.tabId),
  };
}

// The background checks saved edits against the preview before storing them, but the popup trusts
// only the preview too: kind, groupId and placeAfterGroupId come from it, unknown keys and tab ids
// are dropped, and each tab is used once. A tab the saved copy doesn't mention stays loose (it joins
// the leftovers), so a damaged copy can never group a tab the user didn't see ticked. Tabs to close
// must be ones the preview offers as extras, each once; a copy saved without `close` closes nothing.
function restoreEdits(preview, saved) {
  const known = new Set(tabIdsOf(preview));
  const previewGroups = new Map((preview.groups ?? []).map((g) => [g.key, g]));
  const used = new Set();
  const take = (tabId) => {
    if (!known.has(tabId) || used.has(tabId)) return false;
    used.add(tabId);
    return true;
  };
  const groups = [];
  for (const entry of saved.groups) {
    const source = previewGroups.get(entry?.key);
    if (!source || groups.some((g) => g.key === source.key)) continue;
    const tabs = [];
    for (const t of Array.isArray(entry.tabs) ? entry.tabs : []) {
      if (take(t?.tabId)) tabs.push({ tabId: t.tabId, checked: t.checked === true });
    }
    groups.push(groupFromPreview(source, {
      name: typeof entry.name === "string" ? entry.name : source.name ?? "",
      icon: iconIndex(entry.icon) >= 0 ? ICONS[iconIndex(entry.icon)] : source.icon ?? ICONS[0],
      tabs,
    }));
  }
  const leftovers = saved.leftovers.filter(take);
  for (const tabId of tabIdsOf(preview)) {
    if (take(tabId)) leftovers.push(tabId);
  }
  const offered = new Set(extraTabIds(preview));
  const close = [];
  for (const tabId of Array.isArray(saved.close) ? saved.close : []) {
    if (offered.delete(tabId)) close.push(tabId);
  }
  return { previewId: preview.id, groups, leftovers, close };
}

// The saveEdits payload: a plain copy of the edits with exactly the fields the background accepts.
export function toSavedEdits(edits) {
  return {
    previewId: edits.previewId,
    groups: edits.groups.map((g) => ({
      key: g.key,
      kind: g.kind,
      groupId: g.groupId,
      name: g.name,
      icon: g.icon,
      placeAfterGroupId: g.placeAfterGroupId,
      tabs: g.tabs.map((t) => ({ tabId: t.tabId, checked: t.checked })),
    })),
    leftovers: [...edits.leftovers],
    close: [...closeOf(edits)],
  };
}

// Edits made before M4 have no `close`.
const closeOf = (edits) => (Array.isArray(edits.close) ? edits.close : []);
const asSet = (ids) => (ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : []));

export const isClosing = (edits, tabId) => closeOf(edits).includes(tabId);

// Tick or untick an extra to close; without `checked` it flips. Closing wins over grouping (m4-contracts): the tab
// keeps its place and tick in its group, but Apply leaves it out of the group and summarize stops counting it.
export function setClose(edits, tabId, checked) {
  if (!Number.isInteger(tabId)) return edits;
  const close = closeOf(edits);
  const current = close.includes(tabId);
  const next = checked === undefined ? !current : Boolean(checked);
  if (next === current) return edits;
  return { ...edits, close: next ? [...close, tabId] : close.filter((id) => id !== tabId) };
}

// Where a tab is now: a group key, LEFTOVERS, or null when the edits don't hold it.
export function locateTab(edits, tabId) {
  for (const g of edits.groups) {
    if (g.tabs.some((t) => t.tabId === tabId)) return g.key;
  }
  return edits.leftovers.includes(tabId) ? LEFTOVERS : null;
}

// Move a tab to the end of a group or to the leftovers. A tab keeps its tick when it moves between
// groups (a pre-unticked Glance suspect stays unticked); one taken from the leftovers is ticked,
// because the user just chose to group it.
export function moveTab(edits, tabId, targetKey) {
  const from = locateTab(edits, tabId);
  if (from === null || from === targetKey) return edits;
  if (targetKey !== LEFTOVERS && !edits.groups.some((g) => g.key === targetKey)) return edits;
  const moving = from === LEFTOVERS
    ? { tabId, checked: true }
    : edits.groups.find((g) => g.key === from).tabs.find((t) => t.tabId === tabId);
  const groups = edits.groups.map((g) => {
    if (g.key === from) return { ...g, tabs: g.tabs.filter((t) => t.tabId !== tabId) };
    if (g.key === targetKey) return { ...g, tabs: [...g.tabs, { ...moving }] };
    return g;
  });
  let leftovers = edits.leftovers;
  if (from === LEFTOVERS) leftovers = leftovers.filter((id) => id !== tabId);
  if (targetKey === LEFTOVERS) leftovers = [...leftovers, tabId];
  return { ...edits, groups, leftovers };
}

// Tick or untick a tab in a group; without `checked` it flips. Leftovers have no tick box.
export function toggleTab(edits, tabId, checked) {
  const key = locateTab(edits, tabId);
  if (key === null || key === LEFTOVERS) return edits;
  const group = edits.groups.find((g) => g.key === key);
  const current = group.tabs.find((t) => t.tabId === tabId).checked;
  const next = checked === undefined ? !current : Boolean(checked);
  if (next === current) return edits;
  return {
    ...edits,
    groups: edits.groups.map((g) => (g.key !== key ? g : {
      ...g,
      tabs: g.tabs.map((t) => (t.tabId === tabId ? { ...t, checked: next } : t)),
    })),
  };
}

const updateGroup = (edits, key, patch) => ({
  ...edits,
  groups: edits.groups.map((g) => (g.key === key ? { ...g, ...patch } : g)),
});

// The raw text is kept as typed: the background cleans names (markers, emoji, length) on Apply.
export function renameGroup(edits, key, name) {
  const group = edits.groups.find((g) => g.key === key);
  if (!group || typeof name !== "string" || group.name === name) return edits;
  return updateGroup(edits, key, { name });
}

export function setIcon(edits, key, icon) {
  const group = edits.groups.find((g) => g.key === key);
  const index = iconIndex(icon);
  if (!group || index < 0 || group.icon === ICONS[index]) return edits;
  return updateGroup(edits, key, { icon: ICONS[index] });
}

// Drops a proposed group, or for an existing group ("Don't add") only the tabs it would gain: an
// existing group left out of the request is never touched. Either way its tabs join the leftovers.
export function deleteGroup(edits, key) {
  const group = edits.groups.find((g) => g.key === key);
  if (!group) return edits;
  return {
    ...edits,
    groups: edits.groups.filter((g) => g.key !== key),
    leftovers: [...edits.leftovers, ...group.tabs.map((t) => t.tabId)],
  };
}

// The ApplyRequest the background validates (contract: "Apply request", plus m4's `close`). Every remaining
// group is sent, even with too few ticked tabs; the background drops what it can't apply. Unticked tabs and
// leftovers are simply absent, so they stay loose. A tab ticked to close is left out of its group, since closing
// wins (the background drops it from the group too, then re-checks the group sizes).
export function toApplyRequest(edits) {
  const closing = new Set(closeOf(edits));
  return {
    previewId: edits.previewId,
    groups: edits.groups.map((g) => ({
      key: g.key,
      kind: g.kind,
      groupId: g.groupId,
      name: g.name,
      icon: g.icon,
      placeAfterGroupId: g.placeAfterGroupId,
      tabIds: g.tabs.filter((t) => t.checked && !closing.has(t.tabId)).map((t) => t.tabId),
    })),
    close: [...closing],
  };
}

// ---- View-model helpers ----

const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The ticked tabs Apply would put in the group. closing: the tab ids ticked to close (a Set or an array), which
// leave the group whatever their tick says.
export const checkedCount = (group, closing) => {
  const leaving = asSet(closing);
  return group.tabs.reduce((n, t) => n + (t.checked && !leaving.has(t.tabId) ? 1 : 0), 0);
};

export const startsCollapsed = (group) => group.tabs.length > COLLAPSE_AFTER;

// True when Apply would create or fill this group. An existing group needs one tab, a new one two.
export function groupWillApply(group, closing) {
  return checkedCount(group, closing) >= (group.kind === "existing" ? 1 : MIN_NEW_GROUP_TABS);
}

// Shown on a new group's card when it is too small to be created.
export function groupNeedsTabs(group, closing) {
  return group.kind !== "existing" && !groupWillApply(group, closing);
}

export const GROUP_HINT = "Tick at least 2 tabs, or this group won't be made.";
export const GROUP_HINT_CLOSING = "Closing a tab leaves too few for this group, so it won't be made.";

// The size hint on a new group's card, or "" when the group will be made. When its ticks alone would make it but tabs
// ticked to close in Extras leave too few, the hint says so: every box the person sees may be ticked, so "tick at least
// 2" would ask for what they already did.
export function groupHint(group, closing) {
  if (!groupNeedsTabs(group, closing)) return "";
  return groupWillApply(group, []) ? GROUP_HINT_CLOSING : GROUP_HINT;
}

// The outcome Apply would have: groups that get tabs, tabs grouped, tabs that stay loose, and tabs to close.
// A tab ticked to close is neither grouped nor loose.
export function summarize(edits) {
  const closing = new Set(closeOf(edits));
  let groups = 0;
  let tabs = 0;
  let total = edits.leftovers.length;
  let closingListed = edits.leftovers.filter((tabId) => closing.has(tabId)).length;
  for (const g of edits.groups) {
    total += g.tabs.length;
    closingListed += g.tabs.filter((t) => closing.has(t.tabId)).length;
    if (groupWillApply(g, closing)) {
      groups += 1;
      tabs += checkedCount(g, closing);
    }
  }
  return { groups, tabs, loose: total - tabs - closingListed, total, close: closing.size };
}

// Zen's own separator for this kind of line (ZenFolders.mjs). Only what Apply will group: a "loose"
// count here would disagree with the "Stay loose" section, which can't list unticked tabs. Tabs ticked
// to close add "• K to close" (m4-contracts, "Popup").
export function summaryText({ groups, tabs, close = 0 }) {
  const line = `${plural(groups, "group")} • ${plural(tabs, "tab")}`;
  return close > 0 ? `${line} • ${close} to close` : line;
}

// Apply is worth sending when a group gets tabs, a tab is ticked to close, or an existing group was renamed or
// re-iconed.
export function canApply(edits, preview) {
  if (summarize(edits).groups > 0 || closeOf(edits).length > 0) return true;
  const original = new Map((preview?.groups ?? []).map((g) => [g.key, g]));
  return edits.groups.some((g) => {
    const source = original.get(g.key);
    return g.kind === "existing" && source && (g.name !== source.name || g.icon !== source.icon);
  });
}

// The name field's maxlength. A new group gets the background's cap. An existing group may already
// have a longer name in Zen, and the background allows up to that length for it (validateApplyRequest),
// so the field must hold the whole name and let the user edit it. Measured in UTF-16 units, as
// maxlength is, so the original name always fits.
export function nameMaxLength(group, preview) {
  if (group?.kind !== "existing") return MAX_NAME_LENGTH;
  const original = (preview?.groups ?? []).find((g) => g.key === group.key)?.name;
  return Math.max(MAX_NAME_LENGTH, typeof original === "string" ? original.length : 0);
}

// The Glance reminder isn't here: it shows on every preview. An open Glance is the active tab, which
// the suspect heuristics can't single out, so a reminder tied to suspects would miss it.
export function previewBanners(preview, { runWindowId, currentWindowId } = {}) {
  const refused = Number.isInteger(preview.refusedCount) && preview.refusedCount > 0 ? preview.refusedCount : 0;
  return {
    multiWindow: Boolean(preview.multiWindow),
    refused,
    otherWindow: runWindowId != null && currentWindowId != null && runWindowId !== currentWindowId,
  };
}

export function refusedText(n) {
  return n === 1 ? "1 tab was not sorted and stays loose." : `${n} tabs were not sorted and stay loose.`;
}

// ---- Extras in the preview (m4-contracts, "Popup") ----

// The stale heading's day count: the one the preview's stale tabs were found with, when the preview says.
export function staleDaysOf(preview) {
  const days = preview?.extras?.staleDays;
  return Number.isInteger(days) && days >= 0 ? days : DEFAULT_STALE_DAYS;
}

// The two Extras headings, "Duplicates (N)" and "Not opened in 14 days (N)": the label, then the count, which
// popup.js puts in the section title's secondary count span, as "Stay loose" does.
export function extrasHeadings(extras, staleDays = DEFAULT_STALE_DAYS) {
  return {
    duplicates: { label: "Duplicates", count: `(${extras.duplicates.length})` },
    stale: { label: `Not opened in ${plural(staleDays, "day")}`, count: `(${extras.stale.length})` },
  };
}

// A duplicate's secondary line: the copy that stays open (never offered itself).
export function keepsText(keepTitle) {
  const title = typeof keepTitle === "string" ? keepTitle.trim() : "";
  return `Keeps: ${title || "Untitled tab"}`;
}

const RUN_STATES = new Set(["running", "preview", "applying", "applied", "undoing", "undone", "error"]);

// The popup state (also document.body.dataset.state) for a getState response. groupsOpen: the person opened the
// groups view from the idle view; it shows only while the run would show the idle view, so a tidy started from
// another window, or any run state, takes the popup over as before.
export function viewState({ run, hasKey, groupsOpen = false } = {}) {
  const state = run?.state;
  let base;
  if (state === "preview" && !run.preview) base = hasKey ? "idle" : "no-key";
  else if (RUN_STATES.has(state)) base = state;
  else base = hasKey ? "idle" : "no-key";
  return groupsOpen && base === "idle" ? "groups" : base;
}

// The idle view's button and note. canTidy comes from getState and follows the same rule as the
// runner's nothing-to-tidy check (2+ loose tabs, or 1 when a tidy group exists to join), so the
// button is never offered for a tidy the background would refuse. null means getState couldn't count.
export function idleView({ looseCount = null, canTidy = null, busy = false } = {}) {
  const n = Number.isInteger(looseCount) ? looseCount : null;
  if (n === 0 || canTidy === false) {
    return {
      label: "Tidy tabs",
      disabled: true,
      note: n === 1 ? "Nothing to tidy here. One tab can't make a group on its own." : "Nothing to tidy here.",
    };
  }
  return { label: n ? `Tidy ${plural(n, "loose tab")}` : "Tidy tabs", disabled: busy, note: "" };
}

const PHASES = {
  snapshot: "Reading your tabs…",
  pass1: "Sorting your tabs…",
  sweep: "Checking the leftovers…",
  check: "Checking each group…",
  apply: "Applying your groups…",
};

export const phaseLabel = (phase) => PHASES[phase] ?? "Getting started…";

export function elapsedSeconds(startedAt, now) {
  return Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

export const WRONG_SPACE_NOTICE = "Switch back to the Space you tidied, then Apply.";
const NOTHING_CHANGED_NOTICE = "Nothing was changed. Try Apply again.";

// Errors the user fixes on the settings page (API key problems).
const SETTINGS_KINDS = new Set(["auth", "permission", "workspace-scope", "no-key", "invalid-key-format"]);

// Used only when the background sent no message of its own.
const FALLBACK_MESSAGES = {
  interrupted: "The last tidy stopped before it finished. Try again.",
  "no-key": "Add your Anthropic API key in settings first.",
  busy: "Zen Tidy is busy with another run. Try again in a moment.",
  auth: "Your API key was rejected. Check it in settings.",
  "stale-run": "This preview is out of date. Tidy again.",
  "invalid-request": "Zen Tidy couldn't apply these groups.",
  "multi-window-unconfirmed": "More than one window is open. Confirm to apply.",
  "wrong-space": WRONG_SPACE_NOTICE,
  unreachable: "Zen Tidy's background isn't responding. Try again.",
  network: "You're offline.",
  timeout: "Claude took too long to answer. Try again.",
  "undo-failed": "Undo stopped partway. Some tabs may already be back. Try Undo again.",
};

// error: { kind, message } from run.error, or a failed response mapped to the same shape.
export function errorView(error) {
  const kind = typeof error?.kind === "string" ? error.kind : "unknown";
  const own = typeof error?.message === "string" ? error.message.trim() : "";
  return {
    message: own || FALLBACK_MESSAGES[kind] || "Something went wrong. Try again.",
    showSettings: SETTINGS_KINDS.has(kind),
  };
}

// What the popup does with an apply response:
// - applied: show the report;
// - confirm: more than one window is open now (the background counts them at Apply time, whatever
//   the preview said), so ask the second time and re-send with confirmMultiWindow: true;
// - notice: the background kept the preview and changed nothing (the tabs are in another Space, or
//   Apply failed before its first change), so the editor stays, with the message inline;
// - error: anything else. A failure after changes began is stored in the run as its error.
export function applyOutcome(response) {
  if (response?.ok) return { kind: "applied", report: isObject(response.report) ? response.report : null };
  const code = typeof response?.error === "string" ? response.error : "unknown";
  if (code === "multi-window-unconfirmed") return { kind: "confirm" };
  if (code === "wrong-space") return { kind: "notice", message: WRONG_SPACE_NOTICE };
  if (code === "apply-failed" && response.previewKept === true) {
    const own = typeof response.message === "string" ? response.message.trim() : "";
    return { kind: "notice", message: own || NOTHING_CHANGED_NOTICE };
  }
  return { kind: "error", error: { kind: code, message: response?.message } };
}

export const APPLIED_JOURNAL_LINE = "The undo record wasn't finished, so Undo may not put everything back.";

// True when an apply changed something in the browser. Closing tabs counts: a close-only apply has a journal
// of its own (m4-contracts), so it can be undone.
const appliedChanges = (report) =>
  count(report?.tabsGrouped) + count(report?.groupsCreated) + count(report?.groupsJoined) + count(report?.groupsRenamed)
    + count(report?.tabsClosed) > 0;

// The Applied view's text: { heading, summary, details }. A failure carries its group's cleaned name
// (failure.name), so the lines still say which group after the popup is reopened; nameOf(key) is only
// a fallback for a report without one. Failures outside any group (scope "order", "close" or "journal") get
// one fixed line each and no group prefix; a "close" line gives a number only when every one has a count.
export function appliedSummary(report, nameOf = () => "") {
  const tabs = count(report?.tabsGrouped);
  const created = count(report?.groupsCreated);
  const joined = count(report?.groupsJoined);
  const renamed = count(report?.groupsRenamed);
  const closed = count(report?.tabsClosed);
  const skipped = Array.isArray(report?.skippedTabIds) ? report.skippedTabIds.length : 0;
  const failures = Array.isArray(report?.failures) ? report.failures.filter(isObject) : [];
  const changed = appliedChanges(report);

  const groupLines = [];
  const unordered = [];
  let ordering = false;
  let journal = false;
  let unclosed = 0;
  let unclosedCounted = true;
  let closeFailed = false;
  // Tabs apply kept open as the strip's last (code "last-tab", apply.js), so Undo can find this Space: on purpose.
  let held = 0;
  for (const f of failures) {
    const name = (typeof f.name === "string" && f.name.trim()) || (f.key != null && nameOf(f.key)) || "";
    const message = typeof f.message === "string" ? f.message.trim() : "";
    if (f.scope === "close" && f.code === "last-tab") {
      held += Number.isInteger(f.count) && f.count > 0 ? f.count : 1;
    } else if (f.scope === "order") {
      ordering = true;
      if (name) unordered.push(name);
    } else if (f.scope === "journal") {
      journal = true;
    } else if (f.scope === "close") {
      closeFailed = true;
      if (Number.isInteger(f.count) && f.count > 0) unclosed += f.count;
      else unclosedCounted = false;
    } else if (name) {
      groupLines.push(`${name}: ${message || "it couldn't be applied."}`);
    } else {
      groupLines.push(message || "One group couldn't be applied.");
    }
  }

  let summary;
  if (tabs > 0) summary = `Grouped ${plural(tabs, "tab")} into ${plural(created + joined, "group")}.`;
  else if (closed > 0) summary = `Closed ${plural(closed, "tab")}.`;
  else if (renamed > 0) summary = `Renamed ${plural(renamed, "group")}.`;
  else if (groupLines.length > 0) summary = "None of the groups could be applied.";
  else if (closeFailed) summary = "No tabs could be closed.";
  else if (held > 0) summary = "No tabs were closed.";
  else summary = "No tabs were moved.";

  const details = [];
  if (joined > 0) details.push(joined === 1 ? "1 existing group got new tabs." : `${joined} existing groups got new tabs.`);
  if ((tabs > 0 || closed > 0) && renamed > 0) details.push(`Renamed ${plural(renamed, "group")}.`);
  if (tabs > 0 && closed > 0) details.push(`Closed ${plural(closed, "tab")}.`);
  if (skipped > 0) {
    details.push(skipped === 1
      ? "1 tab changed since the preview and was left alone."
      : `${skipped} tabs changed since the preview and were left alone.`);
  }
  details.push(...groupLines);
  if (closeFailed && (changed || groupLines.length > 0)) {
    if (!unclosedCounted) details.push("Some tabs couldn't be closed.");
    else details.push(unclosed === 1 ? "1 tab couldn't be closed." : `${unclosed} tabs couldn't be closed.`);
  }
  if (held > 0) {
    details.push(held === 1 ? "1 tab was left open so this Space keeps a tab for Undo."
      : `${held} tabs were left open so this Space keeps a tab for Undo.`);
  }
  if (ordering) details.push(unordered.length ? `Couldn't order the groups: ${unordered.join(", ")}.` : "Couldn't order the groups.");
  // The journal stays "applying" and is still undoable (the view offers Undo), only less exactly.
  if (journal) details.push(APPLIED_JOURNAL_LINE);

  let heading = "All tidy";
  if (!changed) heading = "Nothing changed";
  else if (groupLines.length > 0) heading = "Partly applied";
  else if (failures.length > 0) heading = "Applied with problems";
  return { heading, summary, details };
}

// ---- Undo (notes/m3-contracts.md, "Popup") ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The undone view lists this many of the tabs it left alone, then "and N more".
export const LEFT_ALONE_LISTED = 8;

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// How long ago `at` was, in the person's local time: "just now", "5 min ago", "3 h ago", then "yesterday" by the
// calendar, then the date ("Oct 21", plus the year when it isn't this year). Under a day it counts, so a tidy at
// 23:00 still reads "2 h ago" at 01:00. A time ahead of `now` (the clock moved back) reads "just now"; an unknown
// time is "", and so is one outside the range a Date can hold (a damaged journal), which would otherwise print
// "undefined NaN". Month names are written out rather than taken from Intl, so the line is English like the rest.
export function relativeTime(at, now) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const then = new Date(at);
  const today = new Date(now);
  if (Number.isNaN(then.getTime()) || Number.isNaN(today.getTime())) return "";
  if (sameDay(then, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return "yesterday";
  const date = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === today.getFullYear() ? date : `${date}, ${then.getFullYear()}`;
}

// The journal stays "applying" when Zen closed or crashed mid-apply, when the background was restarted under it (an
// add-on update or reload), and when only the apply's last journal write failed, so the line names no cause.
export const INTERRUPTED_TEXT = "The last tidy didn't finish applying. Undo what was done?";
export const RESUMABLE_TEXT = "The last Undo didn't finish. Undo again to finish putting your tabs back?";

// What the idle view offers for getState's `undo` ({ available, state, at, tabCount, multiWindow, resumable }):
// - none: no journal, or it was undone already;
// - done: a quiet "Last tidy 3 h ago" line with an Undo text action;
// - interrupted: a notice with an Undo button, for an apply that never finished (the journal is still "applying"),
//   or an undo that never finished (`resumable`: the journal carries undoStartedAt, so some tabs may already be out
//   of their groups; a quiet line would hide that).
// multiWindow: the tidy ran with more than one window open, so Undo asks first.
export function undoOffer(undo, now) {
  if (!isObject(undo) || undo.available !== true) return { kind: "none", text: "", multiWindow: false };
  const multiWindow = undo.multiWindow === true;
  if (undo.state !== "applying" && undo.state !== "done") return { kind: "none", text: "", multiWindow: false };
  if (undo.resumable === true) return { kind: "interrupted", text: RESUMABLE_TEXT, multiWindow };
  if (undo.state === "applying") return { kind: "interrupted", text: INTERRUPTED_TEXT, multiWindow };
  const when = relativeTime(undo.at, now);
  return { kind: "done", text: when ? `Last tidy ${when}` : "Last tidy", multiWindow };
}

// Whether the applied view offers Undo. An apply that changed something wrote its journal before the first change,
// so it can be undone unless getState says otherwise (`undo` is null while the popup doesn't know yet). An apply
// that changed nothing wrote no journal: the one still there belongs to an earlier tidy, which this view's Undo
// must not reach.
export function canUndoApplied(report, undo) {
  return appliedChanges(report) && undo?.available !== false;
}

export const UNDO_WRONG_SPACE_NOTICE = "Switch to the Space you tidied, then Undo.";
export const UNDO_OTHER_WINDOW_NOTICE = "Open Zen Tidy from the window you tidied, then Undo.";
export const UNDO_NOTHING_NOTICE = "The tidied tabs aren't open here. Undo works again if they come back.";
// The refusals that change nothing, each with a fixed line: the person acts on it, so it says exactly what to do,
// whatever the background's own wording. hideOffer: the line stands in for the Undo that was refused, which would
// only be refused again from this popup (the tabs aren't open, or there is no journal).
// - invalid-request: the background couldn't tell which window to undo in (neither the popup nor it could read one);
// - other-window: the tidied tabs are in another window, where switching Spaces here can never reach them.
const UNDO_NOTICES = {
  "wrong-space": { message: UNDO_WRONG_SPACE_NOTICE, hideOffer: false },
  "other-window": { message: UNDO_OTHER_WINDOW_NOTICE, hideOffer: false },
  "nothing-to-undo": { message: UNDO_NOTHING_NOTICE, hideOffer: true },
  "no-journal": { message: "There is no tidy to undo.", hideOffer: true },
  busy: { message: "Zen Tidy is busy with another run. Try again in a moment.", hideOffer: false },
  "invalid-request": {
    message: "Zen Tidy couldn't tell which window to undo in. Open it from the window you tidied and try again.",
    hideOffer: false,
  },
};

// What the popup does with an undo response (m3-contracts, "Messages"):
// - undone: show the report;
// - confirm: more than one window is open, or was during the tidy, so ask and re-send with confirmMultiWindow: true.
//   windowCount is the background's count now (null when it couldn't count), for undoConfirmText;
// - notice: nothing changed (the tabs are in another Space or window, none are left, the journal is gone, another run
//   holds the lock, or no window could be read), so the view that offered Undo stays, with the message inline;
// - error: anything else. A failure after changes began is stored in the run as its error.
export function undoOutcome(response) {
  if (response?.ok) return { kind: "undone", report: isObject(response.report) ? response.report : null };
  const code = typeof response?.error === "string" ? response.error : "unknown";
  if (code === "multi-window-unconfirmed") {
    return { kind: "confirm", windowCount: Number.isInteger(response.windowCount) ? response.windowCount : null };
  }
  if (Object.hasOwn(UNDO_NOTICES, code)) return { kind: "notice", ...UNDO_NOTICES[code] };
  return { kind: "error", error: { kind: code, message: response?.message } };
}

// The undo multi-window confirmation's text. windowCount: the background's count now, null when it couldn't count,
// undefined when the popup asks by itself (getState flagged the tidy as made with 2+ windows). tidyMultiWindow:
// that flag. The background also asks when only the tidy had 2+ windows, or when it couldn't count, so "is open"
// is said only for a count above 1.
export function undoConfirmText(windowCount, tidyMultiWindow = false) {
  if (Number.isInteger(windowCount) && windowCount > 1) {
    return "More than one window is open. Undo may not put everything back. Undo anyway?";
  }
  if (tidyMultiWindow || Number.isInteger(windowCount)) {
    return "More than one window was open during the tidy, so Undo may not put everything back. Undo anyway?";
  }
  return "Zen Tidy couldn't count the open windows, so Undo may not put everything back. Undo anyway?";
}

const groupsLine = (n, one, many) => (n === 1 ? `1 group ${one}` : `${n} groups ${many}`);

// The undone view's line for each kind of UndoReport failure, by its structured fields only, never its `message`
// (undo.js's own wording, with the browser's error text and "tab(s)"). A failure is { scope, code?, count?, message }:
// - scope: "lift", "order", "title", "collapse", "reopen" or "journal" (the journal's own fixed line, in undoneView);
// - code, for "order" only: which kind of inexact placement (UNDO_ORDER_CODES). Without one, or with one this popup
//   doesn't know, the line hedges ("may not be exactly where they were"), which is true of every kind;
// - count: how many tabs the failure concerns. A line states a number only when every failure of its kind has one,
//   summed; otherwise it says "some". For "title" and "collapse" each failure is one group, so the number of failures
//   picks "a group" or "some groups".
// note: the order may differ slightly near some tab, but every tab is back, so it is not a partial undo.
const tabsCount = (one, many, some) => ({ by: "count", line: (n) => (n === null ? some : n === 1 ? one : many(n)) });
const UNDO_FAILURES = {
  lift: tabsCount("1 tab couldn't be taken out of its group.", (n) => `${n} tabs couldn't be taken out of their groups.`,
    "Some tabs couldn't be taken out of their groups."),
  order: { by: "count", line: () => "Some tabs may not be exactly where they were." },
  "order:near": tabsCount("1 tab is next to its old place rather than exactly in it.",
    (n) => `${n} tabs are next to their old places rather than exactly in them.`,
    "Some tabs are next to their old places rather than exactly in them."),
  "order:unmoved": tabsCount("1 tab couldn't be moved back to its place.",
    (n) => `${n} tabs couldn't be moved back to their places.`, "Some tabs couldn't be moved back to their places."),
  "order:in-group": tabsCount("1 tab ended up in a group next to its old place.",
    (n) => `${n} tabs ended up in a group next to their old places.`, "Some tabs ended up in a group next to their old places."),
  "order:open-tab": {
    by: "count", note: true, line: () => "Tabs next to the one you have open may be in a slightly different order.",
  },
  "order:moved-anchor": {
    by: "count", note: true, line: () => "Tabs next to ones you moved since the tidy may be in a slightly different order.",
  },
  title: {
    by: "items",
    line: (n) => (n === 1 ? "A group's old name couldn't be put back." : "Some groups' old names couldn't be put back."),
  },
  collapse: {
    by: "items",
    line: (n) => (n === 1
      ? "A group may not be collapsed or expanded as it was."
      : "Some groups may not be collapsed or expanded as they were."),
  },
  reopen: tabsCount("1 closed tab couldn't be reopened as it was.", (n) => `${n} closed tabs couldn't be reopened as they were.`,
    "Some closed tabs couldn't be reopened as they were."),
};
const UNDO_FAILURE_FALLBACK = { by: "count", line: () => "Some tabs couldn't be put back." };
// The kinds of inexact placement an "order" failure's code names (see UNDO_FAILURES).
export const UNDO_ORDER_CODES = Object.freeze(["near", "unmoved", "in-group", "open-tab", "moved-anchor"]);

const failureKind = (f) => {
  if (f.scope === "order" && UNDO_ORDER_CODES.includes(f.code)) return `order:${f.code}`;
  return typeof f.scope === "string" && Object.hasOwn(UNDO_FAILURES, f.scope) ? f.scope : "other";
};

// The failures' lines, each kind once, in the order its first failure came, and how many of them are problems
// (not notes).
function undoFailureLines(failures) {
  const kinds = new Map();
  for (const f of failures) {
    const kind = failureKind(f);
    const entry = kinds.get(kind) ?? { items: 0, count: 0, counted: true };
    entry.items += 1;
    if (Number.isInteger(f.count) && f.count > 0) entry.count += f.count;
    else entry.counted = false;
    kinds.set(kind, entry);
  }
  const lines = [];
  let problems = 0;
  for (const [kind, entry] of kinds) {
    const spec = kind === "other" ? UNDO_FAILURE_FALLBACK : UNDO_FAILURES[kind];
    lines.push(spec.line(spec.by === "items" ? entry.items : entry.counted ? entry.count : null));
    if (!spec.note) problems += 1;
  }
  return { lines, problems };
}

// The undone view's text from an UndoReport ({ restored, moved: [{ title }], missing, groupsRemoved, groupsKept,
// titlesRestored, titlesKept, reopened, failures: [{ scope, code?, count?, message }] }):
// { heading, summary, leftAlone: { label, titles, more } | null, details }.
// leftAlone lists the tabs undo didn't touch because they moved after the tidy, by their current title, up to
// LEFT_ALONE_LISTED; popup.js renders the titles with textContent. The journal's name-free copy of a report has
// `moved` as a count: leftAlone then gives the number alone. details follow the contract's order (not found, kept
// groups, kept names), then what else changed, then a line for each kind of failure (undoFailureLines).
export function undoneView(report) {
  const restored = count(report?.restored);
  const movedList = Array.isArray(report?.moved) ? report.moved : [];
  const moved = Array.isArray(report?.moved) ? movedList.length : count(report?.moved);
  const missing = count(report?.missing);
  const groupsRemoved = count(report?.groupsRemoved);
  const groupsKept = count(report?.groupsKept);
  const titlesRestored = count(report?.titlesRestored);
  const titlesKept = count(report?.titlesKept);
  const reopened = count(report?.reopened);
  const failures = Array.isArray(report?.failures) ? report.failures.filter(isObject) : [];
  const journal = failures.some((f) => f.scope === "journal");
  const { lines: failureLines, problems } = undoFailureLines(failures.filter((f) => f.scope !== "journal"));
  const changed = restored + groupsRemoved + titlesRestored + reopened > 0;

  // Every change that sets `changed` has a line here, so the summary never says nothing happened under a heading
  // that says something did, and none says no tab moved above the tabs listed as moved.
  let summary;
  if (restored > 0) summary = `Put back ${plural(restored, "tab")}.`;
  else if (titlesRestored > 0) summary = `Gave ${groupsLine(titlesRestored, "back its old name.", "back their old names.")}`;
  else if (reopened > 0) summary = `Reopened ${plural(reopened, "tab")}.`;
  else if (groupsRemoved > 0) summary = `Removed ${plural(groupsRemoved, "group")}.`;
  else if (problems > 0) summary = "Nothing could be put back.";
  else if (moved > 0 && missing === 0) summary = "Nothing needed putting back.";
  else summary = "Nothing was changed.";

  let leftAlone = null;
  if (moved > 0) {
    const titles = movedList.slice(0, LEFT_ALONE_LISTED).map((m) => {
      const title = typeof m?.title === "string" ? m.title.trim() : "";
      return title || "Untitled tab";
    });
    const label = moved === 1
      ? "1 tab moved since the tidy and was left alone"
      : `${moved} tabs moved since the tidy and were left alone`;
    leftAlone = {
      label: `${label}${titles.length ? ":" : "."}`,
      titles,
      more: movedList.length > LEFT_ALONE_LISTED ? `and ${movedList.length - LEFT_ALONE_LISTED} more` : "",
    };
  }

  const details = [];
  if (missing > 0) {
    details.push(missing === 1
      ? "1 tab wasn't found (closed, or Zen restored an older session)."
      : `${missing} tabs weren't found (closed, or Zen restored an older session).`);
  }
  if (groupsKept > 0) details.push(groupsLine(groupsKept, "still has other tabs, so it stays.", "still have other tabs, so they stay."));
  if (titlesKept > 0) {
    details.push(groupsLine(titlesKept, "you renamed since keeps its new name.", "you renamed since keep their new names."));
  }
  if (restored > 0 && titlesRestored > 0) {
    details.push(groupsLine(titlesRestored, "got its old name back.", "got their old names back."));
  }
  if (reopened > 0 && (restored > 0 || titlesRestored > 0)) details.push(`Reopened ${plural(reopened, "closed tab")}.`);
  details.push(...failureLines);
  if (journal) details.push("Couldn't update undo info.");

  let heading = "Tabs put back";
  if (!changed) heading = "Nothing put back";
  else if (problems > 0) heading = "Partly put back";
  else if (journal) heading = "Put back with problems";
  return { heading, summary, leftAlone, details };
}

// ---- Groups view (m4-contracts, "Group actions", "Messages" and "Popup") ----

// The group actions that have their own one-step undo, by getGroups' groupUndo.type.
export const GROUP_UNDO_TYPES = Object.freeze(["ungroup", "closeAll", "removeAll"]);
export const GROUPS_EMPTY_TEXT = "No tidy groups in this Space yet.";
export const GROUPS_LOAD_FAILED = "Zen Tidy couldn't read the groups in this Space. Try again.";
const BUSY_TEXT = "Zen Tidy is busy with another run. Try again in a moment.";
const UNREACHABLE_TEXT = "Zen Tidy's background isn't responding. Try again.";
const NO_GROUP_UNDO = Object.freeze({ available: false, type: null, at: null, groupCount: 0 });

function groupUndoOf(raw) {
  if (!isObject(raw) || raw.available !== true || !GROUP_UNDO_TYPES.includes(raw.type)) return NO_GROUP_UNDO;
  return { available: true, type: raw.type, at: Number.isFinite(raw.at) ? raw.at : null, groupCount: count(raw.groupCount) };
}

// getGroups' answer ({ groups: listGroups(...), groupUndo: { available, type, at, groupCount } }) as the view
// renders it: { ok, groups, groupUndo, message? }. The groups keep the background's order (strip order). A group
// without an integer id, or one listed twice, is dropped, since the view finds rows by id; an unknown icon reads as
// the default one, as everywhere else.
export function groupsModel(response) {
  if (!isObject(response) || typeof response.error === "string" || !Array.isArray(response.groups)) {
    return {
      ok: false, message: response?.error === "busy" ? BUSY_TEXT : GROUPS_LOAD_FAILED, groups: [], groupUndo: NO_GROUP_UNDO,
    };
  }
  const seen = new Set();
  const groups = [];
  for (const g of response.groups) {
    if (!isObject(g) || !Number.isInteger(g.id) || seen.has(g.id)) continue;
    seen.add(g.id);
    groups.push({
      id: g.id,
      name: typeof g.name === "string" ? g.name : "",
      icon: iconIndex(g.icon) >= 0 ? ICONS[iconIndex(g.icon)] : DEFAULT_ICON,
      collapsed: g.collapsed === true,
      tabCount: count(g.tabCount),
      nonReopenable: count(g.nonReopenable),
    });
  }
  return { ok: true, groups, groupUndo: groupUndoOf(response.groupUndo) };
}

export const groupsSummary = (groups) => plural(groups.length, "group");

// The name field's maxlength: a preview rename's cap, or the group's own longer name, whole (as nameMaxLength).
export function groupNameMaxLength(group) {
  return Math.max(MAX_NAME_LENGTH, typeof group?.name === "string" ? group.name.length : 0);
}

// The name a rename sends, cleaned and capped as the background will (markers.js cleanVisibleName, as makeTitle
// does), or null when there is nothing to send: the field as the view filled it (a name typed in Zen may hold an
// emoji, a run of spaces or an invisible character, which cleaning would change: leaving the field must not rename
// the group), the same name, or one with no visible text left, which would leave the group untitled in Zen.
export function renameRequest(group, value) {
  if (!isObject(group) || typeof value !== "string" || value === group.name) return null;
  const name = cleanVisibleName(value, groupNameMaxLength(group));
  return name && name !== group.name ? name : null;
}

// action-failed: groups.js answers it only when nothing changed (any change resolves to a report), so the line says
// to try again rather than that tabs may have moved.
const GROUP_ACTION_NOTICES = {
  busy: BUSY_TEXT,
  "not-found": "That group isn't in this Space any more.",
  "wrong-space": "Switch back to the Space with that group, then try again.",
  "invalid-request": "Zen Tidy couldn't do that. Try again.",
  "action-failed": "Zen didn't make that change. Try again.",
  // Close all of a group that holds the Space's last tab, which the background keeps open, so nothing was closed.
  "last-tab": "Zen Tidy keeps the last tab in this Space open.",
  unreachable: UNREACHABLE_TEXT,
};
// Remove all's refusals that name "that group": the person asked about every tidy group in the Space.
const REMOVE_ALL_NOTICES = {
  "not-found": "There are no Zen Tidy groups in this Space any more.",
  "wrong-space": "Switch back to the Space with those groups, then try again.",
};

const isTabId = (value) => Number.isInteger(value) && value >= 0;

// What the view does with a groupAction answer (m4-contracts, "Messages"). action: the action that was sent, for the
// wording of its refusals.
// - done: reload the list (and the group undo offer);
// - confirm: a Close all whose group holds tabs Undo couldn't reopen; name them (`titles`) and ask, then re-send
//   with confirm: true and the ids of the tabs named (`ids`), so the background closes no other such tab without
//   asking again. Remove all asks before it sends, so it only lands here if the background asks too;
// - notice: nothing to confirm, so a fixed line inline, whatever the background's own wording.
export function groupActionOutcome(response, action = null) {
  if (response?.ok) return { kind: "done", report: isObject(response.report) ? response.report : null };
  const code = typeof response?.error === "string" ? response.error : "unknown";
  if (code === "confirm-needed") {
    return {
      kind: "confirm",
      titles: Array.isArray(response.nonReopenable) ? response.nonReopenable : [],
      ids: Array.isArray(response.nonReopenableIds) ? [...new Set(response.nonReopenableIds.filter(isTabId))] : [],
    };
  }
  if (action === "removeAll" && Object.hasOwn(REMOVE_ALL_NOTICES, code)) {
    return { kind: "notice", message: REMOVE_ALL_NOTICES[code] };
  }
  return { kind: "notice", message: GROUP_ACTION_NOTICES[code] ?? "Zen Tidy couldn't do that. Try again." };
}

// The group undo's refusals, each with a fixed line. hideOffer: the notice stands in for the Undo it answers, which
// would only be refused again (no journal, or none of its tabs left here).
const GROUP_UNDO_NOTICES = {
  busy: { message: BUSY_TEXT, hideOffer: false },
  "no-journal": { message: "There is nothing to undo.", hideOffer: true },
  "wrong-space": { message: "Switch to the Space where you made that change, then Undo.", hideOffer: false },
  // None of the journal's tabs is here (the background answers ok when they are all here but moved). Like the tidy
  // undo's line, it never says they are gone: they may come back, and the journal is kept.
  "nothing-to-undo": { message: "Those tabs aren't open here. Undo works again if they come back.", hideOffer: true },
  "undo-failed": { message: "Undo stopped partway. Some tabs may already be back. Try Undo again.", hideOffer: false },
  // Neither the popup nor the background could read a window to undo in.
  "invalid-request": {
    message: "Zen Tidy couldn't tell which window to undo in. Open it from the window where you made that change, then Undo.",
    hideOffer: false,
  },
  unreachable: { message: UNREACHABLE_TEXT, hideOffer: false },
};

// undo-failed because only the open tab (or possible Glance tabs) could start the group again: trying again from the
// same tab fails the same way, so the line says what to do first. The router passes the failures' codes only.
export const GROUP_UNDO_NO_SAFE_TAB = "Undo can't start the group from the tab you have open. Switch to another tab, then Undo again.";

// What the view does with an undoGroupAction answer: undone (reload), or a notice.
export function groupUndoOutcome(response) {
  if (response?.ok) return { kind: "undone", report: isObject(response.report) ? response.report : null };
  const code = typeof response?.error === "string" ? response.error : "unknown";
  if (code === "undo-failed" && Array.isArray(response.failures) && response.failures.some((f) => f?.code === "no-safe-tab")) {
    return { kind: "notice", message: GROUP_UNDO_NO_SAFE_TAB, hideOffer: false };
  }
  if (Object.hasOwn(GROUP_UNDO_NOTICES, code)) return { kind: "notice", ...GROUP_UNDO_NOTICES[code] };
  return { kind: "notice", message: "Zen Tidy couldn't undo that. Try again.", hideOffer: false };
}

const quoted = (name) => `"${name}"`;
const madeName = (made) => (typeof made?.name === "string" ? made.name.trim() : "");
const someGroups = (n, word) => (n > 0 ? plural(n, word) : `the ${word}s`);

// The group undo notice: "Ungrouped "Recipes". Undo" (the button is popup.js's). made: { type, name } of the action
// this popup just made, so the line names its group; getGroups has no names, so after a reopen the line counts the
// groups and says when instead ("Ungrouped 1 group 3 h ago.").
export function groupUndoView(groupUndo, made = null, now = Date.now()) {
  if (!groupUndo?.available) return { show: false, text: "" };
  const fresh = isObject(made) && made.type === groupUndo.type;
  const name = fresh ? madeName(made) : "";
  const when = fresh ? "" : relativeTime(groupUndo.at, now);
  const end = when ? ` ${when}.` : ".";
  const n = groupUndo.groupCount;
  let text;
  if (groupUndo.type === "removeAll") text = `Removed ${someGroups(n, "tidy group")}${end}`;
  else if (groupUndo.type === "ungroup") text = name ? `Ungrouped ${quoted(name)}.` : `Ungrouped ${someGroups(n, "group")}${end}`;
  else text = name ? `Closed the tabs in ${quoted(name)}.` : `Closed the tabs in ${someGroups(n, "group")}${end}`;
  return { show: true, text };
}

// The line after a group undo went through, by the undone action's type.
export function groupUndoneText(type, made = null) {
  const name = isObject(made) && made.type === type ? madeName(made) : "";
  if (type === "ungroup") return name ? `Grouped ${quoted(name)} again.` : "Grouped the tabs again.";
  if (type === "closeAll") return name ? `Reopened the tabs in ${quoted(name)}.` : "Reopened the closed tabs.";
  return "The tidy groups are back.";
}

// The whole line after a group undo, from its report (undoGroupAction's: groupsRestored, tabsRestored, reopened,
// moved [{ title }], missing, nonReopenable [title], titlesKept, failures [{ scope, code?, count? }]): groupUndoneText,
// then what it left out, by count (F3: undo says which tabs it leaves alone; the view has room for counts, not titles).
// The first line says what came back only when something did, or when nothing was left to put back (an earlier attempt
// finished it): when nothing came back and something failed, "Undo couldn't put the tabs back."; when every tab found
// had moved since, "Nothing needed putting back." (or "Nothing was put back." when others weren't found either).
export function groupUndoneNotice(type, made, report) {
  const moved = Array.isArray(report?.moved) ? report.moved.length : count(report?.moved);
  const missing = count(report?.missing);
  const lost = Array.isArray(report?.nonReopenable) ? report.nonReopenable.length : count(report?.nonReopenable);
  const titlesKept = count(report?.titlesKept);
  const failures = Array.isArray(report?.failures) ? report.failures.filter(isObject) : [];
  const back = count(report?.groupsRestored) + count(report?.tabsRestored) + count(report?.reopened);
  let first;
  if (back > 0) first = groupUndoneText(type, made);
  else if (failures.length > 0) first = "Undo couldn't put the tabs back.";
  else if (moved > 0) first = missing + lost === 0 ? "Nothing needed putting back." : "Nothing was put back.";
  else first = groupUndoneText(type, made);
  const lines = [first];
  if (moved > 0) lines.push(moved === 1 ? "1 tab you moved since was left where it is." : `${moved} tabs you moved since were left where they are.`);
  if (missing > 0) lines.push(missing === 1 ? "1 tab wasn't found." : `${missing} tabs weren't found.`);
  if (lost > 0) lines.push(lost === 1 ? "1 tab couldn't be reopened." : `${lost} tabs couldn't be reopened.`);
  if (titlesKept > 0) {
    lines.push(titlesKept === 1 ? "1 group you renamed since keeps its new name." : `${titlesKept} groups you renamed since keep their new names.`);
  }
  if (failures.length > 0 && back > 0) lines.push("Not everything is exactly as it was.");
  return lines.join(" ");
}

// A line for what a group action that went through left undone, from its report's failures, or "": the tab Close all
// keeps open as the last of the Space ("last-tab"), and tabs that stayed open or in the group. Other failures (the
// suppression call, the journal's last write) changed nothing the person sees, so they get no line.
// - The kept tab is "for Undo" only while the report says the action can be undone.
// - Tabs that couldn't be closed: only failures that carry a count are summed. The ones that don't ("the group
//   changed", "closing stopped partway") come with a counted "N tabs were left open" for the tabs still open, so
//   counting them too would say one tab too many each; with no count at all the line says "some".
export function groupActionDetails(report) {
  const failures = Array.isArray(report?.failures) ? report.failures.filter(isObject) : [];
  const held = failures.filter((f) => f.code === "last-tab").reduce((n, f) => n + (count(f.count) || 1), 0);
  const open = failures.filter((f) => f.scope === "close" && f.code !== "last-tab");
  const unclosed = open.reduce((n, f) => n + count(f.count), 0);
  const grouped = failures.filter((f) => f.scope === "ungroup");
  const lines = [];
  if (held > 0 && report?.undoable === true) {
    lines.push(held === 1 ? "1 tab stayed open so this Space keeps a tab for Undo." : `${held} tabs stayed open so this Space keeps a tab for Undo.`);
  } else if (held > 0) {
    lines.push(held === 1 ? "1 tab stayed open as the last in this Space." : `${held} tabs stayed open as the last in this Space.`);
  }
  if (open.length) {
    if (unclosed === 0) lines.push("Some tabs couldn't be closed.");
    else lines.push(unclosed === 1 ? "1 tab couldn't be closed." : `${unclosed} tabs couldn't be closed.`);
  }
  if (grouped.length) lines.push("Some tabs stayed in the group.");
  return lines.join(" ");
}

// Close all's confirmation, naming the tabs Undo couldn't bring back (SPEC F4), as text: { text, titles, more },
// up to LEFT_ALONE_LISTED titles, then "and N more". popup.js renders the titles with textContent.
export function closeAllConfirm(name, titles) {
  const list = (Array.isArray(titles) ? titles : []).map((t) => (typeof t === "string" && t.trim()) || "Untitled tab");
  const group = typeof name === "string" && name.trim() ? quoted(name.trim()) : "this group";
  const n = list.length;
  const which = n === 0 ? "Undo can't reopen some of them." : `Undo can't reopen ${n} of them:`;
  return {
    text: `Close all tabs in ${group}? ${which}`,
    titles: list.slice(0, LEFT_ALONE_LISTED),
    more: n > LEFT_ALONE_LISTED ? `and ${n - LEFT_ALONE_LISTED} more` : "",
  };
}

export function removeAllConfirmText(n) {
  if (n === 1) return "Ungroup the tidy group in this Space? Its tabs stay open, and you can undo this.";
  return `Ungroup all ${n > 0 ? `${n} ` : ""}tidy groups in this Space? Their tabs stay open, and you can undo this.`;
}
