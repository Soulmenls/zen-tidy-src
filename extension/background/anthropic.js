// Anthropic API client. fetch, timers and the keepalive are injected, so the same code runs in the
// event page and under node --test with fakes. Nothing here reads storage or the key itself.

import { redact, REDACTED } from "./log.js";

export const API_BASE = "https://api.anthropic.com";
export const API_VERSION = "2026-10-21";
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const MAX_TOKENS_CAP = 64000;

const MESSAGES_TIMEOUT_MS = 90000;
// The keepalive holds the event page open, so the one max_tokens retry may wait this long.
const MAX_RETRY_TIMEOUT_MS = 240000;
const TEST_KEY_TIMEOUT_MS = 15000;
const KEEPALIVE_MS = 10000;
const DEFAULT_MAX_TOKENS = 16000;

export const ERROR_KINDS = Object.freeze([
  "auth", "workspace-scope", "spend-limit", "billing", "permission", "model-unavailable", "too-large",
  "rate-limit", "overloaded", "server", "timeout", "network", "bad-response", "truncated", "invalid-request",
]);

// `retryable` means requestPlan retries it by itself. Timeouts and network errors are left to the user.
const RETRYABLE_KINDS = new Set(["rate-limit", "overloaded", "server"]);

const STATUS_KINDS = new Map([
  [401, "auth"], [402, "billing"], [403, "permission"], [404, "model-unavailable"], [413, "too-large"],
  [429, "rate-limit"], [500, "server"], [529, "overloaded"],
]);

// Fallback for statuses outside the table (e.g. a proxy's 503 that still carries an Anthropic body).
const TYPE_KINDS = new Map([
  ["authentication_error", "auth"], ["billing_error", "billing"], ["permission_error", "permission"],
  ["not_found_error", "model-unavailable"], ["request_too_large", "too-large"],
  ["rate_limit_error", "rate-limit"], ["api_error", "server"], ["overloaded_error", "overloaded"],
]);

const WORKSPACE_SCOPE_RE = /not scoped to a workspace/i;
const SPEND_LIMIT_RE = /spend(?:ing)? limit|usage limit/i;
// "Your credit balance is too low" means the org has no prepaid credit, not a workspace limit.
// Pointing the user at the workspace limit would not help, so it gets 402's kind.
const CREDIT_BALANCE_RE = /credit balance/i;
// RFC 9110 retry-after: delay-seconds, or an HTTP-date. Date.parse alone is too lenient ("-5" parses
// as a date in 2001), so only text shaped like an IMF-fixdate reaches it.
const DELAY_SECONDS_RE = /^\d+(?:\.\d+)?$/;
const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
// Header values must be visible ASCII; anything else makes fetch throw a TypeError that would look
// like "offline".
const KEY_SHAPE_RE = /^[\x21-\x7e]+$/;
// The only places the key may go: Anthropic, or the dev build's mock server on loopback (an origin
// with a port and nothing after it, so no path, user info or other host can be smuggled in).
const LOOPBACK_BASE_RE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export class TidyApiError extends Error {
  // new TidyApiError(kind, message, details) or new TidyApiError(kind, { message, ...details }).
  constructor(kind, message, details = {}) {
    if (message && typeof message === "object") {
      details = message;
      message = details.message;
    }
    super(redact(String(message || kind)), details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "TidyApiError";
    this.kind = kind;
    this.status = details.status ?? null;
    this.type = details.type ?? null;
    this.requestId = details.requestId ?? null;
    this.retryable = details.retryable ?? RETRYABLE_KINDS.has(kind);
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

// retry-after is whole seconds per Anthropic's docs (a fraction is tolerated), or an HTTP-date.
// Anything else returns null, so requestPlan falls back to its backoff.
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (DELAY_SECONDS_RE.test(text)) return Math.round(Number(text) * 1000);
  if (!IMF_FIXDATE_RE.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export function errorKind(status, type, message = "") {
  if (status === 400) {
    if (WORKSPACE_SCOPE_RE.test(message)) return "workspace-scope";
    if (SPEND_LIMIT_RE.test(message)) return "spend-limit";
    if (CREDIT_BALANCE_RE.test(message)) return "billing";
    return "invalid-request";
  }
  if (STATUS_KINDS.has(status)) return STATUS_KINDS.get(status);
  if (TYPE_KINDS.has(type)) return TYPE_KINDS.get(type);
  return status >= 500 ? "server" : "invalid-request";
}

function errorFromResponse(status, data, headers, requestId, nowMs) {
  const apiError = data && typeof data === "object" && data.error && typeof data.error === "object" ? data.error : {};
  const type = typeof apiError.type === "string" ? apiError.type : null;
  const message = typeof apiError.message === "string" ? apiError.message : "";
  return new TidyApiError(errorKind(status, type, message), message || `HTTP ${status}`, {
    status,
    type,
    requestId,
    retryAfterMs: parseRetryAfter(readHeader(headers, "retry-after"), nowMs),
  });
}

function hasErrorStatus(response) {
  return response?.ok === false && Number.isInteger(response.status) && response.status >= 400;
}

function readHeader(headers, name) {
  return typeof headers?.get === "function" ? headers.get(name) : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Replaces the exact key wherever it appears. A fetch implementation may quote header values in its
// errors, and a key in a new format would slip past log.js's sk-ant- pattern.
function hideKey(text, key) {
  return key ? text.split(key).join(REDACTED) : text;
}

// A scrubbed stand-in for a transport error: name and message only. The original object is never
// kept, because its message and stack hold whatever the fetch implementation wrote.
function plainCause(err, key) {
  let name = "Error";
  let message = "unknown error";
  try {
    if (typeof err?.name === "string") name = err.name;
    message = String(err?.message ?? err);
  } catch {
    // An exotic thrown value; the defaults will do.
  }
  return { name: redact(hideKey(name, key)), message: redact(hideKey(message, key)) };
}

// A refused apiBase is a TidyApiError ("invalid-request", never retried), so callers report it
// like any other failed request. The value itself is left out of the message.
function checkApiBase(apiBase) {
  if (apiBase === API_BASE) return apiBase;
  const loopback = typeof apiBase === "string" ? LOOPBACK_BASE_RE.exec(apiBase) : null;
  if (loopback && Number(loopback[1]) <= 65535) return apiBase;
  throw new TidyApiError("invalid-request", "The API address is not allowed.", { retryable: false });
}

function checkKey(apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) throw new TidyApiError("auth", "No API key is set.");
  if (!KEY_SHAPE_RE.test(key)) throw new TidyApiError("auth", "The API key contains invalid characters.");
  return key;
}

const defaultSetTimer = (fn, ms) => setTimeout(fn, ms);
const defaultClearTimer = (id) => clearTimeout(id);

// A pending fetch doesn't reset Firefox's 30 s idle timer (M0), so a parent API call (the injected
// keepalive, e.g. storage.session.set) runs now and then every intervalMs until stopped.
function startKeepalive(keepalive, intervalMs, setTimer, clearTimer) {
  if (typeof keepalive !== "function") return () => {};
  let stopped = false;
  let timer = null;
  const beat = () => {
    if (stopped) return;
    try {
      Promise.resolve(keepalive()).catch(() => {});
    } catch {
      // A failed beat must not fail the request.
    }
    // A no-op for a fired setTimeout. If a setInterval is passed by mistake, this keeps one interval
    // alive instead of adding another on every beat.
    if (timer !== null) clearTimer(timer);
    timer = setTimer(beat, intervalMs);
  };
  beat();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}

async function apiRequest(path, options) {
  const {
    method = "GET", body, apiKey, fetchImpl, timeoutMs, keepalive, keepaliveMs = KEEPALIVE_MS,
    setTimer = defaultSetTimer, clearTimer = defaultClearTimer, now = Date.now, apiBase = API_BASE,
  } = options;
  // Explicit injection: a forgotten fetchImpl must fail loudly, never fall back to the real network.
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const base = checkApiBase(apiBase);
  const key = checkKey(apiKey);

  const headers = {
    Authorization: `Bearer ${key}`,
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const init = { method, headers, credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal };
  if (body !== undefined) init.body = JSON.stringify(body);

  // The race makes the timeout hold even if a fetch implementation ignores the signal.
  let timedOut = false;
  let timer = null;
  const timeoutError = () => new TidyApiError("timeout", `No response within ${Math.round(timeoutMs / 1000)} s.`);
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => {
      timedOut = true;
      reject(timeoutError()); // before abort(), so the race settles on the timeout, not the AbortError
      controller.abort();
    }, timeoutMs);
  });
  timeout.catch(() => {});

  const stopKeepalive = startKeepalive(keepalive, keepaliveMs, setTimer, clearTimer);
  const started = now();
  const transportError = (err) => {
    if (timedOut) return timeoutError();
    if (err instanceof TidyApiError) return err;
    // Offline, DNS, refused redirect and CSP blocks all surface as a TypeError.
    const cause = plainCause(err, key);
    return new TidyApiError("network", `Network error: ${cause.message}`, { cause });
  };
  try {
    let response;
    let text;
    try {
      // Called unbound on purpose: window.fetch throws "Illegal invocation" when `this` is another object.
      response = await Promise.race([fetchImpl(base + path, init), timeout]);
    } catch (err) {
      throw transportError(err);
    }
    try {
      text = await Promise.race([response.text(), timeout]);
    } catch (err) {
      // The status has already arrived. A 529 whose body is cut off is still a 529, and is retried as one.
      if (timedOut || !hasErrorStatus(response)) throw transportError(err);
    }
    const latencyMs = now() - started;
    const data = parseJson(text);
    const bodyRequestId = data && typeof data.request_id === "string" ? data.request_id : null;
    const requestId = bodyRequestId || readHeader(response.headers, "request-id") || null;
    if (!response.ok) throw errorFromResponse(response.status, data, response.headers, requestId, now());
    if (data === undefined) {
      throw new TidyApiError("bad-response", "The API response is not valid JSON.", { status: response.status, requestId });
    }
    return { data, requestId, latencyMs };
  } finally {
    if (timer !== null) clearTimer(timer);
    stopKeepalive();
  }
}

// POST /v1/messages once. Returns { message, requestId, latencyMs } or throws a TidyApiError.
// opts: { apiKey, fetchImpl (required, called unbound), apiBase = API_BASE, timeoutMs = 90000, keepalive,
// keepaliveMs = 10000, setTimer, clearTimer, now }. setTimer and clearTimer work like setTimeout and
// clearTimeout: one-shot, (fn, ms) => id. The keepalive re-arms itself. They default to the global
// setTimeout and clearTimeout. apiBase must be exactly API_BASE or a loopback http origin with a port (the dev
// build's mock server, LOOPBACK_BASE_RE); anything else throws an "invalid-request" TidyApiError before any fetch.
export async function callMessages(body, opts = {}) {
  const { timeoutMs = MESSAGES_TIMEOUT_MS, ...rest } = opts;
  const { data, requestId, latencyMs } = await apiRequest("/v1/messages", { ...rest, timeoutMs, method: "POST", body });
  return { message: data, requestId, latencyMs };
}

// Thinking blocks come first; only text blocks carry the structured output.
function parseOutput(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const [field, value] of Object.entries(usage)) {
    if (typeof value === "number") total[field] = (total[field] ?? 0) + value;
  }
}

// Sleep between retries with the keepalive running, since retry-after can exceed the idle timeout.
// The timer is cleared afterwards: a no-op for setTimeout, and it stops a stray setInterval.
function wait(ms, { keepalive, keepaliveMs = KEEPALIVE_MS, setTimer = defaultSetTimer, clearTimer = defaultClearTimer }) {
  const stop = startKeepalive(keepalive, keepaliveMs, setTimer, clearTimer);
  let timer = null;
  return new Promise((resolve) => {
    timer = setTimer(resolve, ms);
  }).finally(() => {
    clearTimer(timer);
    stop();
  });
}

// One tidy request with the retry policy around it. Resolves to { refusal: true, category, ... } or
// { output, usage, requestId, ... }; `calls` and `totalUsage` cover every attempt (for the bench's
// cost cap). Thrown TidyApiErrors carry the same two fields.
// opts: everything callMessages takes (apiBase included), with the same setTimeout-style setTimer
// and clearTimer. Every attempt gets timeoutMs, except the max_tokens retry, which doubles it along
// with the output cap (a longer answer takes longer). Plus maxRetries = 2, retryBaseMs = 1000,
// maxRetryWaitMs = 60000, and totalTimeoutMs (none by default): a time box for the whole call, timed
// with opts.now. Each attempt's timeout is then cut to what is left of the box, so the doubled one
// can't overrun it; a retry wait that would end past it is not started, and the call fails with the
// error it has; with nothing left, it fails with a "timeout" before sending.
export async function requestPlan(body, opts = {}) {
  const { maxRetries = 2, retryBaseMs = 1000, maxRetryWaitMs = 60000, totalTimeoutMs, ...rest } = opts;
  const callOpts = { ...rest, timeoutMs: rest.timeoutMs ?? MESSAGES_TIMEOUT_MS };
  const clock = typeof rest.now === "function" ? rest.now : Date.now;
  const deadline = Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0 ? clock() + totalTimeoutMs : null;
  const totalUsage = {};
  let calls = 0;
  let current = body;
  let transientRetries = 0;
  let raisedCap = false;
  let parseRetried = false;
  const fail = (err) => {
    if (err instanceof TidyApiError) Object.assign(err, { calls, totalUsage });
    return err;
  };
  // The next attempt's options: callOpts, with the timeout cut to what is left of the box.
  const attemptOpts = () => {
    if (deadline === null) return callOpts;
    const left = deadline - clock();
    if (left <= 0) throw fail(new TidyApiError("timeout", `No response within ${Math.round(totalTimeoutMs / 1000)} s.`));
    return { ...callOpts, timeoutMs: Math.min(callOpts.timeoutMs, left) };
  };

  for (;;) {
    const attempt = attemptOpts();
    let result;
    calls += 1;
    try {
      result = await callMessages(current, attempt);
    } catch (err) {
      if (!(err instanceof TidyApiError) || !err.retryable || transientRetries >= maxRetries) throw fail(err);
      const delayMs = err.retryAfterMs ?? retryBaseMs * 2 ** transientRetries;
      // A long retry-after is reported (with retryAfterMs) instead of holding the popup for minutes.
      if (delayMs > maxRetryWaitMs) throw fail(err);
      if (deadline !== null && clock() + delayMs >= deadline) throw fail(err);
      transientRetries += 1;
      await wait(delayMs, callOpts);
      continue;
    }

    const { message, requestId, latencyMs } = result;
    addUsage(totalUsage, message?.usage);
    const meta = { usage: message?.usage ?? null, requestId, latencyMs, calls, totalUsage };

    if (message?.stop_reason === "refusal") {
      return { refusal: true, category: message.stop_details?.category ?? null, ...meta };
    }

    if (message?.stop_reason === "max_tokens") {
      const cap = Number(current.max_tokens) || DEFAULT_MAX_TOKENS;
      const raised = Math.min(cap * 2, MAX_TOKENS_CAP);
      if (raisedCap || raised <= cap) {
        throw fail(new TidyApiError("truncated", `The response hit max_tokens (${cap}).`, { requestId }));
      }
      raisedCap = true;
      current = { ...current, max_tokens: raised };
      callOpts.timeoutMs = Math.min(callOpts.timeoutMs * 2, MAX_RETRY_TIMEOUT_MS);
      continue;
    }

    const parsed = parseOutput(message);
    if (parsed.ok) return { output: parsed.value, ...meta };
    if (parseRetried) {
      throw fail(new TidyApiError("bad-response", "The model's output is not valid JSON.", { requestId }));
    }
    parseRetried = true;
  }
}

// GET /v1/models?limit=1 spends no tokens. Returns { ok: true } or { ok: false, error }.
// opts: { fetchImpl, apiBase, timeoutMs = 15000, ... } as for callMessages; a refused apiBase comes back
// as { ok: false } with an "invalid-request" error.
export async function testKey(apiKey, opts = {}) {
  const { timeoutMs = TEST_KEY_TIMEOUT_MS, ...rest } = opts;
  try {
    await apiRequest("/v1/models?limit=1", { ...rest, timeoutMs, method: "GET", apiKey });
    return { ok: true };
  } catch (err) {
    if (err instanceof TidyApiError) return { ok: false, error: err };
    throw err;
  }
}
