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
