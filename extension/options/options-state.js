// Zen Tidy settings: the options page's pure helpers (notes/m6-contracts.md, "Options page"). No DOM here, so
// test/unit/options-state.test.js covers them directly. The rules mirror store.js, which stays the single gate: the
// page checks the same things only to answer at once, next to the field.

// The models and efforts the page offers, in the order of options.html's <option>s.
export const MODELS = Object.freeze([
  Object.freeze({ id: "claude-sonnet-5-5", label: "Sonnet 5.5 (recommended)" }),
  Object.freeze({ id: "claude-haiku-5-5", label: "Haiku 5.5" }),
  Object.freeze({ id: "claude-opus-5-5", label: "Opus 5.5" }),
]);
export const EFFORTS = Object.freeze([
  Object.freeze({ id: "low", label: "Low (recommended)" }),
  Object.freeze({ id: "medium", label: "Medium" }),
  Object.freeze({ id: "high", label: "High" }),
]);
// The precision levels (check.js), as the select's option values: the setting itself is the number.
export const PRECISIONS = Object.freeze([
  Object.freeze({ id: "1", label: "1: Group the most tabs, no check" }),
  Object.freeze({ id: "2", label: "2: Split mixed groups of 10+ tabs" }),
  Object.freeze({ id: "3", label: "3: Split mixed groups of 5+ tabs" }),
  Object.freeze({ id: "4", label: "4: Also drop odd tabs from groups of 10+" }),
  Object.freeze({ id: "5", label: "5: One subject per group (recommended)" }),
]);

// SPEC F4: up to 500 characters, counted as a textarea counts them (UTF-16 code units), as store.js does.
export const MAX_PREFERENCES = 500;
// The page offers 1 to 365; 0 stays reachable only through the dev build's self-test page.
export const STALE_DAYS_MIN = 1;
export const STALE_DAYS_MAX = 365;

// The three list editors, by the prefix of their element ids (#domains-*, #keywords-*, #stems-*): the settings field
// each one edits, the most entries it may hold (defaults included, as store.js counts them), and its nouns.
export const LISTS = Object.freeze({
  domains: Object.freeze({ field: "domains", max: 2000, one: "site", many: "sites", title: "sites" }),
  keywords: Object.freeze({ field: "keywords", max: 2000, one: "word", many: "words", title: "words" }),
  stems: Object.freeze({ field: "hostStems", max: 200, one: "stem", many: "stems", title: "host stems" }),
});

// resetSettings' name for one list.
export const resetField = (list) => `sensitive.${LISTS[list].field}`;

// Fixed lines. The background's own message is never shown (m6-contracts, "Behaviour"), except Test key's (see "The API
// key's lines" below).
export const LOAD_FAILED = "Couldn't load your settings. Reload this page to try again.";
export const SAVE_FAILED = "Couldn't save the change. Try again.";
export const RESET_FAILED = "Couldn't reset to the defaults. Try again.";
export const SAVED = "Saved";
export const RESTORED = "Defaults restored";
export const KEY_IN_TEXT = "That looks like an Anthropic API key. Keys go in the API key field only.";
export const PREFERENCES_TOO_LONG = `Custom instructions can be at most ${MAX_PREFERENCES} characters.`;
export const STALE_DAYS_INVALID = `Enter a whole number of days from ${STALE_DAYS_MIN} to ${STALE_DAYS_MAX}.`;
export const DUPLICATE = "That's already on the list.";
export const DOMAIN_SHAPE = "Enter just the site, like example.com, without https://, a path or a port.";
export const DOMAIN_DOT = "Enter the whole site name, with a dot, like example.com.";
export const DOMAIN_INVALID = "That isn't a site name. Use letters, digits, hyphens and dots, like example.com.";
export const KEYWORD_SHORT = "Enter at least 2 characters.";
export const KEYWORD_LONG = "Keep it to 60 characters or fewer.";
export const KEYWORD_NO_WORD = "Include at least two letters or digits.";
export const STEM_INVALID = "A host stem is 4 to 30 letters or digits, with no spaces, dots or hyphens.";
const EMPTY_ENTRY = { domains: "Type a site first.", keywords: "Type a word or phrase first.", stems: "Type a stem first." };

// What the background's invalid-settings answer means for each field the page sends. Fixed: store.js's message
// isn't shown, and the page has already checked the same rules, so these only show if the two ever disagree.
const INVALID = {
  model: "Zen Tidy can't use that model. Choose one from the list.",
  effort: "Choose an effort from the list.",
  precision: "Choose a precision from the list.",
  preferences: `Couldn't save: keep the instructions to ${MAX_PREFERENCES} characters, with no API key in them.`,
  staleDays: STALE_DAYS_INVALID,
  domains: "Couldn't save the sites: one of them isn't a site name like example.com.",
  keywords: "Couldn't save the words: each needs 2 to 60 characters, with at least 2 letters or digits.",
  stems: "Couldn't save the host stems: each needs 4 to 30 letters or digits.",
};

const KEY_RE = /sk-ant-[A-Za-z0-9_-]+/;
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);
const STEM_RE = /^[a-z0-9]{4,30}$/;
// store.js asks a keyword for at least 2 letters or digits (KEYWORD_MIN_WORD_CHARS): "C#" or "-1" has only one.
const KEYWORD_MIN_WORD_CHARS = 2;
const wordChars = (text) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

export const holdsKey = (text) => typeof text === "string" && KEY_RE.test(text);

export const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// Reading the background's answers

const LIST_FIELDS = Object.values(LISTS).map((config) => config.field);

// A settings object as getSettings, saveSettings and resetSettings send it (and getSettings' defaults), keeping only
// what the page shows; null when a field is missing or of the wrong type.
export function readSettingsValue(value) {
  if (!isObject(value) || !isObject(value.sensitive)) return null;
  const { model, effort, preferences, staleDays, precision } = value;
  if (typeof model !== "string" || typeof effort !== "string" || typeof preferences !== "string") return null;
  if (!Number.isInteger(staleDays) || !Number.isInteger(precision)) return null;
  const sensitive = {};
  for (const field of LIST_FIELDS) {
    if (!isStringList(value.sensitive[field])) return null;
    sensitive[field] = [...value.sensitive[field]];
  }
  return { model, effort, preferences, staleDays, precision, sensitive };
}

// getSettings' { settings, defaults }, or null when the answer is an error or either part can't be read.
export function readSettings(response) {
  if (!isObject(response) || response.error) return null;
  const settings = readSettingsValue(response.settings);
  const defaults = readSettingsValue(response.defaults);
  return settings && defaults ? { settings, defaults } : null;
}

// The settings in a saveSettings or resetSettings answer ({ ok: true, settings }), or null for any other answer.
export function savedSettings(response) {
  return isObject(response) && response.ok === true ? readSettingsValue(response.settings) : null;
}

// The fixed line for a save the background refused or that never got an answer. `kind` is the field the page sent:
// "model", "effort", "precision", "preferences", "staleDays", or a list editor ("domains", "keywords", "stems").
export function saveErrorText(kind, response) {
  return isObject(response) && response.error === "invalid-settings" && INVALID[kind] ? INVALID[kind] : SAVE_FAILED;
}

// ---------------------------------------------------------------------------------------------
// Model, effort, precision, custom instructions and stale days

// The label of the extra option a select gets for a stored value it doesn't list (a newer model), or null.
export function otherChoice(choices, value) {
  return choices.some((choice) => choice.id === value) ? null : `Other: ${value}`;
}

export const counterText = (length) => `${length} / ${MAX_PREFERENCES}`;

// What is wrong with the custom instructions as typed, or "" when they can be saved.
export function preferencesProblem(text) {
  if (text.length > MAX_PREFERENCES) return PREFERENCES_TOO_LONG;
  return holdsKey(text) ? KEY_IN_TEXT : "";
}

// The stale-days field's whole number of days, or null when it isn't one from 1 to 365.
export function parseStaleDays(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return days >= STALE_DAYS_MIN && days <= STALE_DAYS_MAX ? days : null;
}

// ---------------------------------------------------------------------------------------------
// The list editors

// Entries compare trimmed and case-insensitively, as store.js and payload.js compare them; the spelling is kept.
export const entryKey = (entry) => entry.trim().toLowerCase();

// What the filter box matches against: lowercased, accents dropped, so "pret" finds "prêt".
export const filterText = (text) => text.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

// A site typed in its own script ("bücher.de") as the address bar's hostname has it, in punycode ("xn--bcher-kva.de"):
// payload.js compares sites with URL.hostname, and store.js takes only that form. Letters, digits, marks, dots and
// hyphens only, so a "%", "\" or space never reaches the URL parser, which would decode it or cut the host at it.
// null when it isn't a host name.
function asciiHost(host) {
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

// One typed entry, cleaned as the list stores it ({ entry }), or what is wrong with it ({ error }). Sites and stems
// are lowercased; words keep their spelling.
export function cleanEntry(list, raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { error: EMPTY_ENTRY[list] };
  // store.js looks for a key in the lowercased entry, since sites and stems are stored lowercased: "SK-ANT-…" too.
  if (holdsKey(text.toLowerCase())) return { error: KEY_IN_TEXT };
  if (list === "domains") {
    let host = text.toLowerCase();
    if (/:\/\/|[/:?#@]/.test(host)) return { error: DOMAIN_SHAPE };
    if (!host.includes(".")) return { error: DOMAIN_DOT };
    if (/[^\x00-\x7f]/.test(host)) {
      host = asciiHost(host);
      if (host === null) return { error: DOMAIN_INVALID };
      // Punycode keeps the ASCII letters in order, so "sk-antü.de" turns into a key-shaped "xn--sk-ant-…".
      if (holdsKey(host)) return { error: KEY_IN_TEXT };
    }
    return DOMAIN_RE.test(host) ? { entry: host } : { error: DOMAIN_INVALID };
  }
  if (list === "keywords") {
    if (text.length < 2) return { error: KEYWORD_SHORT };
    if (text.length > 60) return { error: KEYWORD_LONG };
    return wordChars(text) >= KEYWORD_MIN_WORD_CHARS ? { entry: text } : { error: KEYWORD_NO_WORD };
  }
  const stem = text.toLowerCase();
  return STEM_RE.test(stem) ? { entry: stem } : { error: STEM_INVALID };
}

export const fullText = (list) => `The list is full (${LISTS[list].max} ${LISTS[list].many}). Remove one first.`;

// Adds one typed entry: { entry, entries } with the new list, or { error }. A removed default typed again is simply
// back on the list, in its built-in spelling, whatever the rule for a new entry says: "gov" and "mil" have no dot, and
// store.js takes a built-in entry as it is.
export function addEntry(list, entries, raw, defaults = []) {
  const typed = typeof raw === "string" ? entryKey(raw) : "";
  const builtIn = typed ? defaults.find((item) => entryKey(item) === typed) : undefined;
  const cleaned = builtIn === undefined ? cleanEntry(list, raw) : { entry: builtIn };
  if (cleaned.error) return cleaned;
  const key = entryKey(cleaned.entry);
  if (entries.some((entry) => entryKey(entry) === key)) return { error: DUPLICATE };
  if (entries.length >= LISTS[list].max) return { error: fullText(list) };
  const entry = defaults.find((item) => entryKey(item) === key) ?? cleaned.entry;
  return { entry, entries: [...entries, entry] };
}

export function removeEntry(entries, entry) {
  const key = entryKey(entry);
  return entries.filter((item) => entryKey(item) !== key);
}

// The entries that aren't defaults, and the defaults the list leaves out.
export function listEdits(entries, defaults) {
  const defaultKeys = new Set(defaults.map(entryKey));
  const keys = new Set(entries.map(entryKey));
  return {
    added: entries.filter((entry) => !defaultKeys.has(entryKey(entry))),
    removed: defaults.filter((entry) => !keys.has(entryKey(entry))),
  };
}

// The order a list is drawn in: what the person added, newest first, so it shows without scrolling, then the
// defaults in their built-in order. Entries added or put back while the page is open go to the top too.
export function displayOrder(entries, defaults) {
  const defaultKeys = new Set(defaults.map(entryKey));
  const added = entries.filter((entry) => !defaultKeys.has(entryKey(entry))).reverse();
  return [...added, ...entries.filter((entry) => defaultKeys.has(entryKey(entry)))];
}

// True when both lists hold the same entries, in any order.
export function sameEntries(a, b) {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(entryKey));
  return b.every((entry) => keys.has(entryKey(entry)));
}

export function countText(list, shown, total) {
  const { one, many } = LISTS[list];
  return shown === total ? plural(total, one, many) : `${shown} of ${plural(total, one, many)}`;
}

export function emptyText(list, total) {
  return total === 0 ? `No ${LISTS[list].many} on the list.` : `No ${LISTS[list].many} match the filter.`;
}

// What a screen reader hears after a filter keystroke: how many entries match, or that none does.
export function filterStatusText(list, shown, total) {
  return shown === 0 ? emptyText(list, total) : `${countText(list, shown, total)} ${shown === 1 ? "matches" : "match"}`;
}

export const removedSummary = (count) => `Removed defaults (${count})`;

// The reset confirmation: what the reset takes away and what it puts back.
export function resetConfirmText(list, entries, defaults) {
  const { one, many, title } = LISTS[list];
  const { added, removed } = listEdits(entries, defaults);
  const parts = [];
  if (added.length) parts.push(`the ${plural(added.length, one, many)} you added will be removed`);
  if (removed.length) parts.push(`${plural(removed.length, "removed default", "removed defaults")} will come back`);
  const question = `Reset ${title} to the built-in list?`;
  if (!parts.length) return question;
  const what = parts.join(", and ");
  return `${question} ${what.charAt(0).toUpperCase()}${what.slice(1)}.`;
}

export const PREFERENCES_CONFIRM = "Reset custom instructions? Your saved instructions will be removed.";
// The same reset while the field holds text that isn't saved: that text goes too.
export const PREFERENCES_CONFIRM_UNSAVED =
  "Reset custom instructions? Your saved instructions and the changes you haven't saved will be removed.";

// ---------------------------------------------------------------------------------------------
// The API key's lines
//
// Save and Remove show fixed lines: the background has nothing to add there. Test key is the one place the page shows
// the background's own line, on purpose: SPEC F5 and implementation-notes ("Model call", "Errors") want Test key to say
// why a key fails (invalid or revoked, no workspace, spend limit). That line is run.js's describeError, which router.js
// answers with: a fixed sentence per error kind (ERROR_MESSAGES), a 400's own text added, the key scrubbed. The page
// still checks it: anything but a line of text with no key in it gets the fixed line instead.

export const KEY_FORMAT = "That doesn't look like an Anthropic API key. Copy it again from the Claude Console.";
export const KEY_EMPTY = "Paste a key first.";
export const KEY_SAVE_FAILED = "Couldn't save the key. Try again.";
export const KEY_CLEAR_FAILED = "Couldn't remove the key. Try again.";
// Enter in the key field while a Save, Test key or Remove key is still out.
export const KEY_WAIT = "Still working on the key. Save again in a moment.";
export const KEY_TEST_FAILED = "The key didn't work. Check it in the Claude Console.";

// The line for a Test key that failed.
export function testFailureText(response) {
  const message = isObject(response) && typeof response.message === "string" ? response.message.trim() : "";
  return message && !holdsKey(message) ? message : KEY_TEST_FAILED;
}
