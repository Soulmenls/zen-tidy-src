// Zen Tidy settings (notes/m6-contracts.md, "Options page").
//
// The API key follows implementation-notes, "Key field": the value is read once on Save and the field is cleared
// straight away; the page only ever shows the last 4 characters, from getKeyStatus. The key itself is never written to
// the DOM, an attribute or a log, and it can't be copied, cut or dragged out of the field.
//
// The other settings come from getSettings ({ settings, defaults }) and go back through saveSettings ({ patch }: only
// the fields being changed, a list whole, as edited) and resetSettings ({ fields }). Model, effort, precision and stale
// days save on change; custom instructions only on Save; a sensitive list on each add, remove, put back or reset. Every settings
// request waits for the one before it. Text reaches the page through textContent only, and the background's own
// message is never shown: each failure has a fixed line next to its field. The one exception is Test key, whose line
// says why the key failed (options-state.js, "The API key's lines").

import {
  MODELS, EFFORTS, PRECISIONS, LISTS, MAX_PREFERENCES, resetField, LOAD_FAILED, RESET_FAILED, SAVED, RESTORED,
  PREFERENCES_CONFIRM, PREFERENCES_CONFIRM_UNSAVED, STALE_DAYS_INVALID, KEY_FORMAT, KEY_EMPTY, KEY_SAVE_FAILED,
  KEY_CLEAR_FAILED, KEY_WAIT, readSettings, savedSettings, saveErrorText, testFailureText, otherChoice, counterText,
  preferencesProblem, parseStaleDays, entryKey, filterText, addEntry, removeEntry, displayOrder, listEdits, sameEntries,
  fullText, countText, emptyText, filterStatusText, removedSummary, resetConfirmText,
} from "./options-state.js";

const api = globalThis.browser;
const KEYS_URL = "https://platform.claude.com/settings/keys";

const $ = (id) => document.getElementById(id);

// ---- The API key (M2) ----

const keyInput = $("key-input");
const saveButton = $("key-save");
const testButton = $("key-test");
const clearButton = $("key-clear");
const status = $("key-status");
const keyError = $("key-error");
const testResult = $("test-result");
const testHint = $("key-test-hint");

let saved = false;
let busy = false;

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

async function send(message) {
  try {
    const response = await api.runtime.sendMessage(message);
    return response !== null && typeof response === "object" ? response : { error: "unreachable" };
  } catch {
    return { error: "unreachable" };
  }
}

// Test checks the saved key, never the text in the field (no message ever carries a typed key). So
// while the field holds a key that isn't saved yet, Test is off: its result would read as if it were
// about the key the user just pasted.
const fieldHasText = () => keyInput.value.trim() !== "";

function setBusy(on) {
  busy = on;
  const typed = fieldHasText();
  saveButton.disabled = on;
  testButton.disabled = on || !saved || typed;
  testHint.hidden = !typed;
  clearButton.disabled = on || !saved;
  // The wait is over: the line asking for it would be stale.
  if (!on && keyError.textContent === KEY_WAIT) keyError.textContent = "";
}

// The key buttons go off while a request is out, and a focused button that goes off drops the keyboard to the page
// (Firefox's focus fixup), leaving a screen reader nowhere. So it moves to the key field first, which is never off, as
// each settings reset hands it to its own field.
function holdFocus() {
  if ([saveButton, testButton, clearButton].includes(document.activeElement)) keyInput.focus();
}

function showTestResult(ok, text) {
  testResult.dataset.ok = String(ok);
  testResult.textContent = text;
}

async function refreshStatus() {
  const response = await send({ type: "getKeyStatus" });
  if (response.error) {
    saved = false;
    status.textContent = "Couldn't read the key status. Reload this page to try again.";
  } else {
    saved = Boolean(response.saved);
    // Only the last four characters ever come back from the background.
    const last4 = typeof response.last4 === "string" ? response.last4.slice(-4) : "";
    status.textContent = saved ? `Key saved (…${last4})` : "No key saved yet.";
  }
  saveButton.textContent = saved ? "Replace" : "Save";
  setBusy(busy);
}

async function onSave() {
  // Only Enter in the field gets here while a request is out (Save is off): say so, rather than leave the key sitting
  // in the field with no word.
  if (busy) {
    keyError.textContent = KEY_WAIT;
    return;
  }
  const key = keyInput.value;
  keyInput.value = "";
  keyError.textContent = "";
  testResult.textContent = "";
  if (!key.trim()) {
    keyError.textContent = KEY_EMPTY;
    return;
  }
  holdFocus();
  setBusy(true);
  const response = await send({ type: "saveKey", key });
  setBusy(false);
  if (response.error) keyError.textContent = response.error === "invalid-key-format" ? KEY_FORMAT : KEY_SAVE_FAILED;
  await refreshStatus();
}

async function onTest() {
  if (busy || !saved || fieldHasText()) return;
  holdFocus();
  setBusy(true);
  showTestResult(true, "Testing…");
  const response = await send({ type: "testKey" });
  setBusy(false);
  // A key typed while the test was out isn't the one tested: its answer would read as a verdict on the new text.
  if (fieldHasText()) {
    testResult.textContent = "";
    return;
  }
  if (response.ok) showTestResult(true, "The key works.");
  else showTestResult(false, testFailureText(response));
}

async function onClear() {
  if (busy || !saved) return;
  holdFocus();
  setBusy(true);
  const response = await send({ type: "clearKey" });
  setBusy(false);
  keyError.textContent = response.error ? KEY_CLEAR_FAILED : "";
  testResult.textContent = "";
  await refreshStatus();
}

saveButton.addEventListener("click", onSave);
testButton.addEventListener("click", onTest);
clearButton.addEventListener("click", onClear);
// A new tab, never a navigation of this page (the field may hold text).
$("get-key").addEventListener("click", () => {
  api.tabs.create({ url: KEYS_URL }).catch(() => {});
});
// Typing turns Test off (setBusy), and an earlier result for the saved key goes, so it can't be read
// as a verdict on the new text.
keyInput.addEventListener("input", () => {
  if (fieldHasText()) testResult.textContent = "";
  setBusy(busy);
});
// Enter saves through the same button handler; there is no form to submit.
keyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    onSave();
  }
});
// The mask is only a look: copied, cut or dragged out, the text would be the key in the clear (m6-contracts, "Key
// field"). Paste stays allowed.
for (const type of ["copy", "cut", "dragstart"]) {
  keyInput.addEventListener(type, (event) => event.preventDefault());
}
// The field's selection holds the key in the clear too, and browser features read it: the context menu's "Search
// with…", translate and chatbot items, and the find bar, which a find shortcut fills with the selection. So the
// selection collapses to its end before any of them looks. Selecting all stays possible, so Ctrl+A then a paste or
// Delete still replaces the whole hidden text instead of adding to it.
const collapseKeySelection = () => {
  if (keyInput.selectionStart !== keyInput.selectionEnd) {
    keyInput.setSelectionRange(keyInput.selectionEnd, keyInput.selectionEnd);
  }
};
// Ctrl/Cmd+F and +G (find, find again), Cmd+E (find the selection) and F3, with or without Shift.
const findsSelection = (event) => {
  const key = event.key?.toLowerCase();
  return key === "f3" || ((event.ctrlKey || event.metaKey) && (key === "f" || key === "g")) || (event.metaKey && key === "e");
};
keyInput.addEventListener("contextmenu", collapseKeySelection);
keyInput.addEventListener("keydown", (event) => {
  if (findsSelection(event)) collapseKeySelection();
});
// Don't leave a half-typed key behind in the page when it is closed or put in the back-forward cache.
addEventListener("pagehide", () => {
  keyInput.value = "";
});

// ---- Settings (M6) ----

// getSettings' answer once read: the settings as last saved (each section keeps its own fields current) and the
// built-in values, for the resets and the "added" and "removed defaults" marks.
const state = { loaded: false, settings: null, defaults: null };

let queue = Promise.resolve();
// One settings request at a time, in the order they were made: the background stores them in that order, and an
// answer can't overtake a later choice. send() never rejects. onSend runs as the message goes out.
function request(message, onSend) {
  queue = queue.then(() => {
    onSend?.();
    return send(message);
  });
  return queue;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// An error line next to its field. With `field`, the field is marked invalid while the line shows. The line is only
// rewritten when it changes, so a screen reader doesn't announce it again on every keystroke.
function setError(node, text, field = null) {
  if (node.textContent !== text) node.textContent = text;
  field?.setAttribute("aria-invalid", text ? "true" : "false");
}

// A reset that needs a second step: the trigger hides and the confirmation shows with Cancel first, where the trigger
// was, and the keyboard on it. The second click of a double-click on the trigger is never a confirmation.
function createConfirm(prefix, trigger, onConfirm) {
  const box = $(`${prefix}-confirm`);
  const text = $(`${prefix}-confirm-text`);
  const cancel = $(`${prefix}-confirm-cancel`);
  const close = () => {
    box.hidden = true;
    trigger.hidden = false;
  };
  const back = () => {
    close();
    trigger.focus();
  };
  cancel.addEventListener("click", back);
  $(`${prefix}-confirm-reset`).addEventListener("click", (event) => {
    if (event.detail > 1) return;
    close();
    onConfirm();
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      back();
    }
  });
  return {
    show(message) {
      text.textContent = message;
      trigger.hidden = true;
      box.hidden = false;
      cancel.focus();
    },
  };
}

// ---- Model, effort, precision and stale days: saved on change ----

const settingsError = $("settings-error");
const modelSelect = $("model");
const effortSelect = $("effort");
const precisionSelect = $("precision");
const staleInput = $("stale-days");
const modelReset = $("model-reset");
const precisionReset = $("precision-reset");
const staleReset = $("stale-days-reset");

// seq counts the requests made for a field, so only the answer to the latest one changes what the field shows.
const scalars = {
  model: { input: modelSelect, error: $("model-error"), status: $("model-status"), seq: 0 },
  effort: { input: effortSelect, error: $("effort-error"), status: $("model-status"), seq: 0 },
  precision: { input: precisionSelect, error: $("precision-error"), status: $("precision-status"), seq: 0 },
  staleDays: { input: staleInput, error: $("stale-days-error"), status: $("stale-days-status"), seq: 0 },
};
// The resets out: their buttons stay off until the answer.
const resetsOut = new Set();

// A stored value the select doesn't list (a model newer than this page) shows as "Other: <id>" and is kept.
function showChoice(select, choices, value) {
  let listed = false;
  for (const option of [...select.querySelectorAll("option")]) {
    if (option.value === value) listed = true;
    else if (option.dataset.other) option.remove();
  }
  if (!listed) {
    const option = el("option", "", otherChoice(choices, value));
    option.value = value;
    option.dataset.other = "true";
    select.append(option);
  }
  select.value = value;
}

function showScalar(field) {
  const value = state.settings[field];
  if (field === "model") showChoice(modelSelect, MODELS, value);
  else if (field === "effort") showChoice(effortSelect, EFFORTS, value);
  // The setting is a number; the select's values are text.
  else if (field === "precision") showChoice(precisionSelect, PRECISIONS, String(value));
  else staleInput.value = String(value);
}

function updateResets() {
  const { settings, defaults } = state;
  modelReset.disabled = !state.loaded || resetsOut.has("model") ||
    (settings.model === defaults.model && settings.effort === defaults.effort);
  precisionReset.disabled = !state.loaded || resetsOut.has("precision") || settings.precision === defaults.precision;
  staleReset.disabled = !state.loaded || resetsOut.has("staleDays") || settings.staleDays === defaults.staleDays;
}

function startRequest(field) {
  const part = scalars[field];
  part.seq += 1;
  part.status.textContent = "";
  setError(part.error, "", part.input);
  return part.seq;
}

// After an answer: the saved value is the new baseline, but the field shows it only if no later request is out for
// it. A failure puts the last saved value back.
function finishRequest(field, seq, settings, failure) {
  const part = scalars[field];
  if (settings) state.settings[field] = settings[field];
  if (seq !== part.seq) return false;
  showScalar(field);
  if (!settings) setError(part.error, failure, part.input);
  return Boolean(settings);
}

async function saveScalar(field, value) {
  const seq = startRequest(field);
  const response = await request({ type: "saveSettings", patch: { [field]: value } });
  const settings = savedSettings(response);
  if (finishRequest(field, seq, settings, saveErrorText(field, response))) scalars[field].status.textContent = SAVED;
  updateResets();
}

async function resetScalars(fields) {
  const seqs = fields.map(startRequest);
  const first = scalars[fields[0]];
  resetsOut.add(fields[0]);
  updateResets();
  // The button is off while the reset is out, and stays off once the values are the defaults.
  first.input.focus();
  const response = await request({ type: "resetSettings", fields });
  const settings = savedSettings(response);
  resetsOut.delete(fields[0]);
  const shown = fields.map((field, i) => finishRequest(field, seqs[i], settings, ""));
  if (settings && shown.some(Boolean)) first.status.textContent = RESTORED;
  else if (!settings) setError(first.error, RESET_FAILED, first.input);
  updateResets();
}

modelSelect.addEventListener("change", () => saveScalar("model", modelSelect.value));
effortSelect.addEventListener("change", () => saveScalar("effort", effortSelect.value));
precisionSelect.addEventListener("change", () => saveScalar("precision", Number(precisionSelect.value)));
staleInput.addEventListener("change", () => {
  const days = parseStaleDays(staleInput.value);
  if (days === null) {
    // An answer still out mustn't put a number back over what the person is fixing.
    startRequest("staleDays");
    setError(scalars.staleDays.error, STALE_DAYS_INVALID, staleInput);
    return;
  }
  saveScalar("staleDays", days);
});
modelReset.addEventListener("click", () => resetScalars(["model", "effort"]));
precisionReset.addEventListener("click", () => resetScalars(["precision"]));
staleReset.addEventListener("click", () => resetScalars(["staleDays"]));

// ---- Custom instructions: explicit Save and Revert ----

const prefsInput = $("preferences");
const prefsCount = $("preferences-count");
const prefsError = $("preferences-error");
const prefsStatus = $("preferences-status");
const prefsSave = $("preferences-save");
const prefsRevert = $("preferences-revert");
const prefsReset = $("preferences-reset");
// busy: a save or reset is out. failure: its fixed line, until the next edit.
const prefs = { busy: false, failure: "", seq: 0 };

function updatePreferences() {
  const text = prefsInput.value;
  const problem = preferencesProblem(text);
  prefsCount.textContent = counterText(text.length);
  prefsCount.dataset.over = String(text.length > MAX_PREFERENCES);
  setError(prefsError, problem || prefs.failure, prefsInput);
  const dirty = state.loaded && text !== state.settings.preferences;
  // While a save or reset is out the text stays as sent: a reset's answer would overwrite what is typed meanwhile, and
  // a save's "Saved" would stand next to text that isn't.
  prefsInput.readOnly = prefs.busy;
  prefsSave.disabled = !state.loaded || prefs.busy || !dirty || problem !== "";
  prefsRevert.disabled = !state.loaded || prefs.busy || !dirty;
  prefsReset.disabled = !state.loaded || prefs.busy || state.settings.preferences === state.defaults.preferences;
}

function startPreferences() {
  prefs.busy = true;
  prefs.failure = "";
  prefs.seq += 1;
  prefsStatus.textContent = "";
  updatePreferences();
  return prefs.seq;
}

async function savePreferences() {
  const value = prefsInput.value;
  // The same rules that turn Save off, so a click that slips through saves nothing either.
  if (!state.loaded || prefs.busy || value === state.settings.preferences || preferencesProblem(value)) return;
  // Save goes off while it is out, and stays off once saved: the keyboard goes back to the text, as Revert does.
  if (document.activeElement === prefsSave) prefsInput.focus();
  const seq = startPreferences();
  const response = await request({ type: "saveSettings", patch: { preferences: value } });
  const settings = savedSettings(response);
  prefs.busy = false;
  if (settings) state.settings.preferences = settings.preferences;
  if (seq === prefs.seq) {
    if (settings) prefsStatus.textContent = SAVED;
    else prefs.failure = saveErrorText("preferences", response);
  }
  updatePreferences();
}

async function resetPreferences() {
  const seq = startPreferences();
  prefsInput.focus();
  const response = await request({ type: "resetSettings", fields: ["preferences"] });
  const settings = savedSettings(response);
  prefs.busy = false;
  if (settings) state.settings.preferences = settings.preferences;
  if (seq === prefs.seq) {
    if (settings) {
      prefsInput.value = settings.preferences;
      prefsStatus.textContent = RESTORED;
    } else {
      prefs.failure = RESET_FAILED;
    }
  }
  updatePreferences();
}

const prefsConfirm = createConfirm("preferences", prefsReset, resetPreferences);

// Typing saves nothing: it updates the counter, Save and Revert, and drops a line about an earlier save.
prefsInput.addEventListener("input", () => {
  prefs.failure = "";
  prefsStatus.textContent = "";
  updatePreferences();
});
prefsSave.addEventListener("click", savePreferences);
prefsRevert.addEventListener("click", () => {
  prefsInput.value = state.settings.preferences;
  prefs.failure = "";
  prefsStatus.textContent = "";
  updatePreferences();
  prefsInput.focus();
});
prefsReset.addEventListener("click", () => {
  prefsConfirm.show(prefsInput.value === state.settings.preferences ? PREFERENCES_CONFIRM : PREFERENCES_CONFIRM_UNSAVED);
});

// ---- The sensitive lists ----
//
// Each list is drawn once (renderEditor) and then edited in place: an add or a put back draws one chip at the top, a
// remove takes one away, and the filter only toggles `hidden`. Only a reset, or an answer that disagrees with the page
// (a failed save, or a change made elsewhere), draws the list again. Saves coalesce: while one is out, further edits
// wait and go in a single save of the whole list once it is back.
//
// Keyboard: a list of hundreds of chips would be hundreds of Tab stops between Add and Reset (m6-contracts,
// "Keyboard"). As in Firefox's own exception lists, Tab enters a list once, at its current chip, and goes on past it;
// the arrow keys, Home and End move between the chips that show. The current chip's button is the list's one with
// tabIndex 0; every other chip's is -1. The note that says so (#chips-keys) describes that button, the one the keyboard
// lands on, so a screen reader reads it there: the list itself is never a Tab stop.

const NEXT = "nextElementSibling";
const PREVIOUS = "previousElementSibling";

// One Tab stop for the chips of `listNode`, through their `selector` buttons.
function rovingList(listNode, selector) {
  const keys = { current: null };
  const buttonOf = (chip) => chip?.querySelector(selector) ?? null;
  // The first chip that shows from `chip` on, stepping by `step` (NEXT or PREVIOUS).
  const shownFrom = (chip, step) => {
    for (let node = chip; node; node = node[step]) if (!node.hidden) return node;
    return null;
  };
  keys.set = (button) => {
    if (keys.current === button) return;
    if (keys.current) {
      keys.current.tabIndex = -1;
      keys.current.removeAttribute("aria-describedby");
    }
    keys.current = button;
    if (button) {
      button.tabIndex = 0;
      button.setAttribute("aria-describedby", "chips-keys");
    }
  };
  // After the chips or the filter change: the current chip if it is still on the list and shows, else the first that
  // shows (none when none does).
  keys.check = () => {
    const chip = keys.current?.closest(".chip");
    if (chip && chip.parentNode === listNode && !chip.hidden) return;
    keys.set(buttonOf(shownFrom(listNode.firstElementChild, NEXT)));
  };
  // A chip focused another way (a click, a screen reader) becomes the current one.
  listNode.addEventListener("focusin", (event) => {
    const button = event.target.closest(selector);
    if (button) keys.set(button);
  });
  listNode.addEventListener("keydown", (event) => {
    const chip = event.target.closest(selector)?.closest(".chip");
    if (!chip) return;
    // Where each key starts looking for a chip that shows, and which way.
    const moves = {
      ArrowRight: [chip[NEXT], NEXT], ArrowDown: [chip[NEXT], NEXT],
      ArrowLeft: [chip[PREVIOUS], PREVIOUS], ArrowUp: [chip[PREVIOUS], PREVIOUS],
      Home: [listNode.firstElementChild, NEXT], End: [listNode.lastElementChild, PREVIOUS],
    };
    if (!Object.hasOwn(moves, event.key)) return;
    // The arrows would scroll the box otherwise; at either end the keyboard stays where it is.
    event.preventDefault();
    const next = buttonOf(shownFrom(...moves[event.key]));
    if (!next) return;
    keys.set(next);
    next.focus();
  });
  return keys;
}

function createEditor(list) {
  const part = (suffix) => $(`${list}-${suffix}`);
  const editor = {
    list,
    field: LISTS[list].field,
    count: part("count"),
    filter: part("filter"),
    filterStatus: part("filter-status"),
    listNode: part("list"),
    empty: part("empty"),
    add: part("add"),
    addButton: part("add-button"),
    error: part("error"),
    removed: part("removed"),
    removedSummary: part("removed-summary"),
    removedList: part("removed-list"),
    reset: part("reset"),
    status: part("status"),
    // The list as the page shows it, as last saved, and the built-in one.
    entries: [],
    saved: [],
    defaults: [],
    defaultKeys: new Set(),
    // Entry key -> { node, text } for the chips, and -> node for the removed defaults.
    rows: new Map(),
    removedRows: new Map(),
    shown: 0,
    // The save loop's promise while one runs, and whether edits are waiting for the next save.
    saving: null,
    again: false,
    resetting: false,
    // Counts the edits and resets, like a scalar's seq (see refreshSettings).
    seq: 0,
  };
  editor.confirm = createConfirm(list, editor.reset, () => resetList(editor));
  editor.chipKeys = rovingList(editor.listNode, ".chip-remove");
  editor.removedKeys = rovingList(editor.removedList, ".chip-restore");

  editor.filter.addEventListener("input", () => applyFilter(editor));
  editor.add.addEventListener("input", () => setError(editor.error, "", editor.add));
  editor.add.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      addTyped(editor);
    }
  });
  editor.addButton.addEventListener("click", () => addTyped(editor));
  // One listener per list, not one per chip.
  editor.listNode.addEventListener("click", (event) => {
    const button = event.target.closest(".chip-remove");
    if (button) removeChip(editor, button.closest(".chip"));
  });
  editor.removedList.addEventListener("click", (event) => {
    const button = event.target.closest(".chip-restore");
    if (button) putBack(editor, button.closest(".chip"));
  });
  editor.reset.addEventListener("click", () => {
    editor.confirm.show(resetConfirmText(list, editor.entries, editor.defaults));
  });
  return editor;
}

function entryChip(editor, entry) {
  const node = el("li", "chip");
  node.dataset.entry = entry;
  node.append(el("span", "chip-text", entry));
  if (!editor.defaultKeys.has(entryKey(entry))) node.append(el("span", "chip-badge", "added"));
  const remove = el("button", "chip-remove");
  remove.type = "button";
  remove.tabIndex = -1;
  remove.title = "Remove";
  remove.setAttribute("aria-label", `Remove ${entry}`);
  node.append(remove);
  const row = { node, text: filterText(entry) };
  editor.rows.set(entryKey(entry), row);
  return row;
}

function removedChip(editor, entry) {
  const node = el("li", "chip");
  node.dataset.entry = entry;
  node.append(el("span", "chip-text", entry));
  const restore = el("button", "chip-restore", "Put back");
  restore.type = "button";
  restore.tabIndex = -1;
  restore.setAttribute("aria-label", `Put back ${entry}`);
  node.append(restore);
  editor.removedRows.set(entryKey(entry), node);
  return node;
}

function renderEditor(editor) {
  editor.rows = new Map();
  editor.removedRows = new Map();
  const chips = document.createDocumentFragment();
  for (const entry of displayOrder(editor.entries, editor.defaults)) chips.append(entryChip(editor, entry).node);
  editor.listNode.replaceChildren(chips);
  const removed = document.createDocumentFragment();
  for (const entry of listEdits(editor.entries, editor.defaults).removed) removed.append(removedChip(editor, entry));
  editor.removedList.replaceChildren(removed);
  applyFilter(editor);
}

// Draws the list again; if the keyboard was in it, it goes to the filter box.
function redraw(editor) {
  const active = document.activeElement;
  const inside = editor.listNode.contains(active) || editor.removedList.contains(active);
  renderEditor(editor);
  if (inside) editor.filter.focus();
}

// `query` is the filter box's text through filterText, worked out once for all the rows.
const rowMatches = (row, query) => query === "" || row.text.includes(query);

function applyFilter(editor) {
  const query = filterText(editor.filter.value);
  let shown = 0;
  for (const row of editor.rows.values()) {
    const match = rowMatches(row, query);
    if (row.node.hidden === match) row.node.hidden = !match;
    if (match) shown += 1;
  }
  editor.shown = shown;
  // While a filter is typed, a screen reader hears what it leaves ("3 of 268 sites match", or that none does) without
  // leaving the box. Written only when it changes, as setError does, so the same count isn't announced again.
  const status = query === "" ? "" : filterStatusText(editor.list, shown, editor.entries.length);
  if (editor.filterStatus.textContent !== status) editor.filterStatus.textContent = status;
  updateEditor(editor);
}

// A new chip at the top of the list, hidden if the filter leaves it out.
function prependChip(editor, entry) {
  const row = entryChip(editor, entry);
  row.node.hidden = !rowMatches(row, filterText(editor.filter.value));
  if (!row.node.hidden) editor.shown += 1;
  editor.listNode.prepend(row.node);
}

function updateEditor(editor) {
  const total = editor.entries.length;
  editor.count.textContent = countText(editor.list, editor.shown, total);
  // A filter hides chips with `hidden`, so the list isn't :empty: with none showing, its bordered box goes too.
  editor.listNode.hidden = editor.shown === 0;
  editor.empty.hidden = editor.shown > 0;
  editor.empty.textContent = editor.shown > 0 ? "" : emptyText(editor.list, total);
  const removed = editor.removedRows.size;
  editor.removed.hidden = removed === 0;
  editor.removedSummary.textContent = removedSummary(removed);
  // The list is the defaults minus the removed ones plus the added ones.
  const added = total - (editor.defaults.length - removed);
  const off = !state.loaded || editor.resetting;
  editor.filter.disabled = !state.loaded;
  editor.add.disabled = !state.loaded;
  editor.addButton.disabled = off;
  editor.reset.disabled = off || (added === 0 && removed === 0);
  editor.chipKeys.check();
  editor.removedKeys.check();
}

// The next chip's button that shows, else the previous one's: where the keyboard goes when a chip leaves.
function neighbourButton(node, selector) {
  for (const step of ["nextElementSibling", "previousElementSibling"]) {
    for (let sibling = node[step]; sibling; sibling = sibling[step]) {
      if (!sibling.hidden) return sibling.querySelector(selector);
    }
  }
  return null;
}

const editable = (editor) => state.loaded && !editor.resetting;

function addTyped(editor) {
  if (!editable(editor)) return;
  const result = addEntry(editor.list, editor.entries, editor.add.value, editor.defaults);
  if (result.error) {
    editor.status.textContent = "";
    setError(editor.error, result.error, editor.add);
    return;
  }
  editor.add.value = "";
  editor.entries = result.entries;
  const key = entryKey(result.entry);
  editor.removedRows.get(key)?.remove();
  editor.removedRows.delete(key);
  prependChip(editor, result.entry);
  updateEditor(editor);
  saveList(editor);
}

function removeChip(editor, node) {
  if (!editable(editor)) return;
  const entry = node.dataset.entry;
  const key = entryKey(entry);
  const next = neighbourButton(node, ".chip-remove") ?? editor.filter;
  editor.entries = removeEntry(editor.entries, entry);
  editor.rows.delete(key);
  if (!node.hidden) editor.shown -= 1;
  node.remove();
  if (editor.defaultKeys.has(key)) editor.removedList.prepend(removedChip(editor, entry));
  updateEditor(editor);
  if (next !== editor.filter) editor.chipKeys.set(next);
  next.focus();
  saveList(editor);
}

function putBack(editor, node) {
  if (!editable(editor)) return;
  const entry = node.dataset.entry;
  const key = entryKey(entry);
  if (editor.entries.length >= LISTS[editor.list].max) {
    setError(editor.error, fullText(editor.list));
    return;
  }
  const next = neighbourButton(node, ".chip-restore");
  node.remove();
  editor.removedRows.delete(key);
  editor.entries = [...editor.entries, entry];
  prependChip(editor, entry);
  updateEditor(editor);
  if (next) editor.removedKeys.set(next);
  (next ?? editor.filter).focus();
  saveList(editor);
}

function saveList(editor) {
  editor.seq += 1;
  editor.status.textContent = "";
  setError(editor.error, "", editor.add);
  if (editor.saving) {
    editor.again = true;
    return editor.saving;
  }
  editor.saving = runListSaves(editor).finally(() => {
    editor.saving = null;
  });
  return editor.saving;
}

async function runListSaves(editor) {
  let settings;
  let response;
  do {
    editor.again = false;
    response = await request({ type: "saveSettings", patch: { sensitive: { [editor.field]: [...editor.entries] } } });
    settings = savedSettings(response);
    if (settings) editor.saved = settings.sensitive[editor.field];
  } while (settings && editor.again);
  if (settings) {
    // Normally the page and the answer agree; if not (a change made elsewhere), the answer wins.
    if (!sameEntries(editor.saved, editor.entries)) {
      editor.entries = [...editor.saved];
      redraw(editor);
    }
    editor.status.textContent = SAVED;
  } else {
    // Nothing of these edits was saved: the list goes back to what is.
    editor.entries = [...editor.saved];
    redraw(editor);
    setError(editor.error, saveErrorText(editor.list, response));
  }
  updateEditor(editor);
}

async function resetList(editor) {
  if (!editable(editor)) return;
  editor.seq += 1;
  editor.resetting = true;
  editor.status.textContent = "";
  setError(editor.error, "", editor.add);
  updateEditor(editor);
  editor.filter.focus();
  // Edits made before the reset are saved first, so none of them lands after it.
  await editor.saving;
  const response = await request({ type: "resetSettings", fields: [resetField(editor.list)] });
  const settings = savedSettings(response);
  editor.resetting = false;
  if (settings) {
    editor.saved = settings.sensitive[editor.field];
    editor.entries = [...editor.saved];
    redraw(editor);
    editor.status.textContent = RESTORED;
  } else {
    setError(editor.error, RESET_FAILED);
  }
  updateEditor(editor);
}

const editors = Object.keys(LISTS).map(createEditor);

// ---- Loading ----

async function loadSettings() {
  const loaded = readSettings(await request({ type: "getSettings" }));
  if (!loaded) {
    settingsError.textContent = LOAD_FAILED;
    return;
  }
  state.settings = loaded.settings;
  state.defaults = loaded.defaults;
  state.loaded = true;
  for (const field of Object.keys(scalars)) showScalar(field);
  prefsInput.value = state.settings.preferences;
  for (const input of [modelSelect, effortSelect, precisionSelect, staleInput, prefsInput]) input.disabled = false;
  for (const editor of editors) {
    editor.defaults = state.defaults.sensitive[editor.field];
    editor.defaultKeys = new Set(editor.defaults.map(entryKey));
    editor.saved = state.settings.sensitive[editor.field];
    editor.entries = [...editor.saved];
    renderEditor(editor);
  }
  updatePreferences();
  updateResets();
}

// ---- Changes made elsewhere ----
//
// Another settings tab, or the dev build's self-test page, can save too. A list goes whole, so a tab still showing the
// old one would put it back over the other tab's change at its next edit, perhaps dropping a sensitive site added
// there. So when the stored settings change, the page reads them again. What it reads becomes each section's saved
// value, which a failed save goes back to. A field also shows it unless something was asked of the background for it
// after the read (that answer is newer) or the field no longer shows the old value (a half-typed number, unsaved
// instructions, which stay). Every change this page saves comes back here too, and then the read matches the page.
// A list whose saves or reset are still out isn't drawn from a read: the read can be older than an edit waiting to go
// (it went out between two saves), and drawing it would take that edit off the page, throw the keyboard out of the
// list, and build the next save without it. The save loop and the reset compare with their own last answer instead.
// Known limit: an edit made here while another tab's change is on its way still goes whole, over that change.

let refreshQueued = false;

async function refreshSettings() {
  // One read waits at a time: it is sent after every change made so far, so it sees them all.
  if (!state.loaded || refreshQueued) return;
  refreshQueued = true;
  // A request made from now on goes after this read, and its answer is newer: that section keeps it.
  const scalarSeqs = Object.fromEntries(Object.entries(scalars).map(([field, part]) => [field, part.seq]));
  const listSeqs = editors.map((editor) => editor.seq);
  const loaded = readSettings(await request({ type: "getSettings" }, () => {
    refreshQueued = false;
  }));
  // A failed read changes nothing: the page keeps what it last saved.
  if (!loaded) return;
  const { settings } = loaded;
  for (const [field, part] of Object.entries(scalars)) {
    const shown = part.seq === scalarSeqs[field] && part.input.value === String(state.settings[field]);
    state.settings[field] = settings[field];
    if (shown) showScalar(field);
  }
  // Instructions: a save or reset made after this read keeps Save and Revert off until its own answer, which is newer.
  if (prefsInput.value === state.settings.preferences) prefsInput.value = settings.preferences;
  state.settings.preferences = settings.preferences;
  editors.forEach((editor, i) => {
    editor.saved = settings.sensitive[editor.field];
    if (editor.saving || editor.resetting || editor.seq !== listSeqs[i]) return;
    if (sameEntries(editor.saved, editor.entries)) return;
    editor.entries = [...editor.saved];
    redraw(editor);
  });
  updatePreferences();
  updateResets();
}

// The key's status too, when another tab saves or removes the key. Only that it changed is read, never the value the
// event carries: getKeyStatus answers with the last four characters at most.
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.hasOwn(changes, "settings")) refreshSettings();
  if (area === "local" && Object.hasOwn(changes, "apiKey")) refreshStatus();
});

markPlatform();
setBusy(false);
refreshStatus();
loadSettings();
