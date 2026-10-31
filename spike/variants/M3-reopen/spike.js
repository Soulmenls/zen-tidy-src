// M3 spike page. The harness calls window.spike.run(command, argsJson) through Marionette; every result is a
// JSON string. The page records every tabs.* event with a timestamp, and `reopen` is the procedure under test:
// tabs.create({active: false, url, index}) -> wait for a readiness signal -> tabs.discard.

const rec = [];
let seq = 0;
const ev = (type, data) => { if (rec.length < 40000) rec.push({ seq: seq++, t: Date.now(), type, ...data }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const brief = t => ({ id: t.id, index: t.index, status: t.status, discarded: t.discarded, groupId: t.groupId,
  active: t.active, url: t.url, title: t.title });

const statuses = new Map(); // tabId -> status changes seen, in order
browser.tabs.onCreated.addListener(t => ev("onCreated", brief(t)));
browser.tabs.onUpdated.addListener((id, changeInfo, t) => {
  ev("onUpdated", { id, ci: changeInfo, ...brief(t) });
  if (changeInfo.status) {
    if (!statuses.has(id)) statuses.set(id, []);
    statuses.get(id).push(changeInfo.status);
  }
});
browser.tabs.onRemoved.addListener(id => ev("onRemoved", { id }));

// "loading": the first status change to loading was seen. "complete": loading, then complete.
async function waitStatus(id, want, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = statuses.get(id) || [];
    const li = s.indexOf("loading");
    if (want === "loading" ? li >= 0 : (li >= 0 && s.indexOf("complete", li) >= 0)) return { via: "events", t: Date.now() };
    if (Date.now() > end) return { via: "timeout", t: Date.now() };
    await sleep(20);
  }
}

// wait: "resolve" (discard as soon as tabs.create has resolved), "loading", "complete", "delay:<ms>", "none" (no discard).
async function reopen(item, wait, opts = {}) {
  const props = { active: false, url: item.url };
  if (item.index !== undefined && item.index !== null) props.index = item.index;
  if (item.discarded) { props.discarded = true; props.title = item.title || "x"; }
  const r = { url: item.url, id: null, wait, requestedIndex: props.index ?? null };
  r.t0 = Date.now();
  let tab;
  try {
    tab = await browser.tabs.create(props);
  } catch (e) {
    r.error = String(e);
    return r;
  }
  r.t1 = Date.now();
  r.id = tab.id;
  r.created = brief(tab);
  ev("create-resolved", { id: tab.id });
  if (opts.verifyQuery) {
    const q = await browser.tabs.query({ windowId: tab.windowId });
    r.inQuery = q.some(t => t.id === tab.id);
    if (opts.anchorId) r.anchorInQuery = q.some(t => t.id === opts.anchorId);
    r.tq = Date.now();
  }
  if (item.key && item.keyBefore) {
    try { await browser.sessions.setTabValue(tab.id, "m3name", item.key); } catch (e) { r.keyError = String(e); }
    r.tkey = Date.now();
  }
  if (wait === "loading") r.waited = await waitStatus(tab.id, "loading", 3000);
  else if (wait === "complete") r.waited = await waitStatus(tab.id, "complete", 10000);
  else if (typeof wait === "string" && wait.startsWith("delay:")) await sleep(Number(wait.slice(6)));
  r.t2 = Date.now();
  if (wait !== "none" && !item.discarded) {
    try {
      await browser.tabs.discard(tab.id);
    } catch (e) {
      r.discardError = String(e);
    }
    r.t3 = Date.now();
    ev("discard-resolved", { id: tab.id });
  }
  if (item.key && !item.keyBefore) {
    try { await browser.sessions.setTabValue(tab.id, "m3name", item.key); } catch (e) { r.keyError = String(e); }
    r.tkey = Date.now();
  }
  if (opts.after !== false) {
    try { r.after = brief(await browser.tabs.get(tab.id)); } catch (e) { r.afterError = String(e); }
  }
  return r;
}

async function pool(items, concurrency, wait, opts) {
  const results = new Array(items.length);
  let next = 0;
  const started = Date.now();
  async function worker(w) {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await reopen(items[i], wait, opts);
      results[i].worker = w;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  return { started, ended: Date.now(), totalMs: Date.now() - started, results };
}

const commands = {
  async api(path, args = []) {
    const parts = path.split(".");
    let target = browser;
    for (const p of parts.slice(0, -1)) target = target[p];
    return await target[parts.at(-1)](...args);
  },
  async sleep(ms) { await sleep(ms); return true; },
  async mark() { return seq; },
  async events(since = 0, ids = null) {
    return rec.filter(e => e.seq >= since && (!ids || ids.includes(e.id)));
  },
  async reopen(item, wait, opts) { return await reopen(item, wait, opts); },
  async pool(items, concurrency, wait, opts) { return await pool(items, concurrency, wait, opts); },
  // Every tab of the current window with its m3name tab value (the identity that survives a restart).
  async snapshot() {
    const tabs = await browser.tabs.query({ currentWindow: true });
    const out = [];
    for (const t of tabs) {
      let key = null;
      try { key = await browser.sessions.getTabValue(t.id, "m3name"); } catch (e) { key = "error: " + e; }
      out.push({ ...brief(t), hasTitle: typeof t.title === "string", key: key ?? null });
    }
    return out;
  },
  async queryUrls() {
    const tabs = await browser.tabs.query({ currentWindow: true });
    return tabs.map(brief);
  },
};

window.spike = {
  async run(command, argsJson) {
    try {
      const fn = commands[command];
      if (!fn) return JSON.stringify({ error: `unknown command ${command}` });
      const args = JSON.parse(argsJson || "[]");
      const value = await fn(...args);
      return JSON.stringify({ value: value === undefined ? null : value });
    } catch (e) {
      return JSON.stringify({ error: String(e), stack: e?.stack });
    }
  },
};

document.getElementById("status").textContent = "ready";
