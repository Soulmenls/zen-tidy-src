#!/usr/bin/env node
// Benchmark the tidy request over effort {low, medium} x thinking {adaptive, disabled}.
//
// Dry run (default): builds the exact request bodies from real tabs (export-tabs.mjs output) or a
// fixture and writes them, with stats, to %LOCALAPPDATA%\zen-tidy-dev\bench\dry-run-<ts>.json.
// It sends nothing and prints only counts and estimated tokens, never titles.
//
// --send: calls the API with the key from ZEN_TIDY_BENCH_KEY, which only scripts\bench.ps1 sets.
// It counts tokens first (free), prints a cost estimate, asks before spending, and enforces a hard
// USD cap on every attempt, retries included. Results go to ...\bench\results-<ts>.json.
//
//   node scripts/bench.mjs [--fixture <file>] [--configs a,b] [--repeats N] [--limit N] [--out-dir <dir>]
//   pwsh -File scripts\bench.ps1 [same flags] [--cap-usd X] [--yes] [--quality]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { buildPayload, buildRequestBody } from "../extension/background/payload.js";
import { planTidy } from "../extension/background/pipeline.js";
import { API_BASE, API_VERSION, TidyApiError, errorKind, requestPlan } from "../extension/background/anthropic.js";
import { redact } from "../extension/background/log.js";
import { DEFAULT_SENSITIVE } from "../extension/shared/sensitive-defaults.js";
import { devDataDir, fileStamp, isInside } from "./lib/dev-paths.js";
import { parseJsonQuietly } from "./lib/quiet-json.js";

export const MODEL = "claude-haiku-5-5";
export const MAX_TOKENS = 16000;
export const DEFAULT_REPEATS = 3;
// m1-contracts.md. The default 12-call matrix reserves roughly $0.12 at worst, so this is ample.
export const DEFAULT_CAP_USD = 0.5;
// Longer than the extension's 90 s so the bench measures tail latency instead of cutting it off.
export const BENCH_TIMEOUT_MS = 180000;
export const EXTENSION_TIMEOUT_MS = 90000;
// A retry-after still pending when requestPlan gives up is waited out before the next call, up to
// this long; a longer one (a quota window, not a burst) stops the run instead.
export const MAX_RETRY_AFTER_WAIT_MS = 300000;
export const KEY_ENV = "ZEN_TIDY_BENCH_KEY";

export const MATRIX = Object.freeze([
  { name: "low-adaptive", effort: "low", thinking: "adaptive" },
  { name: "low-disabled", effort: "low", thinking: "disabled" },
  { name: "medium-adaptive", effort: "medium", thinking: "adaptive" },
  { name: "medium-disabled", effort: "medium", thinking: "disabled" },
]);

// USD per million tokens (claude-api reference, cached 2026-10-06). Haiku 5.5 has two rate cards
// chosen by prompt length; cache reads are 0.1x input, 5-minute cache writes 1.25x, 1-hour 2x.
export const PRICING = Object.freeze({
  "claude-haiku-5-5": Object.freeze({
    longPromptAbove: 100000,
    base: Object.freeze({ input: 0.1, output: 0.5 }),
    long: Object.freeze({ input: 0.5, output: 2.5 }),
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
  }),
});

// These won't fix themselves between calls, so the run stops instead of burning through the matrix.
const FATAL_KINDS = new Set(["auth", "workspace-scope", "spend-limit", "billing", "permission", "model-unavailable", "invalid-request", "too-large"]);

const USAGE = `Usage: node scripts/bench.mjs [options]
  --fixture <file>   tabs file (default: %LOCALAPPDATA%\\zen-tidy-dev\\real-tabs.json)
  --configs <list>   comma-separated subset of: ${MATRIX.map((c) => c.name).join(", ")}
  --repeats <n>      calls per config with --send (default ${DEFAULT_REPEATS})
  --limit <n>        use only the first n tabs
  --passes <1|2>     with --send: 2 (default) adds the leftover sweep, as the extension does
  --out-dir <dir>    output directory (default: %LOCALAPPDATA%\\zen-tidy-dev\\bench)
  --send             call the API (key from ${KEY_ENV}; run it through scripts\\bench.ps1)
  --cap-usd <x>      hard spending cap for --send (default $${DEFAULT_CAP_USD.toFixed(2)})
  --yes              with --send: skip the confirmation prompt
  --quality          with --send: add grouping metrics per run (coverage, loose tabs on a grouped
                     site, copies of one page split up, icon reuse); counts only, never titles`;

function positiveInt(flag, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer`);
  return n;
}

export function parseArgs(argv) {
  const opts = { send: false, yes: false, help: false, quality: false, fixture: null, outDir: null, configs: MATRIX, repeats: DEFAULT_REPEATS, capUsd: DEFAULT_CAP_USD, limit: null, passes: 2 };
  const valueOf = (i, flag) => {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--send": opts.send = true; break;
      case "--yes": opts.yes = true; break;
      case "--quality": opts.quality = true; break;
      case "--help": case "-h": opts.help = true; break;
      case "--fixture": opts.fixture = valueOf(++i, arg); break;
      case "--out-dir": opts.outDir = valueOf(++i, arg); break;
      case "--repeats": opts.repeats = positiveInt(arg, valueOf(++i, arg)); break;
      case "--limit": opts.limit = positiveInt(arg, valueOf(++i, arg)); break;
      case "--passes": {
        const passes = Number(valueOf(++i, arg));
        if (passes !== 1 && passes !== 2) throw new Error("--passes needs 1 or 2");
        opts.passes = passes;
        break;
      }
      case "--cap-usd": {
        const cap = Number(valueOf(++i, arg));
        if (!Number.isFinite(cap) || cap <= 0) throw new Error("--cap-usd needs a positive number");
        opts.capUsd = cap;
        break;
      }
      case "--configs": {
        const names = valueOf(++i, arg).split(",").map((s) => s.trim()).filter(Boolean);
        const unknown = names.filter((n) => !MATRIX.some((c) => c.name === n));
        if (unknown.length || !names.length) {
          throw new Error(`Unknown config ${unknown.join(", ") || "(none)"}; choose from ${MATRIX.map((c) => c.name).join(", ")}`);
        }
        opts.configs = MATRIX.filter((c) => names.includes(c.name));
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

// ---- Cost ----------------------------------------------------------------------------------

const num = (v) => (Number.isFinite(v) ? v : 0);

export function usageCostUsd(usage, model = MODEL) {
  const p = PRICING[model];
  if (!p) throw new Error(`No pricing for ${model}`);
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  const cacheRead = num(usage?.cache_read_input_tokens);
  const cacheWrite = num(usage?.cache_creation_input_tokens);
  const write1h = Math.min(num(usage?.cache_creation?.ephemeral_1h_input_tokens), cacheWrite);
  const rates = input + cacheRead + cacheWrite > p.longPromptAbove ? p.long : p.base;
  const inputUsd = rates.input * (input + cacheRead * p.cacheRead + (cacheWrite - write1h) * p.cacheWrite5m + write1h * p.cacheWrite1h);
  return (inputUsd + rates.output * output) / 1e6;
}

// One attempt that uses its whole max_tokens (thinking counts against it).
export function worstCaseUsd(inputTokens, maxTokens, model = MODEL) {
  return usageCostUsd({ input_tokens: inputTokens, output_tokens: maxTokens }, model);
}

// What the cap reserves before an attempt: the worst case plus 10% on input, in case the billed
// prompt (structured-output scaffolding) is a little larger than count_tokens said.
export function reserveUsd(inputTokens, maxTokens, model = MODEL) {
  return worstCaseUsd(Math.ceil(inputTokens * 1.1), maxTokens, model);
}

const usd = (x) => `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;
const int = (x) => Math.round(x).toLocaleString("en-US");

// ---- Input ---------------------------------------------------------------------------------

export async function loadTabs(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`No tabs file at ${file}. Run "node scripts/export-tabs.mjs" first, or pass --fixture <file>.`);
  }
  // The CLI prints error messages, and V8's would quote the titles around a syntax error.
  const doc = parseJsonQuietly(text, path.basename(file));
  const list = Array.isArray(doc) ? doc : doc?.tabs;
  if (!Array.isArray(list)) throw new Error(`${path.basename(file)} has no tabs array`);
  return list
    .filter((t) => t && typeof t.url === "string")
    .map((t) => ({ title: typeof t.title === "string" ? t.title : "", url: t.url, lastAccessed: num(t.lastAccessed) }));
}

// Shape exported tabs like snapshot.js output: one window, every tab loose, no existing groups.
export function toSnapshot(rawTabs, takenAt = Date.now()) {
  const tabs = rawTabs.map((t, i) => ({
    id: 1001 + i, // real tab ids, deliberately different from the payload's short ids
    index: i,
    windowId: 1,
    url: t.url,
    title: t.title,
    pinned: false,
    groupId: -1,
    discarded: true,
    active: false,
    lastAccessed: t.lastAccessed,
    width: 0,
    key: `bench-${i + 1}`,
  }));
  // The most recently used tab is the active one, as in a real window.
  const active = tabs.reduce((best, t) => (!best || t.lastAccessed > best.lastAccessed ? t : best), null);
  if (active) Object.assign(active, { active: true, discarded: false, width: 220 });
  return {
    windowId: 1,
    takenAt,
    tabs,
    groups: [],
    tidyGroups: [],
    looseTabIds: tabs.map((t) => t.id),
    splitTabIds: [],
    untouchableGroupIds: [],
    glanceSuspectIds: [],
    activeTabId: active?.id ?? null,
    windowCount: 1,
  };
}

// Builds the payload and one request body per config, exactly as the extension would.
export function buildBench(rawTabs, configs, { takenAt } = {}) {
  const snapshot = toSnapshot(rawTabs, takenAt);
  const payload = buildPayload(snapshot, { sensitive: DEFAULT_SENSITIVE });
  const bodies = configs.map((c) => ({
    ...c,
    body: buildRequestBody(payload, { model: MODEL, effort: c.effort, thinking: c.thinking, maxTokens: MAX_TOKENS }),
  }));
  return { snapshot, payload, bodies };
}

// Rough, offline: JSON-heavy prompts run about 3 characters per token on current Claude tokenizers.
export function estimateTokens(body) {
  return Math.ceil(JSON.stringify(body).length / 3);
}

function resolvePaths(opts, env) {
  const tabsFile = path.resolve(opts.fixture ?? path.join(devDataDir(env, "--fixture <file>"), "real-tabs.json"));
  const outDir = path.resolve(opts.outDir ?? path.join(devDataDir(env, "--out-dir <dir>"), "bench"));
  // Bodies and results contain tab titles: keep them out of the repo.
  if (isInside(outDir)) throw new Error("Refusing to write benchmark output inside the repo; choose an --out-dir outside it.");
  return { tabsFile, outDir };
}

function payloadSummary(source, rawCount, payload) {
  const s = payload.stats;
  return `Tabs: ${rawCount} loaded from ${source}; ${s.tabs} in the payload (${s.private} private), ${s.excluded?.length ?? 0} excluded, ${s.groups} existing groups; message ${int(s.chars)} chars.`;
}

// ---- Dry run -------------------------------------------------------------------------------

export async function dryRun(opts, { env, log, now }) {
  const { tabsFile, outDir } = resolvePaths(opts, env);
  let rawTabs = await loadTabs(tabsFile);
  const loaded = rawTabs.length;
  if (opts.limit) rawTabs = rawTabs.slice(0, opts.limit);
  const started = now();
  const { payload, bodies } = buildBench(rawTabs, opts.configs, { takenAt: started.getTime() });

  const configs = bodies.map((c) => ({
    name: c.name,
    effort: c.effort,
    thinking: c.thinking,
    maxTokens: MAX_TOKENS,
    bodyChars: JSON.stringify(c.body).length,
    estimatedInputTokens: estimateTokens(c.body),
    body: c.body,
  }));
  const calls = configs.length * opts.repeats;
  const worst = configs.reduce((sum, c) => sum + reserveUsd(c.estimatedInputTokens, MAX_TOKENS), 0) * opts.repeats;

  const doc = {
    kind: "zen-tidy-bench-dry-run",
    createdAt: started.toISOString(),
    model: MODEL,
    source: path.basename(tabsFile),
    tabsLoaded: loaded,
    tabsUsed: rawTabs.length,
    payloadStats: payload.stats,
    sendPlan: { calls, repeats: opts.repeats, capUsd: opts.capUsd, roughWorstCaseUsd: worst },
    configs,
  };
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `dry-run-${fileStamp(started)}.json`);
  await writeFile(outFile, JSON.stringify(doc, null, 1) + "\n", "utf8");

  log("Dry run: nothing was sent.");
  log(payloadSummary(path.basename(tabsFile), rawTabs.length, payload) + (opts.limit ? ` (first ${rawTabs.length} of ${loaded})` : ""));
  for (const c of configs) log(`  ${c.name.padEnd(16)} ~${int(c.estimatedInputTokens)} input tokens (estimate: chars/3)`);
  log(`A --send run would make ${calls} calls (${configs.length} configs x ${opts.repeats}); rough worst case ${usd(worst)} at max_tokens ${MAX_TOKENS}; cap ${usd(opts.capUsd)}.`);
  log(`Wrote ${outFile}`);
  return { code: 0, outFile };
}

// ---- --send ---------------------------------------------------------------------------------

// Same headers and fetch options as anthropic.js (which doesn't export them).
function apiInit(apiKey, body, timeoutMs) {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  };
}

async function postCountTokens(body, { apiKey, fetchImpl, timeoutMs }) {
  let response;
  let text;
  try {
    response = await fetchImpl(`${API_BASE}/v1/messages/count_tokens`, apiInit(apiKey, body, timeoutMs));
    text = await response.text();
  } catch (err) {
    throw new TidyApiError(err?.name === "TimeoutError" ? "timeout" : "network", `count_tokens: ${err?.message || err}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const requestId = response.headers?.get?.("request-id") ?? null;
  if (!response.ok) {
    const type = data?.error?.type ?? null;
    const message = data?.error?.message ?? `HTTP ${response.status}`;
    throw new TidyApiError(errorKind(response.status, type, message), `count_tokens: ${message}`, { status: response.status, type, requestId });
  }
  if (!Number.isFinite(data?.input_tokens)) throw new TidyApiError("bad-response", "count_tokens: no input_tokens", { requestId });
  return data.input_tokens;
}

// count_tokens takes the request minus max_tokens. If it rejects the structured-output or thinking
// fields, count the bare prompt and pad it for the schema, flagged as approximate.
export async function countTokens(body, opts) {
  const { max_tokens: _ignored, ...countable } = body;
  try {
    return { inputTokens: await postCountTokens(countable, opts), approximate: false };
  } catch (err) {
    if (!(err instanceof TidyApiError) || err.status !== 400 || err.kind !== "invalid-request") throw err;
  }
  const bare = await postCountTokens({ model: body.model, system: body.system, messages: body.messages }, opts);
  const schemaTokens = Math.ceil(JSON.stringify(body.output_config ?? {}).length / 3);
  return { inputTokens: Math.ceil((bare + schemaTokens) * 1.1), approximate: true };
}

export class CapReachedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapReachedError";
  }
}

// Only count_tokens is free. The meter fails closed: every other request through it is metered, so a
// new spelling of the messages URL (?beta=true, a trailing slash) can't slip past the cap.
function isFreeRequest(url) {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : url?.url;
  try {
    const parsed = new URL(href);
    return parsed.origin === API_BASE && parsed.pathname.replace(/\/+$/, "") === "/v1/messages/count_tokens";
  } catch {
    return false;
  }
}

// Wraps fetch for POST /v1/messages: refuses any attempt whose worst case would cross the cap,
// reserves that worst case while the attempt runs, then settles it to the billed usage. An attempt
// that never returns usage (timeout, network drop, unreadable body) stays charged at worst case,
// because the API may have billed it anyway.
export function createMeter({ fetchImpl, capUsd, model = MODEL, now = Date.now }) {
  const meter = { spentUsd: 0, capHit: false, inputTokens: 0, attempts: [] };
  meter.fetch = async (url, init = {}) => {
    if (isFreeRequest(url)) return fetchImpl(url, init);
    let maxTokens = MAX_TOKENS;
    try {
      maxTokens = Number(JSON.parse(init.body).max_tokens) || MAX_TOKENS;
    } catch {
      // Keep the default.
    }
    const worst = reserveUsd(meter.inputTokens, maxTokens, model);
    if (meter.spentUsd + worst > capUsd + 1e-12) {
      meter.capHit = true;
      throw new CapReachedError(`Next attempt could cost ${usd(worst)}; ${usd(meter.spentUsd)} of the ${usd(capUsd)} cap is spent.`);
    }
    const attempt = { status: null, requestId: null, stopReason: null, usage: null, maxTokens, costUsd: worst, latencyMs: null, settled: false };
    meter.attempts.push(attempt);
    meter.spentUsd += worst;
    const started = now();
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      attempt.latencyMs = now() - started;
      attempt.error = err?.name || "Error";
      throw err;
    }
    attempt.status = response.status;
    attempt.requestId = response.headers?.get?.("request-id") ?? null;
    let data;
    try {
      data = JSON.parse(await response.clone().text());
    } catch {
      data = undefined;
    }
    attempt.latencyMs = now() - started;
    let actual = worst;
    if (!response.ok) actual = 0; // failed requests aren't billed
    else if (data?.usage && typeof data.usage === "object") {
      actual = usageCostUsd(data.usage, model);
      attempt.usage = data.usage;
      attempt.stopReason = data.stop_reason ?? null;
      attempt.settled = true;
    }
    meter.spentUsd += actual - worst;
    attempt.costUsd = actual;
    return response;
  };
  return meter;
}

function sumUsage(attempts) {
  const total = {};
  for (const a of attempts) {
    for (const [k, v] of Object.entries(a.usage ?? {})) if (typeof v === "number") total[k] = (total[k] ?? 0) + v;
  }
  return total;
}

function issueCounts(issues) {
  return Object.fromEntries(Object.entries(issues ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : num(v)]));
}

export function summarizePlan(plan) {
  return {
    groupCount: plan.groups.length,
    newGroups: plan.groups.filter((g) => g.kind === "new").length,
    assignedTabs: plan.groups.reduce((n, g) => n + g.tabIds.length, 0),
    leftoverCount: plan.leftoverTabIds.length,
    issueCounts: issueCounts(plan.issues),
    groups: plan.groups.map((g) => ({ name: g.name, icon: g.icon, kind: g.kind, size: g.tabIds.length })),
  };
}

// --quality: grouping metrics computed from the plan and the payload alone, as counts. "Same site"
// is the host part of the payload's site; copies of one page share a host and an exact title
// (private tabs have no title, so they never count as copies).
export function planQuality(plan, payload) {
  const hostOf = (tab) => String(tab?.site ?? "").split("/")[0].toLowerCase().replace(/^www\./, "");
  const tabsById = new Map(payload.tabs.map((tab) => [payload.idMap[tab.id], tab]));
  const groupOf = new Map();
  plan.groups.forEach((group, index) => group.tabIds.forEach((tabId) => groupOf.set(tabId, index)));
  const sent = [...tabsById.keys()];
  const loose = sent.filter((tabId) => !groupOf.has(tabId));
  const groupedHosts = new Set([...groupOf.keys()].map((tabId) => hostOf(tabsById.get(tabId))));
  const copies = new Map();
  for (const tabId of sent) {
    const tab = tabsById.get(tabId);
    if (tab.private || !tab.title) continue;
    const key = `${hostOf(tab)}\n${tab.title}`;
    copies.set(key, [...(copies.get(key) ?? []), tabId]);
  }
  let splitCopyPages = 0;
  let looseCopies = 0;
  for (const tabIds of copies.values()) {
    const groups = new Set(tabIds.filter((tabId) => groupOf.has(tabId)).map((tabId) => groupOf.get(tabId)));
    if (groups.size > 1) splitCopyPages += 1;
    if (groups.size > 0) looseCopies += tabIds.filter((tabId) => !groupOf.has(tabId)).length;
  }
  const iconUses = plan.groups.reduce((uses, group) => uses.set(group.icon, (uses.get(group.icon) ?? 0) + 1), new Map());
  return {
    sentTabs: sent.length,
    groupedTabs: groupOf.size,
    coverage: sent.length ? groupOf.size / sent.length : 0,
    looseOnGroupedSite: loose.filter((tabId) => groupedHosts.has(hostOf(tabsById.get(tabId)))).length,
    splitCopyPages,
    looseCopies,
    distinctIcons: iconUses.size,
    reusedIcons: [...iconUses.values()].filter((uses) => uses > 1).length,
  };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function summarizeCalls(calls, configs) {
  return configs.map((c) => {
    const mine = calls.filter((r) => r.config === c.name);
    const ok = mine.filter((r) => r.validation);
    return {
      config: c.name,
      calls: mine.length,
      ok: ok.length,
      refusals: mine.filter((r) => r.refusal).length,
      errors: mine.filter((r) => r.error).length,
      medianLatencyMs: median(ok.map((r) => r.latencyMs)),
      maxLatencyMs: ok.length ? Math.max(...ok.map((r) => r.latencyMs)) : null,
      overExtensionTimeout: ok.filter((r) => r.latencyMs > EXTENSION_TIMEOUT_MS).length,
      meanInputTokens: mean(mine.filter((r) => Number.isFinite(r.usage?.input_tokens)).map((r) => r.usage.input_tokens)),
      meanOutputTokens: mean(mine.filter((r) => Number.isFinite(r.usage?.output_tokens)).map((r) => r.usage.output_tokens)),
      meanGroups: mean(ok.map((r) => r.validation.groupCount)),
      meanLeftovers: mean(ok.map((r) => r.validation.leftoverCount)),
      costUsd: mine.reduce((sum, r) => sum + r.costUsd, 0),
    };
  });
}

function describeCall(r) {
  const head = `${r.config} #${r.repeat}: ${(r.latencyMs / 1000).toFixed(1)} s, ${int(num(r.usage?.input_tokens))} in / ${int(num(r.usage?.output_tokens))} out, ${usd(r.costUsd)}`;
  if (r.error) return `${head}, error ${r.error.kind}${r.error.status ? ` (${r.error.status})` : ""}`;
  if (r.refusal) return `${head}, refusal (${r.refusal.category ?? "no category"})`;
  const v = r.validation;
  const issues = Object.values(v.issueCounts).reduce((a, b) => a + b, 0);
  const q = v.quality;
  const quality = q
    ? `, coverage ${(100 * q.coverage).toFixed(1)}%, ${q.looseOnGroupedSite} loose on a grouped site, ${q.splitCopyPages} split copies, ${q.looseCopies} loose copies, icons ${q.distinctIcons}/${v.groupCount}`
    : "";
  return `${head}, ${v.groupCount} groups, ${v.leftoverCount} leftover, ${issues} issue entries${quality}, stop ${r.stopReason}`;
}

export function checkKey(raw) {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return null;
  return /^[\x21-\x7e]+$/.test(key) ? key : null;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A retry-after the API is still asking for after requestPlan gave up (it throws straight away when
// retry-after exceeds its own 60 s limit). 0 when there is none.
function pendingRetryAfterMs(error) {
  const ms = error instanceof TidyApiError ? error.retryAfterMs : null;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export async function send(opts, { env, fetchImpl, log, now, confirm, sleep = realSleep }) {
  const apiKey = checkKey(env[KEY_ENV]);
  if (!apiKey) {
    log(`Refusing to send: ${KEY_ENV} is not set (or not a valid key). Run it through scripts\\bench.ps1.`);
    return { code: 2 };
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required for --send");
  const { tabsFile, outDir } = resolvePaths(opts, env);
  let rawTabs = await loadTabs(tabsFile);
  if (opts.limit) rawTabs = rawTabs.slice(0, opts.limit);
  const started = now();
  const { payload, bodies } = buildBench(rawTabs, opts.configs, { takenAt: started.getTime() });
  log(payloadSummary(path.basename(tabsFile), rawTabs.length, payload));

  // Free: count each config's prompt so the estimate and the cap use real numbers.
  const counted = [];
  for (const c of bodies) {
    const { inputTokens, approximate } = await countTokens(c.body, { apiKey, fetchImpl, timeoutMs: 30000 });
    counted.push({ ...c, inputTokens, approximate });
  }

  const calls = counted.length * opts.repeats;
  const inputUsd = counted.reduce((sum, c) => sum + usageCostUsd({ input_tokens: c.inputTokens }), 0) * opts.repeats;
  const worstUsd = counted.reduce((sum, c) => sum + reserveUsd(c.inputTokens, MAX_TOKENS), 0) * opts.repeats;
  log("Cost estimate:");
  for (const c of counted) {
    log(`  ${c.name.padEnd(16)} ${int(c.inputTokens)} input tokens${c.approximate ? " (approximate)" : ""}; worst case ${usd(reserveUsd(c.inputTokens, MAX_TOKENS))} per call`);
  }
  log(`  ${calls} calls: input ${usd(inputUsd)}; worst case ${usd(worstUsd)} if every call used max_tokens ${MAX_TOKENS}. Hard cap ${usd(opts.capUsd)}.`);
  if (worstUsd > opts.capUsd) log("  The worst case exceeds the cap: the run stops before any attempt that could cross it.");

  if (!opts.yes) {
    const ok = typeof confirm === "function" ? await confirm(`Send ${calls} requests to ${MODEL}? [y/N] `) : false;
    if (!ok) {
      log("Not confirmed; nothing was sent to /v1/messages. (Pass --yes to skip the prompt.)");
      return { code: 2 };
    }
  }

  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `results-${fileStamp(started)}.json`);
  const meter = createMeter({ fetchImpl, capUsd: opts.capUsd, now: () => now().getTime() });
  const results = {
    kind: "zen-tidy-bench-results",
    createdAt: started.toISOString(),
    model: MODEL,
    apiVersion: API_VERSION,
    maxTokens: MAX_TOKENS,
    timeoutMs: BENCH_TIMEOUT_MS,
    pricing: PRICING[MODEL],
    source: path.basename(tabsFile),
    tabsUsed: rawTabs.length,
    payloadStats: payload.stats,
    capUsd: opts.capUsd,
    repeats: opts.repeats,
    configs: counted.map(({ name, effort, thinking, inputTokens, approximate }) => ({ name, effort, thinking, countedInputTokens: inputTokens, approximate })),
    calls: [],
    totalCostUsd: 0,
    stopped: null,
    summary: [],
  };
  const save = async () => {
    results.totalCostUsd = meter.spentUsd;
    results.summary = summarizeCalls(results.calls, counted);
    await writeFile(outFile, JSON.stringify(results, null, 1) + "\n", "utf8");
  };

  let n = 0;
  let waitMs = 0;
  outer: for (let repeat = 1; repeat <= opts.repeats; repeat++) {
    // Interleave configs so drift over time (load, caching) doesn't favour one config.
    for (const c of counted) {
      if (meter.spentUsd + reserveUsd(c.inputTokens, MAX_TOKENS) > opts.capUsd) {
        results.stopped = "cap";
        break outer;
      }
      // Waited only when another call is really about to go out.
      if (waitMs) {
        log(`Waiting ${Math.ceil(waitMs / 1000)} s for the API's retry-after before the next call.`);
        await sleep(waitMs);
        waitMs = 0;
      }
      n += 1;
      meter.inputTokens = c.inputTokens;
      const firstAttempt = meter.attempts.length;
      const callStarted = now();
      let result = null;
      let error = null;
      const refusalCategories = [];
      try {
        // The product's planning path: pass 1, then (with --passes 2) the leftover sweep.
        const requestOutput = async (tabs, existingGroups) => {
          const body = buildRequestBody({ ...payload, tabs, existingGroups }, { effort: c.effort, thinking: c.thinking, maxTokens: MAX_TOKENS });
          const r = await requestPlan(body, { apiKey, fetchImpl: meter.fetch, timeoutMs: BENCH_TIMEOUT_MS });
          if (r.refusal) refusalCategories.push(r.category ?? null);
          return r.refusal ? { refusal: true, category: r.category ?? null } : { output: r.output };
        };
        result = await planTidy(payload, requestOutput, { sweep: opts.passes === 2 });
      } catch (err) {
        error = err;
      }
      const attempts = meter.attempts.slice(firstAttempt);
      const record = {
        config: c.name,
        repeat,
        startedAt: callStarted.toISOString(),
        latencyMs: now().getTime() - callStarted.getTime(),
        attempts: attempts.map(({ settled: _s, ...a }) => a),
        usage: sumUsage(attempts),
        costUsd: attempts.reduce((sum, a) => sum + a.costUsd, 0),
        stopReason: result?.refusedTabIds?.length ? "refusal" : attempts.at(-1)?.stopReason ?? null,
        refusal: refusalCategories.length ? { refusedTabs: result?.refusedTabIds?.length ?? 0, categories: refusalCategories } : null,
        passes: result?.passes ?? null,
        error: null,
        validation: null,
        output: null,
      };
      if (error) {
        record.error = meter.capHit
          ? { kind: "cap", message: "stopped by the cost cap" }
          : { kind: error.kind ?? "exception", status: error.status ?? null, type: error.type ?? null, requestId: error.requestId ?? null, message: redact(String(error.message ?? error)) };
      } else if (result.refusedTabIds.length < payload.tabs.length) {
        // A run where every tab was refused has no plan to summarize.
        record.validation = summarizePlan(result.plan);
        if (opts.quality) record.validation.quality = planQuality(result.plan, payload);
      }
      results.calls.push(record);
      await save();
      log(`[${n}/${calls}] ${describeCall(record)}`);

      if (meter.capHit) {
        results.stopped = "cap";
        break outer;
      }
      if (error && (FATAL_KINDS.has(error.kind) || !(error instanceof TidyApiError))) {
        results.stopped = `error: ${error.kind ?? error.name}`;
        break outer;
      }
      // Sending again before retry-after has passed would only turn the remaining calls into 429s.
      waitMs = pendingRetryAfterMs(error);
      if (waitMs > MAX_RETRY_AFTER_WAIT_MS) {
        results.stopped = `retry-after ${Math.ceil(waitMs / 1000)} s`;
        break outer;
      }
    }
  }
  await save();

  log("Summary:");
  for (const s of results.summary) {
    const latency = s.medianLatencyMs === null ? "-" : `${(s.medianLatencyMs / 1000).toFixed(1)} s median`;
    const groups = s.meanGroups === null ? "-" : s.meanGroups.toFixed(1);
    log(`  ${s.config.padEnd(16)} ${s.ok}/${s.calls} ok, ${s.refusals} refused, ${s.errors} errors; ${latency}; ${groups} groups; ${usd(s.costUsd)}`);
  }
  log(`Total ${usd(meter.spentUsd)} of the ${usd(opts.capUsd)} cap.${results.stopped ? ` Stopped early (${results.stopped}).` : ""}`);
  log(`Wrote ${outFile}`);
  const fatal = results.stopped && results.stopped !== "cap";
  return { code: fatal ? 1 : 0, outFile, results };
}

// ---- Entry point -----------------------------------------------------------------------------

async function terminalConfirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function main(argv, io = {}) {
  const { env = process.env, log = console.log, now = () => new Date(), fetchImpl = null, confirm = null, sleep = realSleep } = io;
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return { code: 0 };
  }
  // The dry run is never handed a fetch, so it cannot send anything.
  if (!opts.send) return dryRun(opts, { env, log, now });
  return send(opts, { env, fetchImpl, log, now, confirm, sleep });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { fetchImpl: globalThis.fetch, confirm: terminalConfirm }).then(
    ({ code }) => (process.exitCode = code),
    (error) => {
      console.error(`bench: ${redact(String(error?.message ?? error))}`);
      process.exitCode = 1;
    },
  );
}
