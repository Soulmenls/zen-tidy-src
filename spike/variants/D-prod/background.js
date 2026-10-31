// M0 spike background (MV3 event page, ES module). Group D copy: adds network probes for the CSP check (10).
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
  if (msg?.type === "probe") {
    // Check 10: run a network probe from the background event page and report CSP violations.
    return runProbe(msg.kind, msg.url);
  }
  if (msg?.type === "env") {
    return Promise.resolve({ hasDocument: typeof document !== "undefined", url: String(location.href) });
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

// Group D: network probes. Each returns {ok, status?, errorName?, error?, violations[]}.
async function runProbe(kind, url) {
  const violations = [];
  const onViolation = e => violations.push({
    directive: e.violatedDirective, effective: e.effectiveDirective, blocked: e.blockedURI,
    disposition: e.disposition, policy: e.originalPolicy,
  });
  const target = typeof document !== "undefined" ? document : self;
  target.addEventListener("securitypolicyviolation", onViolation);
  const settle = () => new Promise(r => setTimeout(r, 400));
  try {
    if (kind === "fetch") {
      const res = await fetch(url, { cache: "no-store", credentials: "omit" });
      const body = await res.text();
      await settle();
      return { kind, ok: true, status: res.status, body: body.slice(0, 80), violations, ctx: "background" };
    }
    if (kind === "xhr") {
      const r = await new Promise(resolve => {
        const x = new XMLHttpRequest();
        x.open("GET", url);
        x.onload = () => resolve({ ok: true, status: x.status });
        x.onerror = () => resolve({ ok: false, errorName: "xhr-error", status: x.status });
        try { x.send(); } catch (e) { resolve({ ok: false, errorName: e.name, error: String(e) }); }
      });
      await settle();
      return { kind, ...r, violations, ctx: "background" };
    }
    return { kind, error: "unknown kind" };
  } catch (e) {
    await settle();
    return { kind, ok: false, errorName: e?.name, error: String(e), violations, ctx: "background" };
  } finally {
    target.removeEventListener("securitypolicyviolation", onViolation);
  }
}
