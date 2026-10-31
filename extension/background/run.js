// Tidy runs: one action at a time, from snapshot to preview, with the state kept in storage.session
// so the popup can close and reopen mid-run. Every collaborator is injected, so Node tests run the
// whole state machine against fakes; main.js wires in the real modules.
//
// The lock is in memory. storage.session outlives an event-page restart but the lock doesn't, which is
// why a stored "running", "applying" or "undoing" run without the lock is treated as dead (recover, expireStale).

import { TidyApiError } from "./anthropic.js";
import { redact, REDACTED } from "./log.js";
import { idleRun } from "./store.js";

// The event page dies 30 s after its last parent API call (M0); 15 s timers fire at 16-17 s.
export const KEEPALIVE_MS = 10000;
export const STALE_MS = 60000;

// Friendly text per error kind (implementation-notes failure table). Shown in the popup as is.
export const ERROR_MESSAGES = Object.freeze({
  auth: "Your API key is invalid, revoked or expired. Check it in Settings.",
  permission: "Your API key lacks access to this model. Check it in Settings.",
  "workspace-scope": "This key isn't tied to a workspace. Create one scoped to zen-tidy.",
  "spend-limit": "Workspace spend limit reached.",
  billing: "Your Anthropic account is out of credit.",
  "model-unavailable": "Model unavailable.",
  "too-large": "Too many tabs for one request.",
  "rate-limit": "The API is rate-limiting this key. Try again in a minute.",
  overloaded: "The API is overloaded. Try again shortly.",
  server: "The API had a server error. Try again shortly.",
  timeout: "The API didn't answer in time.",
  network: "You're offline.",
  "csp-blocked": "The request was blocked by the security policy.",
  "bad-response": "The model's answer couldn't be read. Try again.",
  truncated: "The model's answer was cut off. Try again.",
  "invalid-request": "The API rejected the request.",
  interrupted: "Zen Tidy stopped before it finished. Try again.",
  "apply-failed": "Applying the groups failed. Some tabs may already have moved.",
  // Undo only marks the journal undone once it finishes, so after this the same undo can simply be tried again.
  "undo-failed": "Undo stopped partway. Some tabs may already be back. Try Undo again.",
  internal: "Something went wrong. Try again.",
});

const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

// The exact key, wherever it hides, then any key-shaped string (log.js).
function scrub(text, secret) {
  const plain = secret ? String(text).split(secret).join(REDACTED) : String(text);
  return redact(plain);
}

// TidyApiError -> { kind, message, requestId }. Anything else is "internal" with a generic message:
// an unexpected exception's text may hold tab data or worse, so it never reaches the popup.
// `blocked` turns a network error into "csp-blocked" (the CSP raises the same TypeError as offline).
export function describeError(err, { blocked = false, secret } = {}) {
  if (!(err instanceof TidyApiError) || !Object.hasOwn(ERROR_MESSAGES, err.kind)) {
    return { kind: "internal", message: ERROR_MESSAGES.internal, requestId: null };
  }
  const kind = err.kind === "network" && blocked ? "csp-blocked" : err.kind;
  let message = ERROR_MESSAGES[kind];
  if (kind === "rate-limit" && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) {
    message = `The API is rate-limiting this key. Try again in ${Math.ceil(err.retryAfterMs / 1000)} s.`;
  }
  // A 400's own text is the only useful detail ("max_tokens: …"); Anthropic never echoes the key.
  if (kind === "invalid-request" && err.message && err.message !== kind) message = `${message} (${err.message})`;
  const requestId = typeof err.requestId === "string" ? scrub(err.requestId, secret) : null;
  return { kind, message: scrub(message, secret), requestId };
}

export function interruptedError() {
  return { kind: "interrupted", message: ERROR_MESSAGES.interrupted, requestId: null };
}

// An undo that stopped partway, by throwing or because the background died under it. The journal is still undoable,
// and the popup's Retry runs the undo again for this kind (any other kind starts a new tidy).
export function undoFailedError() {
  return { kind: "undo-failed", message: ERROR_MESSAGES["undo-failed"], requestId: null };
}

function busyError() {
  const err = new Error("Another action is running.");
  err.code = "busy";
  return err;
}

// One tab can't form a group, and with no existing group to join there is nothing to ask the model.
// start() refuses on it and looseStatus() reports it, so the popup never offers a tidy that start would refuse.
function nothingToTidy(payload) {
  return payload.tabs.length === 0 || (payload.tabs.length === 1 && payload.existingGroups.length === 0);
}

const isCurrent = (run, runId, state) => run?.id === runId && run.state === state;

// Run stats: request attempts and token counts summed over every requestPlan call of a tidy (both
// passes and every refusal-split chunk), plus the run's wall time. Numbers only: nothing here can hold
// a key, a title or a site. The live end-to-end test reports cost from it. The extension sets no
// cache_control today; both cache fields are kept so the cost stays right if it ever does.
export function emptyStats() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ms: 0 };
}

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

// source is requestPlan's result or a TidyApiError it threw: both carry `calls` (every attempt,
// retries included) and `totalUsage` (summed over those attempts). A result without `calls` still
// stands for one request. A thrown value without it (any other exception) counts the requests that
// were seen going out (`sent`, from the fetch run.js hands to requestPlan), and none when unknown.
export function addStats(stats, source, { failed = false, sent = 0 } = {}) {
  const result = source && typeof source === "object" ? source : null;
  if (!result && !failed) return stats;
  const reported = Number.isInteger(result?.calls) && result.calls > 0 ? result.calls : null;
  stats.calls += reported ?? (failed ? (Number.isInteger(sent) && sent > 0 ? sent : 0) : 1);
  const usage = result?.totalUsage && typeof result.totalUsage === "object" ? result.totalUsage : result?.usage;
  if (usage && typeof usage === "object") {
    stats.inputTokens += count(usage.input_tokens);
    stats.outputTokens += count(usage.output_tokens);
    stats.cacheReadTokens += count(usage.cache_read_input_tokens);
    stats.cacheWriteTokens += count(usage.cache_creation_input_tokens);
  }
  return stats;
}

// Per-pass coverage for a finished tidy, from planTidy's passes: { passes: [{ tabs, grouped, calls }],
// extraPass }. tabs is what a pass was sent and grouped how many of those it placed, in pass order (pass
// 1, the sweep, the extra sweep), so the coverage tail can be read from live runs. Numbers and one
// boolean only. A malformed entry counts as zeros rather than dropping out, so the order stays right.
export function passStats(passes) {
  const list = Array.isArray(passes) ? passes : [];
  const whole = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  return {
    passes: list.map((pass) => ({ tabs: whole(pass?.tabs), grouped: whole(pass?.grouped), calls: whole(pass?.calls) })),
    extraPass: list.some((pass) => pass?.kind === "extra"),
  };
}

// How many private tabs groupPrivateBySite moved into a group (plan.issues.privateGrouped), so live runs
// can tell that step's share from the model's. A count only; 0 when the plan does not report it.
export function privateGroupedCount(plan) {
  const moved = plan?.issues?.privateGrouped;
  return Array.isArray(moved) ? moved.length : 0;
}

// What the preview offers to close when findExtras fails: nothing.
const noExtras = () => ({ duplicates: [], stale: [] });
// A stale-days count as store.js keeps the setting: a whole number of days, 0 included.
const isDayCount = (value) => Number.isInteger(value) && value >= 0;

// runtime.getURL("") is the extension's own origin. main.js passes it as ownOrigin; this is the fallback.
function ownOriginOf(api) {
  try {
    const origin = api?.runtime?.getURL?.("");
    return typeof origin === "string" && origin ? origin : null;
  } catch {
    return null;
  }
}

// createRunner(deps) returns { start, isBusy, withLock, whenIdle, expireStale, recover, looseStatus }.
// - start(windowId) resolves to { started: true } once the run is stored as "running" (planning goes
//   on in the background), or to { error: "busy" | "no-key" | "nothing-to-tidy" | "invalid-request" }.
//   A failure after the run exists is recorded in run.error, and start still says started.
// - withLock(fn) runs fn under the same lock (the apply, undo and group-action paths use it), so tidy, apply, undo
//   and the groups view's actions never overlap.
//   It rejects with an Error whose code is "busy" when the lock is taken.
// - whenIdle() resolves when the current background work (planning or a locked fn) has settled.
// - expireStale() and recover() mark a dead run "interrupted" (stale heartbeat / unconditionally), or "undo-failed"
//   for a dead undo, unless this instance holds the lock, and resolve to the current run (or null). An apply or undo
//   whose journal shows it finished, and only lost the run's last write, becomes "applied" or "undone" instead
//   (store.interruptRun), so Try again never repeats work that is done.
// - looseStatus(windowId) resolves to { looseCount, canTidy }: the number of tabs a tidy would send now, and
//   whether start would accept them (the same nothing-to-tidy rule).
// deps: { api, store, requestPlan, buildPreview, takeSnapshot, buildPayload, buildRequestBody,
//   planTidy, findExtras, apiBase, fetchImpl, now = Date.now, newId, log, blockedSince, keepaliveMs, staleMs,
//   ownOrigin }.
//   blockedSince(ms) resolves to true when a connect-src CSP violation happened since ms.
//   ownOrigin is runtime.getURL("") (default: read from api.runtime, else null); buildPreview leaves the
//   extension's own pages out of the preview, and findExtras never offers them.
//   findExtras(snapshot, { staleDays, now, ownOrigin }) is extras.js's (notes/m4-contracts.md): the duplicate and
//   stale tabs the preview offers to close, and the stale list's day count. It runs after the model's answer and
//   only feeds buildPreview (as `extras`, staleDays always included), so nothing it finds is ever sent.
export function createRunner(deps) {
  const {
    api, store, requestPlan, buildPreview, takeSnapshot, buildPayload, buildRequestBody, planTidy, findExtras,
    apiBase, fetchImpl, now = Date.now, newId = () => crypto.randomUUID(), log = SILENT,
    blockedSince = async () => false, keepaliveMs = KEEPALIVE_MS, staleMs = STALE_MS,
    ownOrigin = ownOriginOf(api),
  } = deps;

  let lock = null;
  let background = Promise.resolve();

  // Synchronous on purpose: two messages arriving together must not both get the lock.
  function acquire(kind) {
    if (lock) return null;
    const held = { kind };
    lock = held;
    return () => {
      if (lock === held) lock = null;
    };
  }

  async function prepare(windowId) {
    const snapshot = await takeSnapshot(api, { windowId });
    const [settings, refusedKeys] = await Promise.all([store.getSettings(), store.getRefusedKeys()]);
    const refused = new Set(refusedKeys);
    const forcePrivateTabIds = snapshot.tabs.filter((tab) => refused.has(tab.key)).map((tab) => tab.id);
    const payload = buildPayload(snapshot, {
      sensitive: settings.sensitive,
      preferences: settings.preferences,
      forcePrivateTabIds,
    });
    return { snapshot, settings, payload };
  }

  // stats: the requests made before the failure, or null when none were (a snapshot failure).
  async function fail(runId, err, apiKey, startedAt, stats = null) {
    const blocked = err instanceof TidyApiError && err.kind === "network" && (await blockedSince(startedAt));
    const error = describeError(err, { blocked, secret: apiKey });
    log.warn("tidy failed", { kind: error.kind, status: err?.status ?? null, type: err?.type ?? null, requestId: error.requestId });
    const failedStats = stats && stats.calls > 0 ? { ...stats, ms: now() - startedAt } : null;
    await store.updateRun((run) =>
      isCurrent(run, runId, "running")
        ? { ...run, state: "error", phase: null, error, stats: failedStats, heartbeatAt: now() }
        : undefined,
    );
  }

  // The tabs the preview offers to close, as of `at`, under the person's stale-days setting. Extras are offered on
  // top of the groups, so a failure here costs only them: the preview the model's answer paid for still shows.
  // The result always carries `staleDays`, the day count the stale list was found with (findExtras' own, else the
  // setting), because the popup's "Not opened in N days" heading must name the rows' own threshold: under the dev
  // override of 0 a heading saying 14 would misdescribe every row.
  function extrasFor(snapshot, settings, at) {
    let found;
    try {
      found = findExtras(snapshot, { staleDays: settings.staleDays, now: at, ownOrigin });
    } catch (err) {
      log.warn("could not find duplicate or stale tabs", { name: err?.name ?? null });
      found = noExtras();
    }
    return { ...found, staleDays: isDayCount(found?.staleDays) ? found.staleDays : settings.staleDays };
  }

  // Refused tabs are sent as private next time; the key is what survives a restart.
  async function rememberRefused(snapshot, refusedTabIds) {
    if (!refusedTabIds.length) return;
    const keyById = new Map(snapshot.tabs.map((tab) => [tab.id, tab.key]));
    const keys = refusedTabIds.map((id) => keyById.get(id)).filter((key) => typeof key === "string" && key);
    try {
      await store.addRefusedKeys(keys);
    } catch (err) {
      // The preview is still good; only next run's privacy hint is lost.
      log.warn("could not store refused tab keys", { name: err?.name ?? null });
    }
  }

  async function plan(runId, { snapshot, settings, payload }, apiKey, startedAt) {
    const keepalive = () => api.storage.session.set({ heartbeat: { runId, at: now() } });
    // Stamped when the phase starts, not when the queued write lands (the request is already out).
    const setPhase = (phase) => {
      const at = now();
      return store
        .updateRun((run) => (isCurrent(run, runId, "running") ? { ...run, phase, heartbeatAt: at } : undefined))
        .catch((err) => log.warn("could not store the phase", { name: err?.name ?? null }));
    };
    const stats = emptyStats();
    // callOptions.timeoutMs (the extra sweep's time box) bounds each attempt and, as totalTimeoutMs, the
    // whole call: requestPlan's max_tokens retry doubles an attempt's timeout, and retries add up.
    const requestOutput = async (tabs, existingGroups, callOptions) => {
      const body = buildRequestBody({ ...payload, tabs, existingGroups }, {
        model: settings.model,
        effort: settings.effort,
        thinking: settings.thinking,
        preferences: settings.preferences,
      });
      // Counts what this call hands to fetch, so an exception that carries no `calls` still counts the
      // requests already sent. Called unbound, like fetchImpl itself; a missing fetchImpl is passed on as
      // is, so requestPlan still refuses it before anything goes out.
      let sent = 0;
      const countingFetch = typeof fetchImpl === "function"
        ? (...args) => {
          sent += 1;
          return fetchImpl(...args);
        }
        : fetchImpl;
      const box = callOptions?.timeoutMs;
      // Timed with the runner's clock, like the pipeline's own elapsed time.
      const timeouts = Number.isFinite(box) && box > 0 ? { timeoutMs: box, totalTimeoutMs: box, now } : {};
      let result;
      try {
        result = await requestPlan(body, { apiKey, fetchImpl: countingFetch, apiBase, keepalive, keepaliveMs, ...timeouts });
      } catch (err) {
        addStats(stats, err, { failed: true, sent });
        throw err;
      }
      addStats(stats, result);
      return result.refusal ? { refusal: true, category: result.category ?? null } : { output: result.output };
    };

    try {
      const tidy = await planTidy(payload, requestOutput, {
        onPass: (index) => setPhase(index === 0 ? "pass1" : "sweep"),
        now,
      });
      await rememberRefused(snapshot, tidy.refusedTabIds);
      const at = now();
      const extras = extrasFor(snapshot, settings, at);
      const preview = buildPreview({ snapshot, payload, tidy, now: at, id: String(newId()), ownOrigin, extras });
      stats.ms = now() - startedAt;
      const doneStats = { ...stats, ...passStats(tidy.passes), privateGrouped: privateGroupedCount(tidy.plan) };
      // Written only if this run is still the current one (a restart may have replaced it).
      await store.updateRun((run) =>
        isCurrent(run, runId, "running")
          ? { ...run, state: "preview", phase: null, preview, stats: doneStats, heartbeatAt: now() }
          : undefined,
      );
      log.info("tidy ready", { calls: tidy.calls, refused: tidy.refusedTabIds.length, ms: stats.ms });
    } catch (err) {
      await fail(runId, err, apiKey, startedAt, stats);
    }
  }

  async function start(windowId) {
    if (!Number.isInteger(windowId) || windowId < 0) return { error: "invalid-request" };
    const release = acquire("tidy");
    if (!release) return { error: "busy" };
    let work = null;
    try {
      const apiKey = await store.readKey();
      if (!apiKey) return { error: "no-key" };
      const runId = String(newId());
      const startedAt = now();
      await store.updateRun(() =>
        idleRun({ id: runId, state: "running", windowId, startedAt, heartbeatAt: startedAt, phase: "snapshot" }),
      );
      let context;
      try {
        context = await prepare(windowId);
      } catch (err) {
        await fail(runId, err, apiKey, startedAt);
        return { started: true };
      }
      if (nothingToTidy(context.payload)) {
        await store.updateRun((run) => (run?.id === runId ? idleRun() : undefined));
        return { error: "nothing-to-tidy" };
      }
      work = plan(runId, context, apiKey, startedAt);
      return { started: true };
    } finally {
      // plan() records its own failures; this only fires if storage itself failed while doing so.
      if (work) background = work.catch((err) => log.error("could not record the run", { name: err?.name ?? null })).finally(release);
      else release();
    }
  }

  function withLock(fn) {
    const release = acquire("locked");
    if (!release) return Promise.reject(busyError());
    const result = (async () => fn())().finally(release);
    background = result.catch(() => {});
    return result;
  }

  // An undo cut short is an undo-failed error rather than a generic interruption, so its Retry undoes again.
  async function expireStale() {
    if (lock) return store.getRun();
    return (await store.interruptRun(interruptedError(), { staleMs, undoError: undoFailedError() })).run;
  }

  async function recover() {
    if (lock) return store.getRun();
    return (await store.interruptRun(interruptedError(), { undoError: undoFailedError() })).run;
  }

  async function looseStatus(windowId) {
    const snapshot = await takeSnapshot(api, { windowId });
    const payload = buildPayload(snapshot);
    return { looseCount: payload.tabs.length, canTidy: !nothingToTidy(payload) };
  }

  return {
    start,
    isBusy: () => lock !== null,
    withLock,
    whenIdle: () => background,
    expireStale,
    recover,
    looseStatus,
  };
}
