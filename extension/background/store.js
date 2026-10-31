// Persistent state: settings, the API key, refused tab keys, the undo journal, the group-action journal and the
// collapsed tidy groups in storage.local; the live run, its heartbeat and the spent-journal mark in storage.session (in
// memory, survives an event-page restart).
// Every read-modify-write of a key runs on one promise chain per key: unserialized writes lost data
// in M0. Only the local and session areas are ever used, so the key can never reach Firefox Sync.

import { DEFAULT_MODEL, DEFAULT_EFFORT, DEFAULT_THINKING, MODEL_PROFILES } from "./payload.js";
import { DEFAULT_SENSITIVE } from "../shared/sensitive-defaults.js";
import { DEFAULT_PRECISION, PRECISION_LEVELS } from "./check.js";
import { REDACTED } from "./log.js";

export const DEFAULT_STALE_DAYS = 14;
export const MAX_REFUSED_KEYS = 500;
export const KEY_PREFIX = "sk-ant-";
// Real keys are about 100 characters; the bounds only catch a paste of the wrong thing.
const KEY_MIN_LENGTH = 20;
const KEY_MAX_LENGTH = 512;
// Header values must be visible ASCII (anthropic.js applies the same rule when sending).
const KEY_SHAPE_RE = /^[\x21-\x7e]+$/;

// The settings model (notes/m6-contracts.md, "Settings model"). store.js is the single gate; the options page checks
// the same rules for instant feedback. A save takes only a model payload.js knows how to call (MODEL_PROFILES: each
// turns thinking off its own way, and an unknown one may refuse the request's shape with a 400). A stored id the page
// doesn't list (a newer build's) is still read if it has this shape, and shows as "Other: <id>".
export const MODEL_RE = /^claude-[a-z0-9-]{3,60}$/;
const UNKNOWN_MODEL_MESSAGE = "That isn't a model Zen Tidy can use.";
// Thinking stays "disabled" (the benchmark picked it). Haiku 5.5 and Sonnet 5.5 turn it off only up to effort high,
// and Opus 5.5 can't turn it off at all (payload.js leaves the field out), so every effort a person can choose is
// valid with every model.
export const EFFORTS = Object.freeze(["low", "medium", "high"]);
const THINKING_MODES = ["adaptive", "disabled"];
// SPEC F4: custom instructions are up to 500 characters (UTF-16 code units, as a textarea's maxlength counts them).
export const MAX_PREFERENCES_LENGTH = 500;
export const MAX_STALE_DAYS = 365;
export const SENSITIVE_LISTS = Object.freeze(["domains", "keywords", "hostStems"]);
// The most entries each list may hold, defaults included (268 domains, 485 keywords and 9 stems today).
export const MAX_LIST_ENTRIES = Object.freeze({ domains: 2000, keywords: 2000, hostStems: 200 });
// A domain: hostname labels (letters, digits and inner hyphens, 63 at most) joined by dots, with at least one dot and
// 253 characters in all. No scheme, path, port, wildcard, or leading or trailing dot. An IDN goes in punycode.
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);
const KEYWORD_MIN_LENGTH = 2;
const KEYWORD_MAX_LENGTH = 60;
// payload.js folds everything but letters and digits into word breaks, so those are what a keyword matches with: it
// needs two, or "C#" would match as the one-letter word "c" ("Plan C") and "a!" as "a".
const KEYWORD_MIN_WORD_CHARS = 2;
const wordChars = (text) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
// payload.js compares stems with the host's hyphens removed, so a stem is letters and digits only.
const HOST_STEM_RE = /^[a-z0-9]{4,30}$/;
const KEY_IN_SETTING_MESSAGE = "That looks like an Anthropic API key. Keys go in the API key field only.";

// States in which some instance of the background is (or was) working on the run: a tidy, an apply or an undo.
export const ACTIVE_STATES = new Set(["running", "applying", "undoing"]);

// The Anthropic key shape (as in log.js). Runs and the journal hold page titles and group names, so only a real
// key is scrubbed from them: log.js's other rules (any "Bearer <word>") would also rewrite "Bearer bonds".
const KEY_RE = /sk-ant-[A-Za-z0-9_-]+/g;

// Settings hold only the person's own choices, never a copy of the defaults: a stored copy would freeze
// the defaults of the version that wrote it, so a model, effort or sensitive entry that a later version
// changes or adds would never reach anyone who had saved a setting. Reads merge the choices with the
// current defaults.
const SCALAR_FIELDS = ["model", "effort", "thinking", "preferences", "staleDays", "precision"];
// What resetSettings can put back: a scalar field, or one sensitive list.
const RESETTABLE_FIELDS = [...SCALAR_FIELDS, ...SENSITIVE_LISTS.map((list) => `sensitive.${list}`)];
// Builds up to the first M2 commit stored a full copy: every field and both lists whole, defaults
// included, and no "sensitiveEdits" field. A value in such a copy that equals these (those builds'
// defaults) was never chosen. Literal on purpose: they must not move with the current defaults.
const FULL_COPY_DEFAULTS = Object.freeze({
  model: "claude-haiku-5-5", effort: "low", thinking: "disabled", preferences: "", staleDays: 14,
});

const RUN_FIELDS = Object.freeze({
  id: null, state: "idle", windowId: null, startedAt: null, heartbeatAt: null,
  phase: null, preview: null, edits: null, report: null, error: null, stats: null,
});

// Errors callers turn into message responses; the message never holds the rejected value. `field` names the setting
// an "invalid-settings" error refuses ("model", ..., "sensitive.domains"), or is null.
export class StoreError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.field = field;
  }
}

export function defaultSettings(sensitiveDefaults = DEFAULT_SENSITIVE) {
  return {
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    thinking: DEFAULT_THINKING,
    preferences: "",
    sensitive: Object.fromEntries(SENSITIVE_LISTS.map((list) => [list, [...sensitiveDefaults[list]]])),
    staleDays: DEFAULT_STALE_DAYS,
    precision: DEFAULT_PRECISION,
  };
}

// A complete Run with every field present, so the popup never meets a missing one.
export function idleRun(fields = {}) {
  return { ...RUN_FIELDS, ...fields };
}

// A deep copy of plain data (what storage holds: objects, arrays, strings, numbers, booleans, null) with every
// key-shaped string replaced. Object.fromEntries keeps a "__proto__" key from a message as plain data.
export function redactKeys(value) {
  if (typeof value === "string") return value.replace(KEY_RE, REDACTED);
  if (Array.isArray(value)) return value.map(redactKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(KEY_RE, REDACTED), redactKeys(item)]));
  }
  return value;
}

// True when `value` holds a key-shaped string, which redactKeys would rewrite. A closed tab's URL is the one copy undo
// reopens it from, and the journals pass through redactKeys, so a page whose address holds one is never made
// reopenable: Extras never offer it (extras.js, preview.js, apply.js) and close all journals it by title only, as a
// tab Undo can't reopen (groups.js), rather than undo silently opening a different address.
export function holdsKey(value) {
  return typeof value === "string" && /sk-ant-[A-Za-z0-9_-]+/.test(value);
}

// Array.from reads a hole (a sparse array, which structured clone keeps) as undefined, which `every` alone would skip.
const isStringList = (value) => Array.isArray(value) && Array.from(value).every((item) => typeof item === "string");
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// A settings patch: an object literal (or one without a prototype), as a message delivers it, not a Map, a Date or an
// array carrying fields.
const isPatch = (value) => isPlainObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Firefox's group ids are safe integers (ext-browser.js: 16 digits, from the internal "<ms>-<n>" id), so each one
// round-trips through an object key exactly.
const isGroupId = (value) => Number.isSafeInteger(value) && value >= 0;
const GROUP_KEY_RE = /^(0|[1-9]\d*)$/;

// The valid entries of storage.local.collapsed, as a fresh object: a key that is a group id, holding true. Anything
// else (damaged storage) counts as no entry, so that group reads as expanded.
function collapsedEntries(value) {
  const entries = {};
  if (!isPlainObject(value)) return entries;
  for (const [key, item] of Object.entries(value)) {
    if (item === true && GROUP_KEY_RE.test(key) && isGroupId(Number(key))) entries[key] = true;
  }
  return entries;
}

// What a dead "applying" or "undoing" run really was, from the journal: an apply or undo whose work finished but whose
// run never got its last write (the event page died between the journal's final write and the run's, or
// storage.session refused the run's). An undo whose journal was marked undone after the run started is shown undone,
// with the journal's name-free copy of its report; an apply whose journal was started after the run and is done,
// applied, with the journal's. Without that copy, idle. null when the journal doesn't say so: the run was cut short.
function finishedRun(run, journal) {
  if (!isPlainObject(journal) || !Number.isFinite(run.startedAt)) return null;
  const since = (at) => Number.isFinite(at) && at >= run.startedAt;
  let outcome = null;
  if (run.state === "undoing" && since(journal.undoneAt)) outcome = { state: "undone", report: journal.undoReport };
  else if (run.state === "applying" && journal.state === "done" && since(journal.startedAt)) {
    outcome = { state: "applied", report: journal.report };
  }
  if (!outcome) return null;
  if (!isPlainObject(outcome.report)) return idleRun({ id: run.id, windowId: run.windowId });
  return { ...run, state: outcome.state, phase: null, preview: null, edits: null, error: null, report: outcome.report };
}

// One check per scalar field: null when the value is valid, else what is wrong with it (never the value itself).
// Unknown fields are dropped, so nothing else (a key, say) can ride along. Reads use the same checks, so a stored
// value no longer valid (an effort or a length a build before M6 allowed) falls back to its default.
// A key-shaped string is refused in the person's own text: it would show on the settings page (SPEC §3).
const SCALAR_CHECKS = {
  model: (value) => (typeof value === "string" && MODEL_RE.test(value) ? null : "That isn't a Claude model id."),
  effort: (value) => (EFFORTS.includes(value) ? null : "Effort must be low, medium or high."),
  thinking: (value) => (THINKING_MODES.includes(value) ? null : "Thinking must be adaptive or disabled."),
  preferences: (value) => {
    if (typeof value !== "string" || value.length > MAX_PREFERENCES_LENGTH) {
      return `Custom instructions can be up to ${MAX_PREFERENCES_LENGTH} characters.`;
    }
    return holdsKey(value) ? KEY_IN_SETTING_MESSAGE : null;
  },
  staleDays: (value) =>
    Number.isInteger(value) && value >= 0 && value <= MAX_STALE_DAYS
      ? null
      : `Stale days must be a whole number from 0 to ${MAX_STALE_DAYS}.`,
  precision: (value) =>
    PRECISION_LEVELS.includes(value) ? null : `Precision must be a whole number from 1 to ${PRECISION_LEVELS.length}.`,
};

// A save is held to more than a read: the model must be one of MODEL_PROFILES, not only a model id's shape.
const SAVE_CHECKS = {
  ...SCALAR_CHECKS,
  model: (value) => (typeof value === "string" && Object.hasOwn(MODEL_PROFILES, value) ? null : UNKNOWN_MODEL_MESSAGE),
};

// Each sensitive list's entry rule, applied to the trimmed entry and its comparison key (trimmed and lowercased:
// entries compare case-insensitively), and the messages for a list that breaks a rule.
const LIST_RULES = {
  domains: {
    valid: (_trimmed, key) => DOMAIN_RE.test(key),
    invalid: "Enter a site like example.com, without https://, a path or a port.",
    notList: "The domains must be a list of text.",
    tooMany: `Up to ${MAX_LIST_ENTRIES.domains} domains.`,
  },
  keywords: {
    valid: (trimmed) =>
      trimmed.length >= KEYWORD_MIN_LENGTH && trimmed.length <= KEYWORD_MAX_LENGTH &&
      wordChars(trimmed) >= KEYWORD_MIN_WORD_CHARS,
    invalid:
      `A keyword is ${KEYWORD_MIN_LENGTH} to ${KEYWORD_MAX_LENGTH} characters, with at least ` +
      `${KEYWORD_MIN_WORD_CHARS} letters or digits.`,
    notList: "The keywords must be a list of text.",
    tooMany: `Up to ${MAX_LIST_ENTRIES.keywords} keywords.`,
  },
  hostStems: {
    valid: (_trimmed, key) => HOST_STEM_RE.test(key),
    invalid: "A host stem is 4 to 30 letters or digits, with no spaces, dots or hyphens.",
    notList: "The host stems must be a list of text.",
    tooMany: `Up to ${MAX_LIST_ENTRIES.hostStems} host stems.`,
  },
};

// What is wrong with the shape of a patch's `sensitive`, as { field, message }, or null: an object holding at least
// one of the three lists (the patch holds only what changed; each list left out keeps its edits), each sent whole as
// a list of text within its size. The entries are sensitiveEntriesProblem's.
function sensitiveShapeProblem(value) {
  if (!isPlainObject(value) || !SENSITIVE_LISTS.some((list) => Object.hasOwn(value, list))) {
    return { field: "sensitive", message: "The sensitive lists must be sent as lists of text." };
  }
  for (const list of SENSITIVE_LISTS) {
    if (!Object.hasOwn(value, list)) continue;
    if (!isStringList(value[list])) return { field: `sensitive.${list}`, message: LIST_RULES[list].notList };
    if (value[list].length > MAX_LIST_ENTRIES[list]) {
      return { field: `sensitive.${list}`, message: LIST_RULES[list].tooMany };
    }
  }
  return null;
}

// What is wrong with the entries of the lists a patch sends ({ list: entries }, each whole as the person sees it), as
// { field, message }, or null. Only an entry the person is adding is held to its list's rule. A built-in entry is
// valid as it is ("gov" and "mil" have no dot, and putting a removed default back must work), and so is one the
// person's list already holds (`edits`: stored before a rule existed or was tightened), so a save never fails on an
// entry the person didn't just add. A key-shaped entry is refused unless it is built in, whatever its case (domains and
// stems are stored in lowercase, so "SK-ANT-..." would be stored key-shaped); a blank one is never held.
function sensitiveEntriesProblem(lists, sensitiveDefaults, edits) {
  for (const [list, entries] of Object.entries(lists)) {
    const defaultKeys = new Set(sensitiveDefaults[list].map(entryKey));
    const heldKeys = new Set(edits[list].added.map(entryKey).filter(Boolean));
    for (const entry of entries) {
      const key = entryKey(entry);
      if (defaultKeys.has(key)) continue;
      if (holdsKey(key)) return { field: `sensitive.${list}`, message: KEY_IN_SETTING_MESSAGE };
      if (!heldKeys.has(key) && !LIST_RULES[list].valid(entry.trim(), key)) {
        return { field: `sensitive.${list}`, message: LIST_RULES[list].invalid };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sensitive lists: stored as edits to the built-in lists (entries added, defaults removed)

// Entries compare trimmed and case-insensitively.
const entryKey = (entry) => entry.trim().toLowerCase();

// How each list keeps an entry: domains and host stems in lowercase, as hostnames are (and as payload.js compares
// them); a keyword trimmed, in the person's own spelling (payload.js folds its case when matching).
const SPELLINGS = { domains: entryKey, keywords: (entry) => entry.trim(), hostStems: entryKey };

const noEdits = () => Object.fromEntries(SENSITIVE_LISTS.map((list) => [list, { added: [], removed: [] }]));

const hasEdits = (edits) => SENSITIVE_LISTS.some((list) => edits[list].added.length || edits[list].removed.length);

// Each entry once (the first of those that compare equal), blanks dropped, spelled by `spell`.
function uniqueEntries(entries, spell) {
  const keys = new Set();
  const kept = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    kept.push(spell(entry));
  }
  return kept;
}

// What a whole list (`name`: "domains", ...) changes in the defaults: its entries that aren't defaults (each once,
// blanks dropped, in the list's spelling), and the defaults it leaves out.
function diffList(name, list, defaults) {
  const entries = uniqueEntries(list, SPELLINGS[name]);
  const defaultKeys = new Set(defaults.map(entryKey));
  const keys = new Set(entries.map(entryKey));
  return {
    added: entries.filter((entry) => !defaultKeys.has(entryKey(entry))),
    removed: defaults.filter((entry) => !keys.has(entryKey(entry))),
  };
}

// The current defaults minus the removed ones, then the additions that aren't defaults by now, in the list's
// spelling (`name`: "domains", ...). An entry both added and removed (only damaged storage holds one) stays: when in
// doubt, more tabs are private.
function applyEdits(name, defaults, { added, removed }) {
  const removedKeys = new Set(removed.map(entryKey));
  const list = defaults.filter((entry) => !removedKeys.has(entryKey(entry)));
  const keys = new Set(list.map(entryKey));
  for (const entry of added) {
    const key = entryKey(entry);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    list.push(SPELLINGS[name](entry));
  }
  return list;
}

// Stored edits, list by list, cleaned as a save writes them: each entry once, blanks dropped, an added one in the
// list's spelling and a removed one trimmed. So older data (a blank, an uppercase domain or stem, a duplicate) is
// read clean, and a save of another field never writes it back. A key-shaped added entry is kept: it only makes more
// tabs private, and the page never shows it (router.js scrubs it). A damaged list counts as unedited, so it falls
// back to the defaults.
function storedEdits(value) {
  const edits = noEdits();
  if (!value || typeof value !== "object") return edits;
  for (const list of SENSITIVE_LISTS) {
    const item = value[list];
    if (item && typeof item === "object" && isStringList(item.added) && isStringList(item.removed)) {
      edits[list] = {
        added: uniqueEntries(item.added, SPELLINGS[list]),
        removed: uniqueEntries(item.removed, (entry) => entry.trim()),
      };
    }
  }
  return edits;
}

// A full copy (see FULL_COPY_DEFAULTS): an entry equal to a default is a default, not the person's
// own. Those builds' lists are all inside today's (a default dropped later would read as the person's
// own here). A copy cannot tell a default the person removed from one added after it was saved, and no
// build could edit the lists then, so every default missing from the copy counts as added later and
// applies. When in doubt, more tabs are private.
function fullCopyEdits(copy, sensitiveDefaults) {
  const edits = noEdits();
  if (!copy || typeof copy !== "object") return edits;
  for (const list of SENSITIVE_LISTS) {
    if (isStringList(copy[list])) edits[list].added = diffList(list, copy[list], sensitiveDefaults[list]).added;
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------
// The person's own settings and the merged view

// The person's own choices in what storage holds: valid scalar fields, and the list edits. A damaged
// field counts as never chosen, so it falls back to its default instead of breaking every run.
function ownSettings(stored, sensitiveDefaults) {
  const fields = {};
  if (!stored || typeof stored !== "object") return { fields, edits: noEdits() };
  const fullCopy = !Object.hasOwn(stored, "sensitiveEdits") && Object.hasOwn(stored, "sensitive");
  for (const field of SCALAR_FIELDS) {
    if (!Object.hasOwn(stored, field) || SCALAR_CHECKS[field](stored[field]) !== null) continue;
    if (fullCopy && stored[field] === FULL_COPY_DEFAULTS[field]) continue;
    fields[field] = stored[field];
  }
  const edits = fullCopy ? fullCopyEdits(stored.sensitive, sensitiveDefaults) : storedEdits(stored.sensitiveEdits);
  return { fields, edits };
}

function mergeSettings(stored, sensitiveDefaults) {
  const settings = defaultSettings(sensitiveDefaults);
  const { fields, edits } = ownSettings(stored, sensitiveDefaults);
  Object.assign(settings, fields);
  for (const list of SENSITIVE_LISTS) settings.sensitive[list] = applyEdits(list, sensitiveDefaults[list], edits[list]);
  return settings;
}

// What storage keeps after a validated patch. A value equal to its default is dropped rather than
// stored, as Firefox does for prefs, so it follows the default if a later version changes it. A list in
// the patch replaces that list's edits; a list left out keeps them.
function nextStored(stored, accepted, sensitiveDefaults) {
  const { fields, edits } = ownSettings(stored, sensitiveDefaults);
  const defaults = defaultSettings(sensitiveDefaults);
  for (const field of SCALAR_FIELDS) {
    if (!Object.hasOwn(accepted, field)) continue;
    if (accepted[field] === defaults[field]) delete fields[field];
    else fields[field] = accepted[field];
  }
  if (accepted.sensitive) {
    for (const list of SENSITIVE_LISTS) {
      if (accepted.sensitive[list] !== undefined) edits[list] = diffList(list, accepted.sensitive[list], sensitiveDefaults[list]);
    }
  }
  return storedForm(fields, edits);
}

// What storage keeps after a reset: the named scalar fields dropped and the named lists' edits cleared, so each
// follows its default again. The rest stays as stored.
function resetStored(stored, names, sensitiveDefaults) {
  const { fields, edits } = ownSettings(stored, sensitiveDefaults);
  for (const name of names) {
    if (SCALAR_FIELDS.includes(name)) delete fields[name];
    else edits[name.slice("sensitive.".length)] = { added: [], removed: [] };
  }
  return storedForm(fields, edits);
}

const storedForm = (fields, edits) => (hasEdits(edits) ? { ...fields, sensitiveEdits: edits } : fields);

function cleanKey(key) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  const valid =
    trimmed.startsWith(KEY_PREFIX) &&
    KEY_SHAPE_RE.test(trimmed) &&
    trimmed.length >= KEY_MIN_LENGTH &&
    trimmed.length <= KEY_MAX_LENGTH;
  if (!valid) throw new StoreError("invalid-key-format", "That doesn't look like an Anthropic API key.");
  return trimmed;
}

// createStore(api, { now, sensitiveDefaults }): api is a `browser`-like object; only api.storage.local
// and api.storage.session are read. sensitiveDefaults stands in for a later version's built-in lists in
// tests.
export function createStore(api, { now = Date.now, sensitiveDefaults = DEFAULT_SENSITIVE } = {}) {
  const local = api.storage.local;
  const session = api.storage.session;
  const chains = new Map();

  // Runs task after every earlier task on the same name, whatever their outcome.
  function serialize(name, task) {
    const previous = chains.get(name) ?? Promise.resolve();
    const result = previous.then(task);
    chains.set(name, result.catch(() => {}));
    return result;
  }

  async function readValue(area, key) {
    const items = await area.get(key);
    return items?.[key];
  }

  const read = (name, area, key) => serialize(name, () => readValue(area, key));

  // fn(current) returns the value to write, or undefined to leave the key alone.
  function update(name, area, key, fn) {
    return serialize(name, async () => {
      const current = await readValue(area, key);
      const next = await fn(current === undefined ? undefined : structuredClone(current));
      if (next === undefined) return { changed: false, value: current };
      await area.set({ [key]: next });
      return { changed: true, value: next };
    });
  }

  // Runs hold page titles and model text; a key-shaped string among them is never stored.
  const cleanRun = (run) => redactKeys(idleRun(run));

  const store = {
    // Every field, with the sensitive lists merged: { domains, keywords, hostStems }.
    async getSettings() {
      return mergeSettings(await read("local:settings", local, "settings"), sensitiveDefaults);
    },

    // The built-in values of every field (this store's sensitive defaults), as a fresh copy.
    getDefaultSettings() {
      return defaultSettings(sensitiveDefaults);
    },

    // Validates every field of the patch before writing, so a bad patch changes nothing; rejects with StoreError
    // "invalid-settings" naming the first field refused (`field`). The sensitive lists come whole, any of them
    // left out keeping its edits; only their differences from the defaults are stored. Their entries are checked
    // against what storage holds as the patch is written (an entry already held is kept as it is).
    async saveSettings(patch) {
      if (!isPatch(patch)) throw new StoreError("invalid-settings", "Settings must be an object.");
      const accepted = {};
      for (const field of SCALAR_FIELDS) {
        if (!Object.hasOwn(patch, field)) continue;
        const message = SAVE_CHECKS[field](patch[field]);
        if (message) throw new StoreError("invalid-settings", message, field);
        accepted[field] = patch[field];
      }
      if (Object.hasOwn(patch, "sensitive")) {
        const problem = sensitiveShapeProblem(patch.sensitive);
        if (problem) throw new StoreError("invalid-settings", problem.message, problem.field);
        const lists = SENSITIVE_LISTS.filter((list) => Object.hasOwn(patch.sensitive, list));
        accepted.sensitive = Object.fromEntries(lists.map((list) => [list, [...patch.sensitive[list]]]));
      }
      const next = (stored) => {
        const { edits } = ownSettings(stored, sensitiveDefaults);
        const problem = accepted.sensitive && sensitiveEntriesProblem(accepted.sensitive, sensitiveDefaults, edits);
        if (problem) throw new StoreError("invalid-settings", problem.message, problem.field);
        return nextStored(stored, accepted, sensitiveDefaults);
      };
      const { value } = await update("local:settings", local, "settings", next);
      return mergeSettings(value, sensitiveDefaults);
    },

    // Puts each named field back to its default: a scalar field, or one list ("sensitive.domains",
    // "sensitive.keywords", "sensitive.hostStems"). Every name is checked first, so an unknown one changes nothing
    // (StoreError "invalid-settings"). Resolves to the merged settings, as saveSettings does.
    async resetSettings(names) {
      if (!Array.isArray(names) || !names.length || !names.every((name) => RESETTABLE_FIELDS.includes(name))) {
        throw new StoreError("invalid-settings", "Name the settings to reset.");
      }
      const next = (stored) => resetStored(stored, names, sensitiveDefaults);
      const { value } = await update("local:settings", local, "settings", next);
      return mergeSettings(value, sensitiveDefaults);
    },

    async getKeyStatus() {
      const key = await read("local:apiKey", local, "apiKey");
      const saved = typeof key === "string" && key !== "";
      return { saved, last4: saved ? key.slice(-4) : null };
    },

    // Rejects with StoreError code "invalid-key-format".
    async saveKey(key) {
      const clean = cleanKey(key);
      await serialize("local:apiKey", () => local.set({ apiKey: clean }));
      return { saved: true, last4: clean.slice(-4) };
    },

    async clearKey() {
      await serialize("local:apiKey", () => local.remove("apiKey"));
    },

    // Background only: nothing that answers a message may return this value.
    async readKey() {
      const key = await read("local:apiKey", local, "apiKey");
      return typeof key === "string" && key !== "" ? key : null;
    },

    async getRun() {
      const run = await read("session:run", session, "run");
      return run ? idleRun(run) : null;
    },

    // Merges the patch into the current run (or a fresh idle one) and returns the stored result.
    async setRun(patch) {
      const { value } = await update("session:run", session, "run", (run) => cleanRun({ ...run, ...patch }));
      return idleRun(value);
    },

    // Atomic compare-and-set: fn(run | null) returns the complete new run, or undefined (or null)
    // for no change. Resolves to { changed, run }.
    async updateRun(fn) {
      const { changed, value } = await update("session:run", session, "run", async (run) => {
        const next = await fn(run ? idleRun(run) : null);
        return next === undefined || next === null ? undefined : cleanRun(next);
      });
      return { changed, run: value ? idleRun(value) : null };
    },

    async clearRun() {
      await serialize("session:run", () => session.remove("run"));
    },

    // Turns a "running", "applying" or "undoing" run into an "error" run carrying `error`. With staleMs,
    // only when its last sign of life (the later of run.heartbeatAt and a heartbeat for the same run id)
    // is more than staleMs old. A half-applied preview no longer matches the tabs, so it goes too. The
    // journal is left alone: an apply or undo cut short is still offered for undo.
    // undoError, when given, is what an "undoing" run carries instead: an undo cut short is retried as an undo
    // (the popup's Retry goes by the error's kind), never as a new tidy.
    // An apply or undo the journal shows as finished since the run started was not cut short, only its last run
    // write was lost: it becomes "applied" or "undone" instead (finishedRun). An unreadable journal counts as not.
    async interruptRun(error, { staleMs, undoError } = {}) {
      const heartbeat = staleMs === undefined ? null : await store.getHeartbeat();
      return store.updateRun(async (run) => {
        if (!run || !ACTIVE_STATES.has(run.state)) return undefined;
        if (staleMs !== undefined) {
          const beat = heartbeat?.runId === run.id && Number.isFinite(heartbeat.at) ? heartbeat.at : 0;
          const lastSign = Math.max(Number.isFinite(run.heartbeatAt) ? run.heartbeatAt : 0, beat);
          if (now() - lastSign <= staleMs) return undefined;
        }
        if (run.state !== "running") {
          const journal = await store.readJournal().catch(() => null);
          const finished = finishedRun(run, journal);
          if (finished) return finished;
        }
        const reason = run.state === "undoing" && undoError ? undoError : error;
        return { ...run, state: "error", phase: null, preview: null, edits: null, error: reason };
      });
    },

    // Written by the keepalive straight through storage.session; read here for the stale check.
    async getHeartbeat() {
      const heartbeat = await readValue(session, "heartbeat");
      return heartbeat && typeof heartbeat === "object" ? heartbeat : null;
    },

    async getRefusedKeys() {
      const keys = await read("local:refusedKeys", local, "refusedKeys");
      return isStringList(keys) ? keys : [];
    },

    // Oldest first; a key refused again moves to the end, and only the newest 500 are kept.
    async addRefusedKeys(keys) {
      const fresh = [...new Set((Array.isArray(keys) ? keys : []).filter((key) => typeof key === "string" && key))];
      if (!fresh.length) return store.getRefusedKeys();
      const { value } = await update("local:refusedKeys", local, "refusedKeys", (stored) => {
        const freshSet = new Set(fresh);
        const kept = (isStringList(stored) ? stored : []).filter((key) => !freshSet.has(key));
        return [...kept, ...fresh].slice(-MAX_REFUSED_KEYS);
      });
      return value;
    },

    // The journal holds old group titles for undo (tabs' addresses only as fingerprints; from M4, closed tabs'
    // http(s) URLs, for undo to reopen them); a key-shaped string is scrubbed even from those, and nothing else is
    // changed (undo puts the titles back as they were).
    async writeJournal(journal) {
      const clean = redactKeys(journal);
      await serialize("local:journal", () => local.set({ journal: clean }));
      return clean;
    },

    async readJournal() {
      return (await read("local:journal", local, "journal")) ?? null;
    },

    // No journal at all: nothing to undo. Used when no other write can say so (see markJournalSpent).
    async removeJournal() {
      await serialize("local:journal", () => local.remove("journal"));
    },

    // A journal undo finished with but could not mark "undone" (both of its final writes failed), by its startedAt
    // (null for a journal without one). Kept in storage.session, which is in memory and so works when
    // storage.local doesn't; the router stops offering that journal. A new apply's journal has another startedAt.
    async markJournalSpent(startedAt) {
      const value = { startedAt: Number.isFinite(startedAt) ? startedAt : null };
      await serialize("session:spentJournal", () => session.set({ spentJournal: value }));
    },

    // { startedAt } of the journal markJournalSpent named, or null.
    async getSpentJournal() {
      const spent = await read("session:spentJournal", session, "spentJournal");
      return isPlainObject(spent) && (spent.startedAt === null || Number.isFinite(spent.startedAt))
        ? { startedAt: spent.startedAt }
        : null;
    },

    // The group actions' one-step undo (notes/m4-contracts.md, "Group-action journal"). A key of its own, on a chain
    // of its own, so a group action never replaces the tidy journal and a tidy apply or undo never replaces this one.
    // Like the journal it holds full group titles, and a close-all's closed tabs' http(s) URLs, so undo can bring them
    // back exactly: only a key-shaped string is scrubbed.
    async writeGroupJournal(journal) {
      const clean = redactKeys(journal);
      await serialize("local:groupJournal", () => local.set({ groupJournal: clean }));
      return clean;
    },

    async readGroupJournal() {
      return (await read("local:groupJournal", local, "groupJournal")) ?? null;
    },

    async removeGroupJournal() {
      await serialize("local:groupJournal", () => local.remove("groupJournal"));
    },

    // Collapsed tidy groups (notes/m5-contracts.md, section 3; collapse.js keeps them): storage.local.collapsed =
    // { [groupId]: true }. By group id alone, since ids survive a restart and window ids don't. An expanded group has
    // no entry. Every write goes through the "local:collapsed" chain, so events recorded together all land.
    // Resolves to the collapsed groups' ids, smallest first.
    async getCollapsedGroups() {
      const entries = collapsedEntries(await read("local:collapsed", local, "collapsed"));
      return Object.keys(entries).map(Number).sort((a, b) => a - b);
    },

    // Records whether one group is collapsed (only `true` counts as collapsed). Resolves to true when storage changed;
    // an id that isn't a group id changes nothing.
    async setGroupCollapsed(groupId, collapsed) {
      if (!isGroupId(groupId)) return false;
      const want = collapsed === true;
      const { changed } = await update("local:collapsed", local, "collapsed", (stored) => {
        const entries = collapsedEntries(stored);
        if (Object.hasOwn(entries, groupId) === want) return undefined;
        if (want) entries[groupId] = true;
        else delete entries[groupId];
        return entries;
      });
      return changed;
    },

    // Drops the entries of groups that are gone. Resolves to true when storage changed.
    async forgetCollapsedGroups(groupIds) {
      const ids = (Array.isArray(groupIds) ? groupIds : []).filter(isGroupId);
      if (!ids.length) return false;
      const { changed } = await update("local:collapsed", local, "collapsed", (stored) => {
        const entries = collapsedEntries(stored);
        const present = ids.filter((id) => Object.hasOwn(entries, id));
        if (!present.length) return undefined;
        for (const id of present) delete entries[id];
        return entries;
      });
      return changed;
    },
  };
  return store;
}
