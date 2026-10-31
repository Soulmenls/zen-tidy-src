// VC verifier variant of the spike background (MV3 event page, ES module).
// Same as spike/ext/background.js, plus longFetch2 with a selectable keepalive kind:
//   "none"    - no keepalive
//   "session" - browser.storage.session.set from the background (the planned keepalive)
//   "local"   - browser.storage.local.set from the background (claimed NOT to reset the idle timer)
// Ticks of the "local" kind are appended to storage.local "kaLocalTicks" so the harness can prove the
// writes really happened before the page was suspended.

const LOG_KEY = "spikeLog";

async function log(entry) {
  const { [LOG_KEY]: entries = [] } = await browser.storage.local.get(LOG_KEY);
  entries.push({ t: Date.now(), ...entry });
  await browser.storage.local.set({ [LOG_KEY]: entries.slice(-500) });
}

browser.runtime.onStartup.addListener(() => log({ event: "onStartup" }));
browser.runtime.onInstalled.addListener(details => log({ event: "onInstalled", reason: details.reason }));

// Only used by the "page writes storage.sync" run: an event delivered to a background listener.
// Nothing else ever writes storage.sync, so this listener is silent in the other runs.
browser.storage.sync.onChanged.addListener(changes => {
  if (changes.pageKeepalive) bgSyncEvents.push(Date.now());
});
const bgSyncEvents = [];

browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id || sender.tab?.url?.startsWith("moz-extension://") === false) {
    return undefined;
  }
  if (msg?.type === "ping") {
    return Promise.resolve({ ok: true, at: Date.now() });
  }
  if (msg?.type === "longFetch2") {
    runLongFetch2(msg).catch(e => log({ event: "longFetch.error", label: msg.label, error: String(e) }));
    return Promise.resolve({ started: true });
  }
  return undefined;
});

async function runLongFetch2({ url, kind, intervalMs, label }) {
  const started = Date.now();
  let timer = null;
  let n = 0;
  if (kind === "session") {
    timer = setInterval(() => {
      n++;
      browser.storage.session.set({ keepalive: Date.now(), label, n });
    }, intervalMs);
  } else if (kind === "local") {
    timer = setInterval(() => {
      n++;
      const t = Date.now();
      browser.storage.local.get("kaLocalTicks").then(({ kaLocalTicks = [] }) => {
        kaLocalTicks.push({ label, n, t, since_start_ms: t - started });
        return browser.storage.local.set({ kaLocalTicks });
      });
    }, intervalMs);
  }
  await log({ event: "longFetch.start", label, kind, intervalMs });
  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    await log({ event: "longFetch.done", label, kind, ms: Date.now() - started, status: res.status, body: text.slice(0, 100) });
  } finally {
    if (timer) clearInterval(timer);
  }
}
