// Refusal split (pure orchestration): when the model refuses a request, retry its tabs in halves.
// callModel does the actual request, so tests and the benchmark can inject a fake.
//
// Chunks run depth-first, left to right. Every call after the first gets the new groups found so
// far as extra existing groups, so later chunks join them instead of inventing duplicates.

import { validatePlan, nameKey } from "./plan.js";

const SAMPLE_COUNT = 3;
const DEFAULT_MIN_CHUNK = 8;
const DEFAULT_MAX_CALLS = 12;
const DEFAULT_MAX_MS = 180000;

function positiveInts(values) {
  return values.filter((value) => Number.isInteger(value) && value > 0);
}

// A NaN must not switch off the floor or a cap: `calls >= NaN` is always false.
function numberOr(value, fallback) {
  return typeof value === "number" && !Number.isNaN(value) ? value : fallback;
}

// Up to 3 sample titles for an extra group. Payload titles are already redacted, and private tabs
// carry no title, so nothing sensitive can leak into a later request through samples.
function samplesFor(tabIds, chunk) {
  const byId = new Map(chunk.map((tab) => [tab.id, tab]));
  const samples = [];
  for (const id of tabIds) {
    const tab = byId.get(id);
    if (!tab || tab.private || typeof tab.title !== "string" || !tab.title.trim()) continue;
    samples.push(tab.title);
    if (samples.length === SAMPLE_COUNT) break;
  }
  return samples;
}

// planWithRefusalSplit({ tabs, existingGroups }, callModel, opts) resolves to
// { outputs: [{ output, tabs, extraExistingGroups }], refusedTabIds, unsentTabIds, calls, stoppedEarly }.
// Validate each output with validatePlan(output, { ...payload, tabs, existingGroups: [...payload
// existing groups, ...extraExistingGroups] }), then combine them with mergePartialPlans.
// Tab lists hold the `id`s of the given tabs (short ids for payload tabs):
// - refusedTabIds: refused in a chunk too small to split. Remember these and send them as private.
// - unsentTabIds (not in the M1 contract): never sent because maxCalls or maxMs ran out
//   (stoppedEarly). They only shared a refused request with the real culprit, so leave them loose
//   without marking them private.
// A failed call (TidyApiError) rejects the whole run.
export async function planWithRefusalSplit({ tabs, existingGroups = [] } = {}, callModel, options = {}) {
  const opts = options ?? {};
  const maxCalls = numberOr(opts.maxCalls, DEFAULT_MAX_CALLS);
  const maxMs = numberOr(opts.maxMs, DEFAULT_MAX_MS);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  // A refused chunk is split only if both halves keep at least `floor` tabs. At least 1, so an empty
  // chunk is never sent.
  const floor = Math.max(1, Math.ceil(numberOr(opts.minChunk, DEFAULT_MIN_CHUNK)));
  const allTabs = Array.isArray(tabs) ? tabs : [];
  const baseGroups = (Array.isArray(existingGroups) ? existingGroups : []).filter(Boolean);
  const startedAt = now();

  const outputs = [];
  const refusedTabIds = [];
  const unsentTabIds = [];
  const extras = [];
  let nextNumber = Math.max(0, ...positiveInts(baseGroups.map((group) => group.group))) + 1;
  let calls = 0;
  let stoppedEarly = false;

  // Record a chunk's new groups (with the same validation the caller will apply) as extras.
  function collectNewGroups(output, chunk) {
    const idMap = Object.fromEntries(chunk.map((tab) => [tab.id, tab.id]));
    const groupMap = Object.fromEntries(positiveInts(baseGroups.map((g) => g.group)).map((n) => [n, n]));
    const plan = validatePlan(output, {
      tabs: chunk, idMap, groupMap, existingGroups: [...baseGroups, ...extras],
    });
    const taken = new Set(extras.map((group) => nameKey(group.name)));
    for (const group of plan.groups) {
      if (group.kind !== "new" || taken.has(nameKey(group.name))) continue;
      taken.add(nameKey(group.name));
      extras.push({
        group: nextNumber++, name: group.name, icon: group.icon,
        samples: samplesFor(group.tabIds, chunk),
      });
    }
  }

  async function run(chunk) {
    if (calls >= maxCalls || now() - startedAt >= maxMs) {
      stoppedEarly = true;
      unsentTabIds.push(...chunk.map((tab) => tab.id));
      return;
    }
    calls += 1;
    const extraExistingGroups = [...extras];
    const result = await callModel(chunk, extraExistingGroups);
    if (result?.refusal) {
      if (chunk.length < 2 * floor) {
        refusedTabIds.push(...chunk.map((tab) => tab.id));
        return;
      }
      const middle = Math.ceil(chunk.length / 2);
      await run(chunk.slice(0, middle));
      await run(chunk.slice(middle));
      return;
    }
    outputs.push({ output: result?.output, tabs: chunk, extraExistingGroups });
    collectNewGroups(result?.output, chunk);
  }

  if (allTabs.length > 0) await run(allTabs);
  return { outputs, refusedTabIds, unsentTabIds, calls, stoppedEarly };
}
