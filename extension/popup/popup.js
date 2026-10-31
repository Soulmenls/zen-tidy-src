// Zen Tidy popup. It talks to the background only through runtime.sendMessage (m2-, m3- and m4-contracts,
// "Messages") and follows the run through storage.session changes, plus a 1 s getState poll while a run is
// busy. Tab and model text reaches the DOM through textContent (or inert properties) only. The groups view is
// the popup's own state over the idle view (ui.groupsOpen), not a run state: it asks getGroups when it opens and
// after each group action.

import { ICONS } from "../shared/icons.js";
import {
  LEFTOVERS, initEdits, locateTab, moveTab, toggleTab, renameGroup, setIcon, deleteGroup, toApplyRequest,
  toSavedEdits, plural, checkedCount, startsCollapsed, groupHint, summarize, summaryText, canApply,
  nameMaxLength, previewBanners, refusedText, viewState, idleView, phaseLabel, elapsedSeconds, errorView,
  applyOutcome, appliedSummary, undoOffer, canUndoApplied, undoOutcome, undoneView, undoConfirmText,
  extrasOf, staleDaysOf, extrasHeadings, keepsText, setClose, isClosing, groupsModel, groupsSummary,
  groupNameMaxLength, renameRequest, groupActionOutcome, groupUndoOutcome, groupUndoView, groupUndoneNotice, groupActionDetails,
  closeAllConfirm, removeAllConfirmText,
} from "./popup-state.js";

const api = globalThis.browser;
const SAVE_DELAY_MS = 300;
const POLL_MS = 1000;
// A private type, so a dragged row can't be dropped as text into a name field or another page.
const DRAG_TYPE = "application/x-zen-tidy-tab";
// Must match grid-template-columns in popup.css; arrow keys move by this much vertically.
const PICKER_COLUMNS = 7;
// Zen's loading pill switches to its long-load variant after about this long.
const LONG_LOAD_MS = 3000;
// A confirmation stands in for the buttons that asked for it, in the same place, so the second click of a
// double-click (or a held Enter) would land on its "anyway" button. Clicks on it this soon after it showed are
// ignored, as is a click the browser counts as the second of a double-click.
const CONFIRM_GUARD_MS = 400;

const $ = (id) => document.getElementById(id);
const isObject = (value) => value !== null && typeof value === "object";

const ui = {
  windowId: null,
  run: null,
  hasKey: false,
  looseCount: null,
  // From getState: false when the runner would answer nothing-to-tidy; null when it couldn't count.
  canTidy: null,
  // A failure the popup hit itself (as opposed to run.error), with what Retry should do.
  localError: null,
  busy: false,
  loaded: false,
  // Editor state, kept while the preview id stays the same so a failed Apply can go back to it.
  preview: null,
  tabs: new Map(),
  edits: null,
  collapsed: new Map(),
  confirming: false,
  // An inline message under the editor after an Apply the background refused without changing
  // anything (another Space, or a failure before the first change). The edits stay.
  applyNotice: "",
  // What a choice in the icon picker does: set a preview group's icon, or send a group action.
  pickerChoose: null,
  moveTabId: null,
  // When the applying or undoing view first showed, for the loading pill's long-load variant.
  progressSince: null,
  // getState's `undo` ({ available, state, at, tabCount, multiWindow }); null while unknown, which includes
  // the time between starting an Apply (it replaces the journal) and the next getState.
  undo: null,
  // The undo multi-window confirmation is showing, in the idle or applied view.
  undoConfirming: false,
  // An inline message after an undo the background refused without changing anything (another Space or window,
  // nothing left to undo, another run busy).
  undoNotice: "",
  // The notice stands in for the Undo it answers (nothing left to undo here): the offer and #undo stay hidden while
  // it shows, so the same refused Undo isn't offered again.
  undoHidesOffer: false,
  // The button that asked for Undo, so "Go back" returns the keyboard to it.
  undoFrom: null,
  // ---- Groups view (m4-contracts, "Popup") ----
  groupsOpen: false,
  // getGroups' groups (groupsModel), null until the first answer since the view opened.
  groups: null,
  groupUndo: null,
  // Bumped when `groups` changes, so a render from a storage change or a poll leaves the rows (and a name being
  // typed) alone.
  groupsVersion: 0,
  groupsRendered: -1,
  // Group actions still out, renames left out (queueGroupWork): while any is, the view's buttons are off and the name
  // fields read-only. Every action, renames included, runs one after another (groupsChain), so a rename sent from a
  // blur while another action is out waits its turn rather than meeting the shared lock as "busy".
  groupsPending: 0,
  groupsChain: Promise.resolve(),
  // The inline line in the view's footer: a refusal, or what an undo brought back.
  groupsNotice: "",
  // The confirmation standing in for the footer's button: { kind: "removeAll" | "closeAll", groupId?, name?, ids?, from }
  // (ids: the tabs Close all's confirmation named, sent back with it).
  groupsConfirm: null,
  // The row (its group id, a string) whose Ungroup or Close all is out or asking for confirmation. It keeps those
  // actions on screen (.asking in popup.css), so the keyboard can go back to them.
  groupsAsking: null,
  // { type, name } of the last undoable action this popup made, so the undo notice names its group.
  groupUndoMade: null,
  // The undo notice gave way to a refusal that another Undo would only meet again.
  groupUndoHidden: false,
};

const groupsBusy = () => ui.groupsPending > 0;
// Undo and the group messages go to the popup's window; without one the background uses the last focused window.
const windowField = () => (ui.windowId === null ? {} : { windowId: ui.windowId });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconSpan(name) {
  const span = el("span", "zt-icon");
  span.dataset.icon = name;
  span.setAttribute("aria-hidden", "true");
  return span;
}

// Views and parts are shown and hidden with the hidden property only.
function shown(node) {
  for (let n = node; n; n = n.parentElement) if (n.hidden) return false;
  return true;
}

// The keyboard goes to the first of these buttons that shows and can be pressed. A change of view hides the button
// that had focus, which would otherwise leave it on the page itself.
function focusFirst(...ids) {
  for (const id of ids) {
    const button = id ? $(id) : null;
    if (button && !button.disabled && shown(button)) {
      button.focus();
      return;
    }
  }
}

let confirmShownAt = -Infinity;

const confirmShown = () => {
  confirmShownAt = performance.now();
};

// The "anyway" buttons' click handler: `action` runs unless the click came too soon (CONFIRM_GUARD_MS).
const guardedConfirm = (action) => (event) => {
  if (event?.detail > 1 || performance.now() - confirmShownAt < CONFIRM_GUARD_MS) return;
  action();
};

// The "anyway" buttons' keydown handler. A held Enter repeats its keydown, and each repeat activates the focused
// button, so the Enter that opened a confirmation would confirm it too once its repeats outlast the guard (Windows
// starts repeating after about 500 ms). A repeat never activates one; only a fresh press does.
const ignoreRepeat = (event) => {
  if (event.repeat) event.preventDefault();
};

// Zen squircles corners with a factor that depends on the OS (shared/zen-tokens.css, [data-os]).
// Extension pages can't use the -moz-platform media query, so the page asks the runtime.
function markPlatform() {
  try {
    api.runtime.getPlatformInfo().then((info) => {
      if (typeof info?.os === "string") document.documentElement.dataset.os = info.os;
    }).catch(() => {});
  } catch {
    // No platform info: the tokens keep the non-Windows factor.
  }
}

// Zen's long-load variant of the loading pill. Written only when it changes.
function setLongLoad(pill, on) {
  if (!pill || (pill.getAttribute("long-load") !== null) === on) return;
  if (on) pill.setAttribute("long-load", "");
  else pill.removeAttribute("long-load");
}

async function send(message) {
  try {
    const response = await api.runtime.sendMessage(message);
    return isObject(response) ? response : { error: "unreachable" };
  } catch {
    return { error: "unreachable" };
  }
}

const asError = (response) => ({ kind: response.error, message: response.message });

// ---- Run state ----

let refreshing = null;
// True from an Undo click until the background answers it. The router plans (journal, snapshot, every Space's groups,
// a window count) before it writes its "undoing" run, so a getState meanwhile still reads the run from before.
let undoPending = false;
const isUndoRun = (run) => run?.state === "undoing" || run?.state === "undone";

function refresh() {
  refreshing ??= (async () => {
    const sentWhileUndoing = undoPending;
    const response = await send({ type: "getState", windowId: ui.windowId });
    if (response.error) {
      // Later failures (a poll during a background restart) keep the last good state on screen.
      if (!ui.loaded) ui.localError = { ...asError(response), retry: refresh };
    } else {
      ui.loaded = true;
      ui.hasKey = Boolean(response.hasKey);
      ui.looseCount = Number.isInteger(response.looseCount) ? response.looseCount : null;
      ui.canTidy = typeof response.canTidy === "boolean" ? response.canTidy : null;
      const run = isObject(response.run) ? response.run : null;
      // The run from before the undo would bring back the view that offered Undo, with Undo enabled, for a moment.
      if (!((sentWhileUndoing || undoPending) && !isUndoRun(run))) ui.run = run;
      // While an apply or undo runs, the journal is being rewritten: a status read then may still describe the
      // previous tidy, so it counts as unknown.
      const rewriting = ui.run?.state === "applying" || ui.run?.state === "undoing";
      ui.undo = isObject(response.undo) && !rewriting ? response.undo : null;
    }
    render();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// A getState sent after this point. A poll started earlier may still be in flight with the state
// from before the background's last write, so wait for it and then ask again.
async function refreshAfter() {
  if (refreshing) await refreshing;
  return refresh();
}

function onStorageChanged(changes, area) {
  if (area !== "session" || !("run" in changes)) return;
  const run = changes.run.newValue;
  // Idle needs a fresh looseCount, which only getState has.
  if (!isObject(run) || run.state === "idle") {
    refresh();
    return;
  }
  ui.run = run;
  render();
}

let pollTimer = null;

function setPolling(on) {
  if (on && pollTimer === null) {
    pollTimer = setInterval(() => {
      if (document.body.dataset.state === "running") renderRunning();
      if (!refreshing) refresh();
    }, POLL_MS);
  } else if (!on && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---- Rendering ----

const currentError = () => ui.localError ?? ui.run?.error ?? null;

// The views that offer Undo, and their slots for Undo's parts:
// - slot: the undo notice and the multi-window confirmation, in every view with an Undo button;
// - interrupted: the interrupted notice (#undo-interrupted) goes first in `slot`, in the views that offer the journal
//   rather than the run on screen. That includes no-key (Undo needs no key) and the error view of a run the
//   background found dead (interruptedError);
// - offer: the "Last tidy" line, in the idle and no-key views.
const UNDO_SLOTS = {
  idle: { slot: "idle-undo-slot", interrupted: true, offer: "idle-offer-slot" },
  "no-key": { slot: "no-key-undo-slot", interrupted: true, offer: "no-key-offer-slot" },
  applied: { slot: "applied-undo-slot", interrupted: false, offer: null },
  error: { slot: "error-undo-slot", interrupted: true, offer: null },
};

// A tidy or apply the background found dead (run.js recover and expireStale: kind "interrupted") while the journal is
// one to undo with the interrupted notice: an apply that never finished, or an undo that didn't. Try again starts a
// new tidy, whose Apply would replace that journal for good, so the error view offers its Undo first.
const interruptedError = () =>
  !ui.localError && ui.run?.error?.kind === "interrupted" && undoOffer(ui.undo, Date.now()).kind === "interrupted";

function undoSlotFor(state) {
  if (state === "error") return interruptedError() ? UNDO_SLOTS.error : null;
  return Object.hasOwn(UNDO_SLOTS, state) ? UNDO_SLOTS[state] : null;
}

function render() {
  const state = ui.localError ? "error" : viewState({ run: ui.run, hasKey: ui.hasKey, groupsOpen: ui.groupsOpen });
  // A run taking the popup over closes the groups view for good: it doesn't come back when the run is over. Whatever
  // way the view closed, its confirmation and asking row go with it.
  if (state !== "groups") {
    ui.groupsOpen = false;
    ui.groupsConfirm = null;
    ui.groupsAsking = null;
  }
  // The icon picker opens from the preview and the groups view, and stays open while either re-renders.
  if (state !== document.body.dataset.state || (state !== "preview" && state !== "groups")) closePopover();
  if (state !== "preview") ui.confirming = false;
  if (state !== document.body.dataset.state) {
    ui.progressSince = null;
    // The undo notice and confirmation answer the view that offered Undo. Any change of view drops them, so neither
    // comes back when the run moves on (a tidy started elsewhere) and returns to that view.
    ui.undoConfirming = false;
    clearUndoNotice();
  }
  document.body.dataset.state = state;
  for (const view of document.querySelectorAll(".view")) view.hidden = view.dataset.view !== state;
  placeOptionsButton(state);
  placeUndoParts(state);
  if (state === "no-key") renderUndoOffer($("no-key-actions"));
  else if (state === "idle") renderIdle();
  else if (state === "running") renderRunning();
  else if (state === "preview") renderPreview();
  else if (state === "applying") renderProgress($("applying-loading"));
  else if (state === "applied") renderApplied();
  else if (state === "undoing") renderProgress($("undoing-loading"));
  else if (state === "undone") renderUndone();
  else if (state === "error") renderError();
  else if (state === "groups") renderGroups();
  setPolling(state === "running" || state === "applying" || state === "undoing");
}

function placeOptionsButton(state) {
  const button = $("open-options");
  if (state === "no-key") {
    button.textContent = "Add API key";
    button.className = "primary";
    $("no-key-actions").append(button);
    button.hidden = false;
  } else if (state === "error" && errorView(currentError()).showSettings) {
    button.textContent = "Open settings";
    button.className = "";
    // Under Try again (the primary, first in the stack) and above Close.
    $("error-actions").append(button, $("error-dismiss"));
    button.hidden = false;
  } else {
    button.hidden = true;
  }
}

// Undo's parts are single elements (their ids are test hooks), moved into the slots of the view that offers Undo
// (UNDO_SLOTS). While the confirmation shows, it stands in for that view's buttons.
function placeUndoParts(state) {
  const notice = $("undo-notice");
  const confirm = $("undo-confirm");
  const slots = undoSlotFor(state);
  if (slots) {
    const slot = $(slots.slot);
    if (notice.parentNode !== slot) slot.append(...(slots.interrupted ? [$("undo-interrupted")] : []), notice, confirm);
    if (slots.offer && $("undo-offer").parentNode !== $(slots.offer)) $(slots.offer).append($("undo-offer"));
  }
  // The error view keeps the interrupted notice from its last showing while its slot is off (renderUndoOffer shows it).
  if (!slots?.interrupted) $("undo-interrupted").hidden = true;
  // Written only when it changes: it is an alert.
  if (notice.textContent !== ui.undoNotice) notice.textContent = ui.undoNotice;
  notice.hidden = !slots || !ui.undoNotice || ui.undoConfirming;
  confirm.hidden = !slots || !ui.undoConfirming;
}

function clearUndoNotice() {
  ui.undoNotice = "";
  ui.undoHidesOffer = false;
}

function renderIdle() {
  const view = idleView({ looseCount: ui.looseCount, canTidy: ui.canTidy, busy: ui.busy });
  const tidy = $("tidy");
  tidy.textContent = view.label;
  tidy.disabled = view.disabled;
  $("idle-note").textContent = view.note;
  $("idle-note").hidden = ui.undoConfirming;
  renderUndoOffer($("idle-actions"));
}

// The last tidy, in the idle and no-key views: a quiet line with an Undo text action, or a notice when its apply (or
// an undo of it) never finished; in the error view of a dead run, that notice only. `actions` is the view's button
// stack, which the multi-window confirmation stands in for.
function renderUndoOffer(actions) {
  const offer = undoOffer(ui.undo, Date.now());
  const confirming = ui.undoConfirming;
  const hidden = confirming || ui.undoHidesOffer;
  actions.hidden = confirming;
  $("undo-offer").hidden = hidden || offer.kind !== "done";
  $("undo-offer-text").textContent = offer.kind === "done" ? offer.text : "";
  $("undo-interrupted").hidden = hidden || offer.kind !== "interrupted";
  $("undo-interrupted-text").textContent = offer.kind === "interrupted" ? offer.text : "";
  $("undo-last").disabled = ui.busy;
  $("undo-interrupted-button").disabled = ui.busy;
}

function renderRunning() {
  const seconds = elapsedSeconds(ui.run?.startedAt, Date.now());
  $("phase").textContent = phaseLabel(ui.run?.phase);
  $("elapsed").textContent = `${seconds} s`;
  setLongLoad($("running-loading"), seconds * 1000 >= LONG_LOAD_MS);
}

// Applying and undoing: re-rendered by every poll, so the pill turns long-load after about 3 s in the view.
function renderProgress(pill) {
  ui.progressSince ??= Date.now();
  setLongLoad(pill, Date.now() - ui.progressSince >= LONG_LOAD_MS);
}

function renderApplied() {
  const names = new Map((ui.edits?.groups ?? ui.run?.preview?.groups ?? []).map((g) => [g.key, g.name]));
  const { heading, summary, details } = appliedSummary(ui.run?.report, (key) => names.get(key));
  $("applied-title").textContent = heading;
  $("summary").textContent = summary;
  $("summary-details").replaceChildren(...details.map((line) => el("li", null, line)));
  $("applied-actions").hidden = ui.undoConfirming;
  $("done").disabled = ui.busy;
  $("undo").hidden = ui.undoHidesOffer || !canUndoApplied(ui.run?.report, ui.undo);
  $("undo").disabled = ui.busy;
}

// The tabs undo left alone are listed by their current title (tab text: textContent only, via el()).
function renderUndone() {
  const { heading, summary, leftAlone, details } = undoneView(ui.run?.report);
  $("undone-title").textContent = heading;
  $("undo-summary").textContent = summary;
  const lines = [];
  if (leftAlone) {
    lines.push(el("li", null, leftAlone.label), ...leftAlone.titles.map((title) => el("li", "detail-tab", title)));
    if (leftAlone.more) lines.push(el("li", null, leftAlone.more));
  }
  lines.push(...details.map((line) => el("li", null, line)));
  $("undo-details").replaceChildren(...lines);
  $("undo-done").disabled = ui.busy;
}

function renderError() {
  $("error-message").textContent = errorView(currentError()).message;
  $("retry").disabled = ui.busy;
  $("error-dismiss").disabled = ui.busy;
  if (undoSlotFor("error")) renderUndoOffer($("error-actions"));
  else $("error-actions").hidden = false;
}

// ---- Preview editor ----

function renderPreview() {
  const preview = ui.run.preview;
  if (!ui.edits || ui.preview?.id !== preview.id) buildEditor(preview, ui.run.edits);
  const banners = previewBanners(ui.preview, { runWindowId: ui.run.windowId, currentWindowId: ui.windowId });
  $("banner-multi-window").hidden = !banners.multiWindow;
  $("banner-other-window").hidden = !banners.otherWindow;
  $("banner-refused").hidden = banners.refused === 0;
  $("banner-refused").textContent = banners.refused ? refusedText(banners.refused) : "";
  renderFooter();
}

// Built once per preview with a fragment; later edits re-render only the cards they touch.
function buildEditor(preview, saved) {
  ui.preview = preview;
  ui.tabs = new Map([...(preview.groups ?? []).flatMap((g) => g.tabs ?? []), ...(preview.leftovers ?? [])]
    .map((t) => [t.tabId, t]));
  ui.edits = initEdits(preview, saved);
  ui.applyNotice = "";
  ui.collapsed = new Map(ui.edits.groups.map((g) => [g.key, startsCollapsed(g)]));
  const fragment = document.createDocumentFragment();
  for (const group of ui.edits.groups) fragment.append(renderCard(group));
  $("groups").replaceChildren(fragment);
  renderLeftovers();
  renderExtras();
  updateSummary();
  $("editor-scroll").scrollTop = 0;
  markScrolled($("editor-scroll"));
}

// Extras (m4-contracts, "Popup"): below "Stay loose", one section each for duplicates and stale tabs, each row a
// tab row with its own tick box. Built once per preview: a tick changes only the edits and the row of that tab in
// its group (commit), so the box keeps its focus.
function renderExtras() {
  const extras = extrasOf(ui.preview);
  const headings = extrasHeadings(extras, staleDaysOf(ui.preview));
  for (const kind of ["duplicates", "stale"]) {
    const rows = document.createDocumentFragment();
    for (const entry of extras[kind]) rows.append(renderExtraRow(entry, kind));
    $(`extras-${kind}-list`).replaceChildren(rows);
    $(`extras-${kind}-count`).textContent = headings[kind].count;
    $(`extras-${kind}`).hidden = extras[kind].length === 0;
  }
  $("extras-stale-label").textContent = headings.stale.label;
  $("extras").hidden = extras.duplicates.length + extras.stale.length === 0;
}

const textOf = (value) => (typeof value === "string" ? value : "");

// No Move button and not draggable: an extra is a tab to close, not one to place. The tab keeps its own row in its
// group (or "Stay loose"), where a tick here shows "Will close".
function renderExtraRow(entry, kind) {
  const row = el("div", "tab-row extra-row");
  row.dataset.extraTabId = String(entry.tabId);
  row.setAttribute("role", "listitem");
  const box = el("input", "extra-check");
  box.type = "checkbox";
  box.id = `extra-check-${entry.tabId}`;
  box.checked = isClosing(ui.edits, entry.tabId);
  const title = el("label", "tab-title", textOf(entry.title) || textOf(entry.site) || "Untitled tab");
  title.htmlFor = box.id;
  const meta = el("span", "tab-meta");
  if (textOf(entry.site)) meta.append(el("span", "tab-site", entry.site));
  if (entry.private === true) meta.append(el("span", "badge", "Private"));
  if (kind === "duplicates") meta.append(el("span", "tab-keeps", keepsText(entry.keepTitle)));
  const text = el("div", "tab-text");
  text.append(title, meta);
  row.append(box, text);
  return row;
}

function renderFooter() {
  // Written only when it changes: it is an alert, and every edit re-renders the footer.
  const notice = $("apply-notice");
  if (notice.textContent !== ui.applyNotice) notice.textContent = ui.applyNotice;
  notice.hidden = !ui.applyNotice || ui.confirming;
  $("foot-actions").hidden = ui.confirming;
  $("foot-confirm").hidden = !ui.confirming;
  $("apply").disabled = ui.busy || !ui.edits || !canApply(ui.edits, ui.preview);
  $("cancel").disabled = ui.busy;
}

function updateSummary() {
  $("preview-summary").textContent = summaryText(summarize(ui.edits));
  $("no-groups").hidden = ui.edits.groups.length > 0;
  renderFooter();
}

function renderCard(group) {
  const collapsed = ui.collapsed.get(group.key) ?? false;
  const card = el("section", "group-card");
  card.dataset.groupKey = group.key;
  card.dataset.kind = group.kind;

  const toggle = el("button", "group-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-controls", `tabs-${group.key}`);
  toggle.setAttribute("aria-label", "Show or hide tabs");
  toggle.append(el("span", "chevron"));

  const iconButton = el("button", "group-icon");
  iconButton.type = "button";
  iconButton.title = "Change icon";
  iconButton.setAttribute("aria-label", "Change icon");
  iconButton.setAttribute("aria-haspopup", "dialog");
  iconButton.setAttribute("aria-expanded", "false");
  iconButton.append(iconSpan(group.icon));

  const name = el("input", "group-name");
  name.type = "text";
  name.maxLength = nameMaxLength(group, ui.preview);
  name.autocomplete = "off";
  name.placeholder = "Group name";
  name.setAttribute("aria-label", "Group name");
  name.value = group.name;

  const remove = el("button", "group-delete");
  remove.type = "button";
  if (group.kind === "existing") {
    remove.classList.add("text-action");
    remove.textContent = "Don't add";
    remove.title = "Leave this group as it is";
  } else {
    remove.title = "Delete group";
    remove.setAttribute("aria-label", "Delete group");
    remove.append(iconSpan("trash"));
  }

  // The buttons' descriptions read the name field's value, so "Delete group" says which group.
  name.id = `group-name-${group.key}`;
  for (const button of [toggle, iconButton, remove]) button.setAttribute("aria-describedby", name.id);

  const head = el("div", "group-head");
  head.append(toggle, iconButton, name, el("span", "group-count"), remove);
  card.append(head);
  if (group.kind === "existing") card.append(el("p", "group-note", "Adding to existing group"));
  card.append(el("p", "group-hint"));

  const list = el("div", "tab-list");
  list.id = `tabs-${group.key}`;
  list.hidden = collapsed;
  if (group.tabs.length > 0) {
    list.setAttribute("role", "list");
    const rows = document.createDocumentFragment();
    for (const t of group.tabs) rows.append(renderRow(t.tabId, t.checked));
    list.append(rows);
  } else {
    list.append(el("p", "empty-note", "No tabs. Drop one here."));
  }
  card.append(list);
  updateCardCounts(card, group);
  return card;
}

// Tabs ticked to close leave the group (closing wins), so they count as unticked here. The size hint says which of
// the two left the group too small (groupHint).
function updateCardCounts(card, group) {
  if (!card || !group) return;
  const checked = checkedCount(group, ui.edits.close);
  const total = group.tabs.length;
  card.querySelector(".group-count").textContent = checked === total ? plural(total, "tab") : `${checked} of ${total}`;
  const hint = card.querySelector(".group-hint");
  const text = groupHint(group, ui.edits.close);
  if (hint.textContent !== text) hint.textContent = text;
  hint.hidden = text === "";
}

// checked is null for leftover rows: they stay loose whatever happens, so they get no tick box.
function renderRow(tabId, checked) {
  const ref = ui.tabs.get(tabId) ?? { tabId, title: "", site: "" };
  const row = el("div", "tab-row");
  row.dataset.tabId = String(tabId);
  row.draggable = true;
  row.setAttribute("role", "listitem");
  const titleId = `tab-title-${tabId}`;
  const label = ref.title || ref.site || "Untitled tab";
  let title;
  if (checked === null) {
    title = el("span", "tab-title", label);
  } else {
    const box = el("input", "tab-check");
    box.type = "checkbox";
    box.id = `tab-check-${tabId}`;
    box.checked = checked;
    row.append(box);
    title = el("label", "tab-title", label);
    title.htmlFor = box.id;
  }
  title.id = titleId;
  const meta = el("span", "tab-meta");
  if (ref.site) meta.append(el("span", "tab-site", ref.site));
  if (ref.private) meta.append(el("span", "badge", "Private"));
  if (ref.suspect) meta.append(el("span", "badge", "Possible Glance"));
  // Ticked in Extras: Apply closes it rather than grouping it.
  if (isClosing(ui.edits, tabId)) {
    row.classList.add("will-close");
    meta.append(el("span", "badge", "Will close"));
  }
  const text = el("div", "tab-text");
  text.append(title, meta);
  const move = el("button", "tab-move", "Move");
  move.classList.add("text-action");
  move.type = "button";
  move.setAttribute("aria-haspopup", "menu");
  move.setAttribute("aria-expanded", "false");
  move.setAttribute("aria-describedby", titleId);
  // The menu lists only the other places a tab can go: a loose tab with no group has none.
  move.hidden = checked === null && ui.edits.groups.length === 0;
  row.append(text, move);
  return row;
}

function renderLeftovers() {
  const rows = document.createDocumentFragment();
  for (const tabId of ui.edits.leftovers) rows.append(renderRow(tabId, null));
  $("leftovers-list").replaceChildren(rows);
  $("leftovers-count").textContent = String(ui.edits.leftovers.length);
  $("leftovers-empty").hidden = ui.edits.leftovers.length > 0;
}

const cardFor = (key) => [...$("groups").children].find((card) => card.dataset.groupKey === key) ?? null;
const listFor = (key) => (key === LEFTOVERS ? $("leftovers-list") : cardFor(key)?.querySelector(".tab-list"));

function replaceCard(key) {
  const card = cardFor(key);
  if (!card) return;
  const group = ui.edits.groups.find((g) => g.key === key);
  if (group) card.replaceWith(renderCard(group));
  else card.remove();
}

// Store new edits, re-render the touched cards, and queue a save. False when nothing changed.
function commit(next, touchedKeys) {
  if (next === ui.edits) return false;
  ui.edits = next;
  for (const key of new Set(touchedKeys)) {
    if (key === LEFTOVERS) renderLeftovers();
    else replaceCard(key);
  }
  updateSummary();
  scheduleSave();
  return true;
}

function doMove(tabId, targetKey, refocus) {
  const from = locateTab(ui.edits, tabId);
  const rows = [...(listFor(from)?.querySelectorAll(".tab-row") ?? [])];
  const index = rows.findIndex((row) => row.dataset.tabId === String(tabId));
  if (!commit(moveTab(ui.edits, tabId, targetKey), [from, targetKey]) || !refocus) return;
  // Keep the keyboard where it was: the row that took this one's place, or the card itself.
  const remaining = listFor(from)?.querySelectorAll(".tab-row") ?? [];
  const row = remaining[Math.min(index, remaining.length - 1)];
  (row?.querySelector(".tab-move") ?? cardFor(from)?.querySelector(".group-toggle") ?? $("apply")).focus();
}

function onEditorClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const card = button.closest(".group-card");
  const key = card?.dataset.groupKey;
  if (button.classList.contains("group-toggle")) {
    const collapsed = !(ui.collapsed.get(key) ?? false);
    ui.collapsed.set(key, collapsed);
    card.querySelector(".tab-list").hidden = collapsed;
    button.setAttribute("aria-expanded", String(!collapsed));
  } else if (button.classList.contains("group-icon")) {
    const group = ui.edits.groups.find((g) => g.key === key);
    if (group) openIconPicker(button, group.icon, (name) => chooseEditorIcon(key, name));
  } else if (button.classList.contains("group-delete")) {
    const neighbour = card.nextElementSibling ?? card.previousElementSibling;
    if (commit(deleteGroup(ui.edits, key), [key, LEFTOVERS])) {
      (neighbour?.querySelector(".group-toggle") ?? $("cancel")).focus();
    }
  } else if (button.classList.contains("tab-move")) {
    openMoveMenu(button, Number(button.closest(".tab-row").dataset.tabId));
  }
}

function onEditorChange(event) {
  if (event.target.classList.contains("extra-check")) {
    onExtraChange(event.target);
    return;
  }
  if (!event.target.classList.contains("tab-check")) return;
  const tabId = Number(event.target.closest(".tab-row").dataset.tabId);
  const next = toggleTab(ui.edits, tabId, event.target.checked);
  if (next === ui.edits) return;
  ui.edits = next;
  const key = locateTab(next, tabId);
  updateCardCounts(cardFor(key), next.groups.find((g) => g.key === key));
  updateSummary();
  scheduleSave();
}

// A tick in Extras: the summary and Apply follow, and the tab's own row (in its group or "Stay loose") is
// re-rendered with or without "Will close", along with its group's count and size hint.
function onExtraChange(box) {
  const tabId = Number(box.closest(".tab-row").dataset.extraTabId);
  const next = setClose(ui.edits, tabId, box.checked);
  const where = locateTab(next, tabId);
  commit(next, where === null ? [] : [where]);
}

function onEditorInput(event) {
  if (!event.target.classList.contains("group-name")) return;
  const key = event.target.closest(".group-card").dataset.groupKey;
  const next = renameGroup(ui.edits, key, event.target.value);
  if (next === ui.edits) return;
  ui.edits = next;
  updateSummary();
  scheduleSave();
}

// ---- Drag and drop (the "Move" menu is the keyboard path) ----

let dropTarget = null;

function setDropTarget(zone) {
  if (dropTarget === zone) return;
  dropTarget?.classList.remove("drop-target");
  dropTarget = zone;
  dropTarget?.classList.add("drop-target");
}

function dropZone(event) {
  if (!event.dataTransfer?.types?.includes(DRAG_TYPE)) return null;
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  return target?.closest(".group-card, #leftovers") ?? null;
}

function wireDragAndDrop(scroll) {
  scroll.addEventListener("dragstart", (event) => {
    const row = event.target instanceof Element ? event.target.closest(".tab-row") : null;
    // Extras rows (no data-tab-id) are never dragged: their tab keeps its own row to move.
    if (!row || row.dataset.tabId === undefined) return;
    closePopover();
    event.dataTransfer.setData(DRAG_TYPE, row.dataset.tabId);
    event.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  scroll.addEventListener("dragover", (event) => {
    const zone = dropZone(event);
    if (!zone) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(zone);
  });
  scroll.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !scroll.contains(event.relatedTarget)) setDropTarget(null);
  });
  scroll.addEventListener("drop", (event) => {
    const zone = dropZone(event);
    if (!zone) return;
    event.preventDefault();
    setDropTarget(null);
    const tabId = Number(event.dataTransfer.getData(DRAG_TYPE));
    if (Number.isInteger(tabId)) doMove(tabId, zone.id === "leftovers" ? LEFTOVERS : zone.dataset.groupKey, false);
  });
  scroll.addEventListener("dragend", () => {
    setDropTarget(null);
    scroll.querySelector(".dragging")?.classList.remove("dragging");
  });
}

// ---- Popovers: the icon picker and the "Move to…" menu share one open slot ----

const popover = { el: null, anchor: null };

function openPopover(pop, anchor) {
  closePopover();
  pop.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  popover.el = pop;
  popover.anchor = anchor;
  placePopover(pop, anchor);
  document.addEventListener("pointerdown", onOutsidePointer, true);
}

// Below the anchor if it fits, else above, clamped to the viewport. Positioned through the CSSOM,
// which the CSP allows (style attributes are what it blocks).
function placePopover(pop, anchor) {
  const margin = 8;
  const a = anchor.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const below = a.bottom + 4;
  const top = below + p.height <= innerHeight - margin ? below : Math.max(margin, a.top - 4 - p.height);
  const left = Math.max(margin, Math.min(a.left, innerWidth - margin - p.width));
  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

// Zen's scroll edge: a hairline under the header only while the list is scrolled (popup.css).
function markScrolled(scroll) {
  if (scroll.scrollTop > 0) scroll.dataset.scrolled = "";
  else delete scroll.dataset.scrolled;
}

// The preview's and the groups view's lists. Scroll events arrive a frame late: one caused by focusing or
// scrolling to an anchor can land just after its popover opened. So follow the anchor, and close only once it has
// left the visible list.
function onListScroll(event) {
  const scroll = event.currentTarget;
  markScrolled(scroll);
  const { el: pop, anchor } = popover;
  if (!pop) return;
  const a = anchor.getBoundingClientRect();
  const view = scroll.getBoundingClientRect();
  if (!anchor.isConnected || a.bottom <= view.top || a.top >= view.bottom) closePopover();
  else placePopover(pop, anchor);
}

function closePopover({ restoreFocus = false } = {}) {
  const { el: pop, anchor } = popover;
  if (!pop) return;
  pop.hidden = true;
  anchor.setAttribute("aria-expanded", "false");
  popover.el = null;
  popover.anchor = null;
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  if (restoreFocus && anchor.isConnected) anchor.focus();
}

function onOutsidePointer(event) {
  if (popover.el?.contains(event.target) || popover.anchor?.contains(event.target)) return;
  closePopover();
}

// Arrow keys move through the items (a grid for the picker, a list for the menu); Escape closes.
function onPopoverKey(event, columns) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePopover({ restoreFocus: true });
    return;
  }
  const items = [...event.currentTarget.querySelectorAll("button:not([disabled])")];
  const current = items.indexOf(document.activeElement);
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
  let next = null;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (step !== undefined) next = current < 0 ? 0 : Math.min(items.length - 1, Math.max(0, current + step));
  if (next === null || !items[next]) return;
  event.preventDefault();
  items[next].focus();
}

function wirePopover(pop, columns, onChoose) {
  pop.addEventListener("keydown", (event) => onPopoverKey(event, columns));
  pop.addEventListener("click", (event) => {
    const item = event.target.closest("button");
    if (item && !item.disabled) onChoose(item);
  });
  // Tabbing out closes it, so it never floats over a part of the page the user moved on to.
  pop.addEventListener("focusout", (event) => {
    const to = event.relatedTarget;
    if (popover.el === pop && to && !pop.contains(to) && to !== popover.anchor) closePopover();
  });
}

// Zen's folder icon picker: a single "Icons" header, then the grid of icon buttons.
function buildIconPicker() {
  const picker = $("icon-picker");
  const head = el("div", "picker-head");
  head.append(el("span", "picker-head-label", "Icons"));
  const grid = el("div", "picker-grid");
  const items = document.createDocumentFragment();
  for (const name of ICONS) {
    const item = el("button", "picker-item");
    item.type = "button";
    item.dataset.icon = name;
    item.title = name;
    item.setAttribute("aria-label", name);
    item.setAttribute("aria-pressed", "false");
    item.append(iconSpan(name));
    items.append(item);
  }
  grid.append(items);
  picker.append(head, grid);
  wirePopover(picker, PICKER_COLUMNS, (item) => chooseIcon(item.dataset.icon));
}

// The one icon picker, for a preview group or a tidy group in the groups view: opened on `current`, and a choice
// goes to onChoose(name).
function openIconPicker(anchor, current, onChoose) {
  if (popover.anchor === anchor) {
    closePopover({ restoreFocus: true });
    return;
  }
  ui.pickerChoose = onChoose;
  const picker = $("icon-picker");
  const grid = picker.querySelector(".picker-grid");
  let selected = null;
  for (const item of grid.children) {
    const on = item.dataset.icon === current;
    item.setAttribute("aria-pressed", String(on));
    if (on) selected = item;
  }
  openPopover(picker, anchor);
  (selected ?? grid.firstElementChild).focus();
}

function chooseIcon(name) {
  const choose = ui.pickerChoose;
  ui.pickerChoose = null;
  closePopover({ restoreFocus: true });
  choose?.(name);
}

function chooseEditorIcon(key, name) {
  const next = setIcon(ui.edits, key, name);
  if (next === ui.edits) return;
  ui.edits = next;
  const span = cardFor(key)?.querySelector(".group-icon .zt-icon");
  if (span) span.dataset.icon = next.groups.find((g) => g.key === key).icon;
  updateSummary();
  scheduleSave();
}

function menuItem(key, label, icon) {
  const item = el("button", "menu-item");
  item.type = "button";
  item.dataset.targetKey = key;
  item.setAttribute("role", "menuitem");
  item.append(icon ? iconSpan(icon) : el("span", "menu-spacer"), el("span", "menu-label", label));
  return item;
}

// As Zen's "Move to Folder": only the other groups, then a separator and "Leave loose" last. The
// tab's current place is left out rather than shown disabled.
function openMoveMenu(anchor, tabId) {
  if (popover.anchor === anchor) {
    closePopover({ restoreFocus: true });
    return;
  }
  const from = locateTab(ui.edits, tabId);
  const items = document.createDocumentFragment();
  const others = ui.edits.groups.filter((g) => g.key !== from);
  for (const g of others) items.append(menuItem(g.key, g.name.trim() || "Untitled group", g.icon));
  if (from !== LEFTOVERS) {
    if (others.length > 0) {
      const separator = el("div", "menu-separator");
      separator.setAttribute("role", "separator");
      items.append(separator);
    }
    items.append(menuItem(LEFTOVERS, "Leave loose", null));
  }
  if (items.childNodes.length === 0) return;
  ui.moveTabId = tabId;
  const menu = $("move-menu");
  menu.replaceChildren(items);
  openPopover(menu, anchor);
  menu.querySelector("button:not([disabled])")?.focus();
}

function chooseMove(item) {
  closePopover();
  doMove(ui.moveTabId, item.dataset.targetKey, true);
}

// ---- Saving edits ----

let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

function cancelSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
}

function saveNow() {
  cancelSave();
  if (!ui.edits || !ui.run?.id || ui.run.preview?.id !== ui.edits.previewId) return;
  send({ type: "saveEdits", runId: ui.run.id, edits: toSavedEdits(ui.edits) });
}

// ---- Actions ----

async function startTidy() {
  ui.busy = true;
  clearUndoNotice();
  render();
  const response = await send({ type: "startTidy", windowId: ui.windowId });
  ui.busy = false;
  if (response.started) {
    await refresh();
  } else if (response.error === "no-key") {
    ui.hasKey = false;
    render();
  } else if (response.error === "nothing-to-tidy") {
    await refreshAfter();
    // getState skips the count while the runner is busy; then the refusal is the best answer there is.
    if (ui.canTidy !== true) {
      ui.canTidy = false;
      render();
    }
  } else if (response.error === "busy") {
    await refresh();
  } else {
    ui.localError = { ...asError(response), retry: startTidy };
    render();
  }
}

function onApply() {
  if (ui.preview?.multiWindow) {
    ui.confirming = true;
    renderFooter();
    confirmShown();
    $("confirm-multi-window").focus();
    return;
  }
  apply(false);
}

async function apply(confirmMultiWindow) {
  // Send a pending save first: if the background keeps the preview, a reopened popup shows these edits.
  if (saveTimer !== null) saveNow();
  const runId = ui.run.id;
  const previewId = ui.edits.previewId;
  const request = toApplyRequest(ui.edits);
  ui.confirming = false;
  ui.applyNotice = "";
  // This Apply replaces the journal, so the undo info from before it is stale until the next getState.
  ui.undo = null;
  // Show progress at once; the background's own "applying" write follows through storage.
  ui.run = { ...ui.run, state: "applying" };
  render();
  const response = await send({ type: "apply", runId, request, confirmMultiWindow });
  const outcome = applyOutcome(response);
  if (outcome.kind === "applied") {
    if (ui.run?.id === runId) ui.run = { ...ui.run, state: "applied", report: outcome.report ?? ui.run.report };
    render();
    // The applying view took the keyboard with it when it hid Apply.
    focusFirst("done");
    return;
  }
  if (outcome.kind === "confirm" || outcome.kind === "notice") {
    // The background left the run in "preview", so the editor comes back as it was. Never an error
    // view here: its Retry would send the same refused Apply again.
    await refreshAfter();
    if (ui.run?.state === "preview" && ui.run.id === runId && ui.run.preview?.id === previewId) {
      if (outcome.kind === "confirm") ui.confirming = true;
      else ui.applyNotice = outcome.message;
      render();
      if (outcome.kind === "confirm") {
        confirmShown();
        $("confirm-multi-window").focus();
      }
      // The save sent before Apply may have reached the background while the run was "applying".
      saveNow();
      return;
    }
  }
  ui.localError = { ...(outcome.error ?? asError(response)), retry: retryAfterApply };
  await refresh();
  // A failure during the apply itself is stored in the run (state "error"); show that one instead.
  if (ui.run?.state === "error") {
    ui.localError = null;
    render();
  }
}

// Back to the editor with the same edits if the background kept the preview; otherwise tidy again.
async function retryAfterApply() {
  await refresh();
  if (ui.run?.state !== "preview") await startTidy();
}

async function onCancel() {
  cancelSave();
  ui.applyNotice = "";
  ui.busy = true;
  renderFooter();
  const response = await send({ type: "cancel", runId: ui.run?.id });
  ui.busy = false;
  if (response.error) ui.localError = { ...asError(response), retry: refresh };
  await refresh();
}

async function dismissRun() {
  ui.busy = true;
  clearUndoNotice();
  ui.undoConfirming = false;
  render();
  await send({ type: "dismiss", runId: ui.run?.id });
  ui.busy = false;
  await refresh();
}

// Undo from the idle, no-key or error view (#undo-last, #undo-interrupted-button) or the applied view (#undo). A tidy
// made with more than one window open asks first; the background also asks when it counts more windows now.
function onUndo(event) {
  ui.undoFrom = event?.currentTarget?.id ?? null;
  clearUndoNotice();
  if (ui.undo?.multiWindow === true) {
    askUndoConfirmation();
    return;
  }
  undo(false);
}

// windowCount: the background's count, when it is the one asking (undoConfirmText).
function askUndoConfirmation(windowCount) {
  ui.undoConfirming = true;
  $("undo-confirm-text").textContent = undoConfirmText(windowCount, ui.undo?.multiWindow === true);
  render();
  if ($("undo-confirm").hidden) return;
  confirmShown();
  $("confirm-undo-multi").focus();
}

function onUndoBack() {
  ui.undoConfirming = false;
  render();
  const from = ui.undoFrom ? $(ui.undoFrom) : null;
  if (from && !from.hidden) from.focus();
}

async function undo(confirmMultiWindow) {
  ui.undoConfirming = false;
  clearUndoNotice();
  // Show progress at once; the background's own "undoing" run follows through storage. Until it answers, polls keep
  // this view (undoPending), and every button stays off, should a storage change bring back the view from before.
  const runBefore = ui.run?.id;
  ui.run = { ...(ui.run ?? {}), state: "undoing" };
  ui.busy = true;
  undoPending = true;
  render();
  // Without a window id the background undoes in the last focused window; a null one would be refused.
  const response = await send({
    type: "undo", ...(ui.windowId === null ? {} : { windowId: ui.windowId }), confirmMultiWindow,
  });
  undoPending = false;
  ui.busy = false;
  const outcome = undoOutcome(response);
  if (outcome.kind === "undone") {
    // Never the report the run carried before (an applied view's ApplyReport).
    ui.run = { ...ui.run, state: "undone", report: outcome.report };
    render();
    focusFirst("undo-done");
    // The undo ran as a run of its own: fetch its id (Done dismisses it) and the spent journal's status.
    await refreshAfter();
    return;
  }
  if (outcome.kind === "confirm" || outcome.kind === "notice") {
    // The background left the run as it was, so the view that offered Undo comes back.
    await refreshAfter();
    if (undoSlotFor(viewState({ run: ui.run, hasKey: ui.hasKey })) && !ui.localError) {
      if (outcome.kind === "confirm") askUndoConfirmation(outcome.windowCount);
      else {
        ui.undoNotice = outcome.message;
        ui.undoHidesOffer = outcome.hideOffer;
        render();
      }
    }
    // The undoing view took the keyboard with it: back to the button that asked, or the view's own first button.
    if (!ui.undoConfirming) focusFirst(ui.undoFrom, "tidy", "done", "open-options", "retry", "idle-settings");
    return;
  }
  ui.localError = { ...outcome.error, retry: onUndo };
  // A poll sent while the undo was out kept the run from before; this getState is sent after the answer.
  await refreshAfter();
  // A failure after changes began is stored in the undo's own run (state "error"); show that one instead. A refusal
  // puts back the run from before, which may be an error too (Undo from a dead run's error view): not this one's.
  if (ui.run?.state === "error" && ui.run.id !== runBefore) {
    ui.localError = null;
    render();
  }
}

// Try again after an undo that stopped partway: the journal is still undoable. Dismissing the error run first
// brings back the view that offers Undo, where a multi-window confirmation can show.
async function retryUndo() {
  await send({ type: "dismiss", runId: ui.run?.id });
  await refresh();
  onUndo();
}

function onRetry() {
  const retry = ui.localError?.retry ?? (ui.run?.error?.kind === "undo-failed" ? retryUndo : startTidy);
  ui.localError = null;
  retry();
}

function onErrorDismiss() {
  if (ui.localError) {
    ui.localError = null;
    refresh();
  } else {
    dismissRun();
  }
}

function openOptions() {
  api.runtime.openOptionsPage().catch(() => {});
}

// ---- Groups view (m4-contracts, "Popup") ----
//
// The tidy groups in this Space, one row each: icon, name, tab count, collapse toggle, and Ungroup and Close all
// revealed on hover or focus. Each change is a groupAction message; the list is read again after every answer, so
// the rows always show what the background found.

function openGroups() {
  ui.groupsOpen = true;
  ui.groups = null;
  ui.groupUndo = null;
  ui.groupsVersion += 1;
  ui.groupsNotice = "";
  ui.groupUndoMade = null;
  ui.groupUndoHidden = false;
  render();
  focusFirst("groups-back");
  loadGroups();
}

function closeGroups() {
  ui.groupsOpen = false;
  render();
  focusFirst("open-groups");
  // The idle view still shows the getState from before the view opened, and group actions write no run, so no storage
  // change brings a new one: Ungroup, Remove all and their Undo change what Tidy would find, and Close all what the
  // last tidy still holds. Asked once any group action still out has its answer (the chain), and after any poll in
  // flight (refreshAfter), so the answer is never one from before the change.
  ui.groupsChain.then(refreshAfter);
}

async function loadGroups() {
  const response = await send({ type: "getGroups", ...windowField() });
  if (!ui.groupsOpen) return;
  const model = groupsModel(response);
  if (model.ok) {
    ui.groups = model.groups;
    ui.groupUndo = model.groupUndo;
    ui.groupsVersion += 1;
    // A Close all asking about a group that is gone (ungrouped from its row meanwhile) would send a close the
    // background refuses, and it hides the notices, Undo's among them: it goes, and its row stops asking.
    const confirm = ui.groupsConfirm;
    if (confirm?.kind === "closeAll" && !model.groups.some((g) => g.id === confirm.groupId)) {
      ui.groupsConfirm = null;
      releaseRow(confirm.from);
    }
  } else if (!ui.groupsNotice) {
    // The rows from the last good answer stay; the notice says they may be out of date.
    ui.groupsNotice = model.message;
  }
  render();
}

const groupRows = () => [...$("groups-list").children];
const groupRowFor = (id) => groupRows().find((row) => row.dataset.groupId === String(id)) ?? null;
const groupOfRow = (row) => (ui.groups ?? []).find((g) => String(g.id) === row?.dataset.groupId) ?? null;

// Where the keyboard goes back to: a footer button by id, or a control of a row by the row's group and the
// control's class (rows are updated in place, but one that is gone has no element to keep).
const controlFrom = (button) => {
  const row = button.closest(".groups-row");
  if (!row) return { id: button.id };
  return { groupId: row.dataset.groupId, cls: [...button.classList].find((c) => c.startsWith("groups-")) };
};

function controlFor(from) {
  if (!from) return null;
  if (from.id) return $(from.id);
  return groupRowFor(from.groupId)?.querySelector(`.${from.cls}`) ?? null;
}

// The focused element is gone or was hidden (its row left, or the view changed under it).
function focusLost() {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || !shown(active);
}

// A row's Ungroup and Close all show only on hover or while the keyboard is in the row (popup.css; at rest they are
// clipped to nothing, still in the focus order). So the row that asked keeps them on screen (.asking) while its action
// is out or asking, and until the focus is back in it, where :focus-within takes over.
function markAsking() {
  for (const row of groupRows()) {
    if (row.dataset.groupId === ui.groupsAsking) row.classList.add("asking");
    else row.classList.remove("asking");
  }
}

// from: the control that asked (controlFrom). Its row stops asking, unless another row has asked since.
function releaseRow(from) {
  if (from?.groupId === undefined || ui.groupsAsking !== from.groupId) return;
  ui.groupsAsking = null;
  markAsking();
}

function renderGroups() {
  if (ui.groupsRendered !== ui.groupsVersion) {
    renderGroupRows();
    ui.groupsRendered = ui.groupsVersion;
  }
  markAsking();
  const groups = ui.groups;
  const busy = groupsBusy();
  const confirm = ui.groupsConfirm;
  $("groups-summary").textContent = groups ? groupsSummary(groups) : "";
  $("groups-empty").hidden = !(Array.isArray(groups) && groups.length === 0);
  for (const button of $("groups-list").querySelectorAll("button")) button.disabled = busy;
  // A name typed while an action is out would wait behind it in the chain, and be lost if the popup closed first.
  for (const input of $("groups-list").querySelectorAll(".groups-name")) input.readOnly = busy;
  // Written only when it changes: it is an alert.
  const notice = $("groups-notice");
  if (notice.textContent !== ui.groupsNotice) notice.textContent = ui.groupsNotice;
  notice.hidden = !ui.groupsNotice || Boolean(confirm);
  const undo = groupUndoView(ui.groupUndo, ui.groupUndoMade, Date.now());
  $("group-undo-text").textContent = undo.text;
  $("group-undo-notice").hidden = !undo.show || ui.groupUndoHidden || Boolean(confirm);
  $("group-undo").disabled = busy;
  $("groups-foot-actions").hidden = Boolean(confirm);
  $("groups-remove-all").disabled = busy || !groups?.length;
  $("remove-all-confirm").hidden = confirm?.kind !== "removeAll";
  $("close-all-confirm").hidden = confirm?.kind !== "closeAll";
  for (const id of ["confirm-remove-all", "confirm-close-all"]) $(id).disabled = busy;
}

// Rows are kept and updated in place while the groups and their order stay the same, so a toggle or a new icon
// keeps the keyboard where it was and a name being typed in another row isn't overwritten.
function renderGroupRows() {
  const list = $("groups-list");
  const groups = ui.groups ?? [];
  const current = groupRows();
  const same = current.length === groups.length && groups.every((g, i) => current[i].dataset.groupId === String(g.id));
  if (!same) {
    const active = document.activeElement;
    const byId = new Map(current.map((row) => [row.dataset.groupId, row]));
    list.replaceChildren(...groups.map((g) => byId.get(String(g.id)) ?? groupRow(g)));
    // Moving a row takes the focus from a control in it.
    if (active && active !== document.activeElement && active.isConnected) active.focus();
  }
  for (const group of groups) updateGroupRow(groupRowFor(group.id), group);
}

// The preview card's header parts (Zen's Space-form name row), with the row actions as text actions.
function groupRow(group) {
  const row = el("div", "group-head groups-row");
  row.dataset.groupId = String(group.id);
  row.setAttribute("role", "listitem");
  const nameId = `groups-name-${group.id}`;

  // Its tooltip says what a click does (updateGroupRow); its name and aria-pressed say the state.
  const collapse = el("button", "group-toggle groups-collapse");
  collapse.type = "button";
  collapse.setAttribute("aria-label", "Collapsed");
  collapse.append(el("span", "chevron"));

  const icon = el("button", "group-icon groups-icon");
  icon.type = "button";
  icon.title = "Change icon";
  icon.setAttribute("aria-label", "Change icon");
  icon.setAttribute("aria-haspopup", "dialog");
  icon.setAttribute("aria-expanded", "false");
  icon.append(iconSpan(group.icon));

  const name = el("input", "group-name groups-name");
  name.type = "text";
  name.id = nameId;
  name.autocomplete = "off";
  name.placeholder = "Group name";
  name.setAttribute("aria-label", "Group name");

  const ungroup = el("button", "text-action groups-ungroup", "Ungroup");
  ungroup.type = "button";
  ungroup.title = "Ungroup: its tabs stay open";
  const close = el("button", "text-action groups-close", "Close all");
  close.type = "button";
  close.title = "Close all of its tabs";
  const actions = el("span", "groups-actions");
  actions.append(ungroup, close);

  // The buttons' descriptions read the name field's value, so "Close all" says which group.
  for (const button of [collapse, icon, ungroup, close]) button.setAttribute("aria-describedby", nameId);
  row.append(collapse, icon, name, el("span", "group-count"), actions);
  return row;
}

// A name field keeps its text while it has the focus, and while it holds a name a refused rename didn't save
// (data-unsent, commitName), so the person can send it again rather than type it again.
function updateGroupRow(row, group) {
  if (!row) return;
  row.querySelector(".groups-icon .zt-icon").dataset.icon = group.icon;
  const name = row.querySelector(".groups-name");
  name.maxLength = groupNameMaxLength(group);
  if (document.activeElement !== name && name.dataset.unsent === undefined) name.value = group.name;
  row.querySelector(".group-count").textContent = plural(group.tabCount, "tab");
  const collapse = row.querySelector(".groups-collapse");
  collapse.setAttribute("aria-pressed", String(group.collapsed));
  collapse.title = group.collapsed ? "Expand" : "Collapse";
}

function onGroupsClick(event) {
  const button = event.target.closest("button");
  const group = groupOfRow(button?.closest(".groups-row"));
  if (!button || !group) return;
  const from = controlFrom(button);
  if (button.classList.contains("groups-collapse")) {
    groupAction({ action: "collapse", groupId: group.id, collapsed: !group.collapsed }, { from });
  } else if (button.classList.contains("groups-icon")) {
    openIconPicker(button, group.icon, (icon) => {
      if (icon !== group.icon) groupAction({ action: "icon", groupId: group.id, icon }, { from });
    });
  } else if (button.classList.contains("groups-ungroup")) {
    ui.groupsAsking = from.groupId;
    groupAction({ action: "ungroup", groupId: group.id }, { from, made: { type: "ungroup", name: group.name } });
  } else if (button.classList.contains("groups-close")) {
    ui.groupsAsking = from.groupId;
    groupAction({ action: "closeAll", groupId: group.id }, { from, made: { type: "closeAll", name: group.name } });
  }
}

// The name saves on Enter or when the field loses focus. Escape in a field holding an edit puts the group's name back
// (as Zen's own rename fields do) and goes no further: the popup would close on it, and closing saves the edit.
// With nothing to discard, Escape closes the popup as usual. While a rename of the field is queued or out (Enter, then
// Escape), the name it is saving is the one to go back to: the group's own would be renamed back on the next blur.
function onGroupsKey(event) {
  const input = event.target;
  if (event.isComposing || !input.classList?.contains("groups-name")) return;
  if (event.key === "Enter") {
    event.preventDefault();
    commitName(input, true);
  } else if (event.key === "Escape") {
    const group = groupOfRow(input.closest(".groups-row"));
    if (!group) return;
    delete input.dataset.unsent;
    const name = input.dataset.sent ?? group.name;
    if (input.value === name) return;
    event.preventDefault();
    event.stopPropagation();
    input.value = name;
  }
}

function onGroupsFocusOut(event) {
  if (event.target.classList?.contains("groups-name")) commitName(event.target, false);
}

// A name with nothing to send (the same, or no visible text) goes back to the group's own on Enter, and on a blur
// unless the field is empty: WebDriver's Element Clear blurs the field it empties before typing into it, and the
// typed name must not land after a name put back meanwhile. The next update of the row fills an empty field in.
// A rename the background refuses (busy, unreachable) keeps its text in the field (data-unsent, updateGroupRow) until
// a rename goes through, the field has nothing to send, or Escape puts the name back. explicit: Enter; a blur moves no
// focus once it is answered (the person moved it on, or clicked away).
function commitName(input, explicit) {
  const group = groupOfRow(input.closest(".groups-row"));
  if (!group) return;
  const name = renameRequest(group, input.value);
  if (name === null) {
    delete input.dataset.unsent;
    if (explicit || input.value.trim() !== "") input.value = group.name;
    return;
  }
  // Enter, then a blur before the answer: the same rename once. The mark lasts exactly as long as the rename is queued
  // or out, so a list read for another action meanwhile can't let the blur send it twice, and a refused rename can
  // be sent again even when the list couldn't be read after it.
  if (input.dataset.sent === name) return;
  input.dataset.sent = name;
  const typed = input.value;
  groupAction({ action: "rename", groupId: group.id, name }, {
    from: explicit ? { groupId: String(group.id), cls: "groups-name" } : null,
    rename: true,
    onOutcome: (outcome) => {
      if (outcome.kind === "notice") input.dataset.unsent = typed;
      else delete input.dataset.unsent;
    },
  }).finally(() => {
    delete input.dataset.sent;
  });
}

// Closing the popup (pagehide): a changed name the field holds goes out at once, not through the chain, where it would
// wait for answers that never come once the page is gone. Not one already queued or out (data-sent).
function sendNameNow(input) {
  const group = groupOfRow(input.closest(".groups-row"));
  const name = group ? renameRequest(group, input.value) : null;
  if (name === null || input.dataset.sent === name) return;
  input.dataset.sent = name;
  send({ type: "groupAction", ...windowField(), action: "rename", groupId: group.id, name });
}

// Group actions and the group undo run one after another (groupsChain). Each answer reads the list again. work() may
// return a step for once the buttons are back on (a disabled button can't take the keyboard): a confirmation, or where
// the focus goes. While any but a rename is out, the view's buttons are off (groupsPending). A rename leaves them on and
// the view as it is: the blur that sends one comes from the mousedown of a click (or a Tab), and a button turned off,
// or moved, before the mouseup would never get that click. A click made meanwhile waits its turn in the chain.
function queueGroupWork(work, { rename = false } = {}) {
  if (!rename) {
    ui.groupsPending += 1;
    ui.groupsNotice = "";
    render();
  }
  const run = ui.groupsChain.then(async () => {
    let after = null;
    try {
      after = await work();
    } finally {
      if (!rename) ui.groupsPending -= 1;
      render();
    }
    // Once the render above has turned the buttons back on.
    if (typeof after === "function") after();
  });
  ui.groupsChain = run.catch(() => {});
  return run;
}

// params: the groupAction fields (m4-contracts, "Messages"). made: { type, name } for the undoable ones, so the undo
// notice can name the group. from: where the keyboard goes back to, or null to leave it where it is. rename: see
// queueGroupWork. onOutcome(outcome): called with the answer's outcome, before the list is read again.
function groupAction(params, { from = null, made = null, rename = false, onOutcome = null } = {}) {
  return queueGroupWork(async () => {
    const response = await send({ type: "groupAction", ...windowField(), ...params });
    if (!ui.groupsOpen) return null;
    const outcome = groupActionOutcome(response, params.action);
    onOutcome?.(outcome);
    if (outcome.kind === "confirm") {
      // Remove all asked before it sent; a background that asks anyway gets the same confirmation.
      if (params.action === "removeAll") return () => askRemoveAll(from);
      return () => askCloseAll(params.groupId, made?.name ?? "", outcome, from);
    }
    if (outcome.kind === "done") {
      // Close all's tab kept open as the Space's last, tabs left open or in the group: said, by count.
      ui.groupsNotice = groupActionDetails(outcome.report);
      if (made) {
        ui.groupUndoMade = made;
        ui.groupUndoHidden = false;
      }
    } else if (outcome.kind === "notice") {
      ui.groupsNotice = outcome.message;
    }
    await loadGroups();
    return () => {
      if (from && focusLost()) {
        // The row that asked is gone (ungrouped or closed): its Undo is the next thing the person may want.
        if (outcome.kind === "done" && made) focusFirst("group-undo", "groups-remove-all", "groups-back");
        else (shownControl(from) ?? $("groups-back")).focus();
      }
      releaseRow(from);
    };
  }, { rename });
}

const shownControl = (from) => {
  const control = controlFor(from);
  return control && !control.disabled && shown(control) ? control : null;
};

// asked: the confirm outcome ({ titles, ids }): the tabs Undo couldn't reopen, named, and their ids, which the
// confirmed Close all sends back so the background closes no such tab it didn't name (a second confirm-needed asks
// again, with the new list).
function askCloseAll(groupId, name, asked, from) {
  const view = closeAllConfirm(name, asked.titles);
  ui.groupsConfirm = { kind: "closeAll", groupId, name, ids: asked.ids, from };
  $("close-all-confirm-text").textContent = view.text;
  const items = view.titles.map((title) => el("li", "detail-tab", title));
  if (view.more) items.push(el("li", null, view.more));
  $("close-all-tabs").replaceChildren(...items);
  render();
  confirmShown();
  $("confirm-close-all").focus();
}

function askRemoveAll(from = { id: "groups-remove-all" }) {
  ui.groupsConfirm = { kind: "removeAll", from };
  $("remove-all-confirm-text").textContent = removeAllConfirmText(ui.groups?.length ?? 0);
  render();
  confirmShown();
  $("confirm-remove-all").focus();
}

function confirmGroups() {
  const confirm = ui.groupsConfirm;
  if (!confirm) return;
  ui.groupsConfirm = null;
  if (confirm.kind === "removeAll") {
    groupAction({ action: "removeAll", confirm: true }, { from: confirm.from, made: { type: "removeAll", name: "" } });
  } else {
    groupAction({ action: "closeAll", groupId: confirm.groupId, confirm: true, confirmTabIds: confirm.ids },
      { from: confirm.from, made: { type: "closeAll", name: confirm.name } });
  }
}

// A row's Close all takes the keyboard back while the confirmation still keeps that row's actions on screen
// (markAsking); the footer's Remove all shows again only once the confirmation is gone.
function cancelGroupsConfirm() {
  const from = ui.groupsConfirm?.from;
  shownControl(from)?.focus();
  ui.groupsConfirm = null;
  releaseRow(from);
  render();
  if (focusLost()) (shownControl(from) ?? $("groups-back")).focus();
}

function onGroupUndo() {
  const type = ui.groupUndo?.type;
  const made = ui.groupUndoMade;
  return queueGroupWork(async () => {
    const response = await send({ type: "undoGroupAction", ...windowField() });
    if (!ui.groupsOpen) return null;
    const outcome = groupUndoOutcome(response);
    if (outcome.kind === "undone") {
      ui.groupsNotice = groupUndoneNotice(type, made, outcome.report);
      ui.groupUndoMade = null;
    } else {
      ui.groupsNotice = outcome.message;
      ui.groupUndoHidden = outcome.hideOffer;
    }
    await loadGroups();
    // Undo hides its own notice once it went through (or can't be tried again).
    return () => {
      if (focusLost()) focusFirst("group-undo", "groups-remove-all", "groups-back");
    };
  });
}

// ---- Start ----

async function init() {
  markPlatform();
  $("tidy").addEventListener("click", startTidy);
  $("idle-settings").addEventListener("click", openOptions);
  $("open-options").addEventListener("click", openOptions);
  $("apply").addEventListener("click", onApply);
  $("cancel").addEventListener("click", onCancel);
  $("confirm-multi-window").addEventListener("click", guardedConfirm(() => apply(true)));
  $("confirm-back").addEventListener("click", () => {
    ui.confirming = false;
    renderFooter();
    $("apply").focus();
  });
  $("done").addEventListener("click", dismissRun);
  for (const id of ["undo", "undo-last", "undo-interrupted-button"]) $(id).addEventListener("click", onUndo);
  $("confirm-undo-multi").addEventListener("click", guardedConfirm(() => undo(true)));
  $("confirm-undo-back").addEventListener("click", onUndoBack);
  $("undo-done").addEventListener("click", dismissRun);
  $("retry").addEventListener("click", onRetry);
  $("error-dismiss").addEventListener("click", onErrorDismiss);

  $("open-groups").addEventListener("click", openGroups);
  $("groups-back").addEventListener("click", closeGroups);
  $("groups-remove-all").addEventListener("click", () => askRemoveAll());
  $("confirm-remove-all").addEventListener("click", guardedConfirm(confirmGroups));
  $("confirm-close-all").addEventListener("click", guardedConfirm(confirmGroups));
  for (const id of ["confirm-multi-window", "confirm-undo-multi", "confirm-remove-all", "confirm-close-all"]) {
    $(id).addEventListener("keydown", ignoreRepeat);
  }
  for (const id of ["confirm-remove-all-back", "confirm-close-all-back"]) $(id).addEventListener("click", cancelGroupsConfirm);
  $("group-undo").addEventListener("click", onGroupUndo);
  const groupsList = $("groups-list");
  groupsList.addEventListener("click", onGroupsClick);
  groupsList.addEventListener("keydown", onGroupsKey);
  groupsList.addEventListener("focusout", onGroupsFocusOut);
  $("groups-scroll").addEventListener("scroll", onListScroll, { passive: true });

  const scroll = $("editor-scroll");
  scroll.addEventListener("click", onEditorClick);
  scroll.addEventListener("change", onEditorChange);
  scroll.addEventListener("input", onEditorInput);
  scroll.addEventListener("scroll", onListScroll, { passive: true });
  wireDragAndDrop(scroll);
  buildIconPicker();
  wirePopover($("move-menu"), 1, chooseMove);

  // Closing the popup must not lose the last few keystrokes of an edit: the preview's pending save, or a name typed in
  // the groups view, which saves on blur and may never get one. sendNameNow sends only a changed name, once.
  addEventListener("pagehide", () => {
    if (saveTimer !== null) saveNow();
    if (ui.groupsOpen) for (const input of $("groups-list").querySelectorAll(".groups-name")) sendNameNow(input);
  });
  api.storage.onChanged.addListener(onStorageChanged);

  try {
    ui.windowId = (await api.windows.getCurrent()).id;
  } catch {
    ui.windowId = null;
  }
  await refresh();
}

init();
