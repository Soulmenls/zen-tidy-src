// One logger for the whole extension. Every argument is deep-copied through redact() first, so an
// API key can't reach the console even when a caller logs the wrong object.
// Callers should still log only status, error.type, request_id, latency and token counts.

export const REDACTED = "[redacted]";

const KEY_RE = /sk-ant-[A-Za-z0-9_-]+/g;
// Bearer tokens that don't look like Anthropic keys (OAuth, test tokens) are scrubbed too.
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_KEYS = new Set(["authorization", "x-api-key"]);
const MAX_DEPTH = 12;
const LEVELS = ["debug", "info", "warn", "error"];
// Stand-ins for values that throw when read (getters, revoked proxies), so one bad field never
// costs the rest of the copy, and one bad argument never costs the log line.
const UNREADABLE = "[unreadable]";
const UNLOGGABLE = "[unloggable]";

// Deep-copy any value, replacing keys in strings and the values of secret header names.
export function redact(value) {
  return copy(value, new Set(), 0);
}

function scrub(text) {
  return text.replace(KEY_RE, REDACTED).replace(BEARER_RE, `$1 ${REDACTED}`);
}

function copy(value, path, depth) {
  if (typeof value === "string") return scrub(value);
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return scrub(value.toString());
  if (value === null || typeof value !== "object") return value;
  // `path` holds only the current ancestors, so shared (non-circular) references are copied normally.
  if (path.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[too deep]";
  path.add(value);
  try {
    return copyObject(value, path, depth + 1);
  } catch {
    return UNREADABLE;
  } finally {
    path.delete(value);
  }
}

function copyObject(value, path, depth) {
  // Boxed primitives: Object.entries would spread a String object into one entry per character,
  // and no single character matches KEY_RE.
  if (value instanceof String) return scrub(String.prototype.valueOf.call(value));
  if (value instanceof Number) return Number.prototype.valueOf.call(value);
  if (value instanceof Boolean) return Boolean.prototype.valueOf.call(value);
  if (Array.isArray(value)) {
    return value.map((item) => (isSecretPair(item) ? [scrub(item[0]), REDACTED] : copy(item, path, depth)));
  }
  if (value instanceof Error) return copyError(value, path, depth);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof RegExp) return scrub(String(value));
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
  if (isHeaders(value) || value instanceof Map) return copyEntries(value.entries(), path, depth);
  if (value instanceof Set) return [...value].map((item) => copy(item, path, depth));
  return copyEntries(ownEntries(value), path, depth);
}

// Errors become plain objects: name, message, stack, own fields (kind, status, ...) and cause.
function copyError(error, path, depth) {
  const out = { name: scrub(toText(readField(error, "name"))), message: scrub(toText(readField(error, "message"))) };
  for (const [key, val] of ownEntries(error)) {
    if (!Object.hasOwn(out, key)) setField(out, scrub(key), isSecretName(key) ? REDACTED : copy(val, path, depth));
  }
  const cause = readField(error, "cause");
  if (cause !== undefined) out.cause = copy(cause, path, depth);
  const stack = readField(error, "stack");
  if (typeof stack === "string") out.stack = scrub(stack);
  return out;
}

function copyEntries(entries, path, depth) {
  const out = {};
  for (const [key, val] of entries) {
    const name = scrub(toText(key));
    setField(out, name, isSecretName(name) ? REDACTED : copy(val, path, depth));
  }
  return out;
}

// Like Object.entries, but a throwing getter costs only its own field.
function ownEntries(value) {
  return Object.keys(value).map((key) => [key, readField(value, key)]);
}

function readField(target, key) {
  try {
    return target[key];
  } catch {
    return UNREADABLE;
  }
}

// String(key) throws for a null-prototype object; Map keys can be anything.
function toText(value) {
  if (typeof value === "string") return value;
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    return Object.prototype.toString.call(value);
  }
  return String(value);
}

// defineProperty so a "__proto__" key from parsed JSON stays data instead of changing the prototype.
function setField(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isSecretName(name) {
  return SECRET_KEYS.has(String(name).toLowerCase());
}

// Header lists in array form: [["Authorization", "Bearer …"], …]
function isSecretPair(item) {
  return Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && isSecretName(item[0]);
}

function isHeaders(value) {
  return typeof Headers === "function" && value instanceof Headers;
}

function redactArg(value) {
  try {
    return redact(value);
  } catch {
    return UNLOGGABLE;
  }
}

// `enabled` may be a boolean or a function (so a settings toggle takes effect without a new logger).
// `sink` is console-like ({debug, info, warn, error, log}) or a function called as sink(level, ...args).
export function createLogger({ enabled = true, sink = globalThis.console } = {}) {
  const isOn = typeof enabled === "function" ? enabled : () => Boolean(enabled);
  const logger = {};
  for (const level of LEVELS) {
    logger[level] = (...args) => {
      // Logging must never break the caller: a log.error() often sits in the catch block that marks
      // the run failed. An enabled() that throws (settings not loaded yet) counts as off.
      try {
        if (!sink || !isOn()) return;
        const safe = args.map(redactArg);
        if (typeof sink === "function") sink(level, ...safe);
        else (sink[level] ?? sink.log)?.call(sink, ...safe);
      } catch {
        // Swallowed on purpose.
      }
    };
  }
  logger.log = logger.info;
  return Object.freeze(logger);
}
