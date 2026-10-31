// M0 spike background (MV3 event page, ES module).
// Records lifecycle and tab-group events so checks can inspect them later.

const LOG_KEY = "spikeLog";

async function log(entry) {
  const { [LOG_KEY]: entries = [] } = await browser.storage.local.get(LOG_KEY);
  entries.push({ t: Date.now(), ...entry });
  await browser.storage.local.set({ [LOG_KEY]: entries.slice(-500) });
}

browser.runtime.onStartup.addListener(() => log({ event: "onStartup" }));
browser.runtime.onInstalled.addListener(details => log({ event: "onInstalled", reason: details.reason }));

browser.tabGroups.onUpdated.addListener(group =>
  log({ event: "tabGroups.onUpdated", id: group.id, title: group.title, collapsed: group.collapsed }));
browser.tabGroups.onCreated.addListener(group =>
  log({ event: "tabGroups.onCreated", id: group.id, title: group.title }));
browser.tabGroups.onRemoved.addListener(group =>
  log({ event: "tabGroups.onRemoved", id: group.id }));

// Commands from the spike page. Only accept messages from our own extension pages.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id || sender.tab?.url?.startsWith("moz-extension://") === false) {
    return undefined;
  }
  if (msg?.type === "ping") {
    return Promise.resolve({ ok: true, at: Date.now() });
  }
  if (msg?.type === "longFetch") {
    // Check 6: start a slow request and record whether it completes.
    runLongFetch(msg).catch(e => log({ event: "longFetch.error", error: String(e) }));
    return Promise.resolve({ started: true });
  }
  return undefined;
});

async function runLongFetch({ url, keepalive, label }) {
  const started = Date.now();
  await log({ event: "longFetch.start", label, keepalive });
  let timer = null;
  if (keepalive) {
    // A parent-process API call resets Firefox's event-page idle timer; fetch alone does not.
    timer = setInterval(() => {
      browser.storage.session.set({ keepalive: Date.now() });
    }, 15000);
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    await log({ event: "longFetch.done", label, keepalive, ms: Date.now() - started, status: res.status, body: text.slice(0, 100) });
  } finally {
    if (timer) clearInterval(timer);
  }
}
