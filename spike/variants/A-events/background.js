// Group A spike variant: serialized event log + optional collapsed-state persistence.
// Throwaway experiment code.

const LOG_KEY = "spikeLog";
const BG_LOADED = Date.now();
let chain = Promise.resolve();

function log(entry) {
  const e = { t: Date.now(), ...entry };
  chain = chain
    .then(async () => {
      const { [LOG_KEY]: entries = [] } = await browser.storage.local.get(LOG_KEY);
      entries.push(e);
      await browser.storage.local.set({ [LOG_KEY]: entries.slice(-3000) });
    })
    .catch(err => console.error("log failed", err));
  return chain;
}

// ---- collapsed-state persistence (enabled when storage.local.collapseMode === "restore") ----
let suppressUntil = 0;
let suppressReason = "";
let startupSeen = false;
// Until onStartup/onInstalled tells us why the background loaded, buffer onUpdated events.
// onStartup -> drop them (restore noise); onInstalled or 3 s timeout (idle wake) -> treat as user changes.
let phase = "pending";
let buffered = [];
setTimeout(() => {
  if (phase === "pending") {
    phase = "running";
    log({ event: "phase.timeout-flush", count: buffered.length });
    flushBuffered();
  }
}, 3000);
async function flushBuffered() {
  const items = buffered;
  buffered = [];
  if ((await getMode()) !== "restore") return;
  for (const g of items) await saveCollapsed(g.id, g.collapsed);
}

function suppress(ms, reason) {
  suppressUntil = Math.max(suppressUntil, Date.now() + ms);
  suppressReason = reason;
}

async function getMode() {
  const { collapseMode = "off" } = await browser.storage.local.get("collapseMode");
  return collapseMode;
}

async function getSaved() {
  const { collapsedById = {} } = await browser.storage.local.get("collapsedById");
  return collapsedById;
}

let saveChain = Promise.resolve();
function saveCollapsed(id, collapsed) {
  saveChain = saveChain.then(async () => {
    const saved = await getSaved();
    saved[id] = collapsed;
    await browser.storage.local.set({ collapsedById: saved });
  });
  return saveChain;
}

async function snapshot() {
  const groups = await browser.tabGroups.query({});
  return groups.map(g => ({ id: g.id, title: g.title, collapsed: g.collapsed }));
}

async function applySaved(label) {
  const saved = await getSaved();
  const out = [];
  for (const [id, collapsed] of Object.entries(saved)) {
    if (!collapsed) continue;
    try {
      const g = await browser.tabGroups.get(Number(id));
      if (!g.collapsed) {
        suppress(1000, "own-apply");
        const r = await browser.tabGroups.update(Number(id), { collapsed: true });
        out.push({ id: Number(id), was: false, now: r.collapsed });
      } else {
        out.push({ id: Number(id), was: true });
      }
    } catch (e) {
      out.push({ id: Number(id), error: String(e) });
    }
  }
  log({ event: "apply", label, sinceBg: Date.now() - BG_LOADED, out });
  return out;
}

async function onStartupRestore() {
  const mode = await getMode();
  log({ event: "startup.mode", mode, sinceBg: Date.now() - BG_LOADED, groups: await snapshot() });
  if (mode !== "restore") return;
  suppress(8000, "startup-settle");
  await applySaved("immediate");
  for (const ms of [250, 1000, 2000, 4000, 7000]) {
    setTimeout(async () => {
      log({ event: "startup.check", ms, sinceBg: Date.now() - BG_LOADED, groups: await snapshot() });
      await applySaved(`after-${ms}`);
    }, ms);
  }
}

// ---- listeners ----
browser.runtime.onStartup.addListener(() => {
  startupSeen = true;
  const dropped = buffered.map(g => ({ id: g.id, collapsed: g.collapsed }));
  buffered = [];
  phase = "startup";
  log({ event: "onStartup", sinceBg: Date.now() - BG_LOADED, droppedBuffered: dropped });
  onStartupRestore();
});
browser.runtime.onInstalled.addListener(details => {
  phase = "running";
  log({ event: "onInstalled", reason: details.reason, flushed: buffered.length });
  flushBuffered();
});

browser.tabGroups.onCreated.addListener(g =>
  log({ event: "tabGroups.onCreated", id: g.id, title: g.title, collapsed: g.collapsed }));
browser.tabGroups.onMoved.addListener(g =>
  log({ event: "tabGroups.onMoved", id: g.id, title: g.title }));
browser.tabGroups.onRemoved.addListener(async (g, info) => {
  // log immediately (shutdown may cut async work short), then check existence
  log({ event: "tabGroups.onRemoved", id: g.id, title: g.title, info });
  const entry = { event: "tabGroups.onRemoved.check", id: g.id };
  try {
    const still = await browser.tabGroups.get(g.id);
    entry.stillExists = true;
    entry.still = still;
  } catch (e) {
    entry.stillExists = false;
  }
  log(entry);
});
browser.tabGroups.onUpdated.addListener(async g => {
  const now = Date.now();
  const suppressed = now < suppressUntil;
  log({ event: "tabGroups.onUpdated", id: g.id, title: g.title, collapsed: g.collapsed,
        sinceBg: now - BG_LOADED, phase, startupSeen, suppressed, suppressReason: suppressed ? suppressReason : "" });
  if (phase === "pending") { buffered.push(g); return; }
  if (!suppressed && (await getMode()) === "restore") {
    await saveCollapsed(g.id, g.collapsed);
  }
});
try {
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if ("groupId" in changeInfo) log({ event: "tabs.onUpdated.groupId", tabId, groupId: changeInfo.groupId });
  }, { properties: ["groupId"] });
} catch (e) {
  log({ event: "tabs.onUpdated.filter-unsupported", error: String(e) });
}

log({ event: "bgLoaded" });

// ---- commands from our own extension page ----
browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id || sender.tab?.url?.startsWith("moz-extension://") === false) {
    return undefined;
  }
  if (msg?.type === "mark") {
    return log({ event: "mark", label: msg.label }).then(() => true);
  }
  if (msg?.type === "state") {
    return getSaved().then(saved => ({ saved, suppressUntil, suppressReason, startupSeen, phase, now: Date.now() }));
  }
  if (msg?.type === "retidy") {
    return retidy(msg);
  }
  if (msg?.type === "flush") {
    return chain.then(() => true);
  }
  return undefined;
});

// Re-tidy: add tabs to a (possibly collapsed) group, then re-collapse it right away.
async function retidy({ tabIds, groupId, recollapse = true }) {
  const before = await browser.tabGroups.get(groupId);
  suppress(1500, "own-retidy");
  log({ event: "retidy.start", before });
  const t0 = Date.now();
  await browser.tabs.group({ tabIds, groupId });
  const t1 = Date.now();
  const mid = await browser.tabGroups.get(groupId);
  log({ event: "retidy.afterGroup", ms: t1 - t0, mid });
  let after = null;
  if (recollapse && before.collapsed) {
    after = await browser.tabGroups.update(groupId, { collapsed: true });
    log({ event: "retidy.recollapsed", after });
  }
  for (const ms of [100, 500, 1500]) {
    setTimeout(async () => log({ event: "retidy.check", ms, g: await browser.tabGroups.get(groupId) }), ms);
  }
  return { before, mid, after };
}
