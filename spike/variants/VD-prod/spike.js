// M0 spike command runner. The harness calls window.spike.run(command, argsJson) through Marionette.
// Every result is returned as a JSON string to avoid cross-compartment wrapper issues.

const commands = {
  // Call any WebExtension API: api("tabs.query", [{}]) -> browser.tabs.query({}).
  async api(path, args = []) {
    const parts = path.split(".");
    let target = browser;
    for (const p of parts.slice(0, -1)) target = target[p];
    return await target[parts.at(-1)](...args);
  },

  // Message the background event page.
  async bg(message) {
    return await browser.runtime.sendMessage(message);
  },

  // Try a fetch from this page and report the outcome (used for the CSP check).
  async tryFetch(url) {
    const violations = [];
    const onViolation = e => violations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
    document.addEventListener("securitypolicyviolation", onViolation);
    try {
      const res = await fetch(url, { cache: "no-store" });
      return { ok: true, status: res.status, violations };
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
      return { ok: false, error: String(e), violations };
    } finally {
      document.removeEventListener("securitypolicyviolation", onViolation);
    }
  },

  // Group D: network probe from this extension page (check 10).
  async probe(kind, url) {
    const violations = [];
    const onViolation = e => violations.push({
      directive: e.violatedDirective, effective: e.effectiveDirective, blocked: e.blockedURI,
      disposition: e.disposition, policy: e.originalPolicy,
    });
    document.addEventListener("securitypolicyviolation", onViolation);
    const settle = () => new Promise(r => setTimeout(r, 400));
    try {
      if (kind === "fetch") {
        const res = await fetch(url, { cache: "no-store", credentials: "omit" });
        const body = await res.text();
        await settle();
        return { kind, ok: true, status: res.status, body: body.slice(0, 80), violations, ctx: "page" };
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
        return { kind, ...r, violations, ctx: "page" };
      }
      if (kind === "ws") {
        const r = await new Promise(resolve => {
          let ws;
          try { ws = new WebSocket(url); } catch (e) { resolve({ ok: false, errorName: e.name, error: String(e) }); return; }
          ws.onopen = () => { resolve({ ok: true }); ws.close(); };
          ws.onerror = () => resolve({ ok: false, errorName: "ws-error" });
          setTimeout(() => resolve({ ok: false, errorName: "ws-timeout" }), 4000);
        });
        await settle();
        return { kind, ...r, violations, ctx: "page" };
      }
      if (kind === "beacon") {
        const queued = navigator.sendBeacon(url, "x");
        await settle();
        await settle();
        return { kind, queued, violations, ctx: "page" };
      }
      if (kind === "img") {
        const r = await new Promise(resolve => {
          const img = new Image();
          img.onload = () => resolve({ ok: true });
          img.onerror = () => resolve({ ok: false, errorName: "img-error" });
          img.src = url;
          setTimeout(() => resolve({ ok: false, errorName: "img-timeout" }), 4000);
        });
        await settle();
        return { kind, ...r, violations, ctx: "page" };
      }
      return { kind, error: "unknown kind" };
    } catch (e) {
      await settle();
      return { kind, ok: false, errorName: e?.name, error: String(e), violations, ctx: "page" };
    } finally {
      document.removeEventListener("securitypolicyviolation", onViolation);
    }
  },

  async sleep(ms) {
    await new Promise(r => setTimeout(r, ms));
    return true;
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
