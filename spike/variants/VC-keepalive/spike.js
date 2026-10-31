// VC verifier variant of the spike command runner. Same as spike/ext/spike.js plus a page-side keepalive:
// the extension PAGE (not the background) calls storage.session.set on an interval.

let pageTimer = null;
let pageTicks = [];

const commands = {
  async api(path, args = []) {
    const parts = path.split(".");
    let target = browser;
    for (const p of parts.slice(0, -1)) target = target[p];
    return await target[parts.at(-1)](...args);
  },

  async bg(message) {
    return await browser.runtime.sendMessage(message);
  },

  async startPageKeepalive(ms, label, area = "session") {
    if (pageTimer) clearInterval(pageTimer);
    pageTicks = [];
    const t0 = Date.now();
    pageTimer = setInterval(async () => {
      const t = Date.now();
      try {
        await browser.storage[area].set({ pageKeepalive: t, label });
        pageTicks.push({ t, since_start_ms: t - t0, ok: true, area });
      } catch (e) {
        pageTicks.push({ t, since_start_ms: t - t0, ok: false, error: String(e) });
      }
    }, ms);
    return { started: t0 };
  },

  async stopPageKeepalive() {
    if (pageTimer) clearInterval(pageTimer);
    pageTimer = null;
    return pageTicks;
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
