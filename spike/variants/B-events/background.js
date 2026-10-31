// Group B spike background: like spike/ext/background.js, plus tabs.* event logging.
// Writes are serialized through one promise chain so concurrent events are not lost.

const LOG_KEY = "spikeLog";
let chain = Promise.resolve();

function log(entry) {
  chain = chain.then(async () => {
    const { [LOG_KEY]: entries = [] } = await browser.storage.local.get(LOG_KEY);
    entries.push({ t: Date.now(), ...entry });
    await browser.storage.local.set({ [LOG_KEY]: entries.slice(-2000) });
  }).catch(() => {});
  return chain;
}

browser.runtime.onStartup.addListener(() => log({ event: "onStartup" }));
browser.runtime.onInstalled.addListener(details => log({ event: "onInstalled", reason: details.reason }));

browser.tabGroups.onUpdated.addListener(g =>
  log({ event: "tabGroups.onUpdated", id: g.id, title: g.title, collapsed: g.collapsed, color: g.color }));
browser.tabGroups.onCreated.addListener(g =>
  log({ event: "tabGroups.onCreated", id: g.id, title: g.title, color: g.color }));
browser.tabGroups.onRemoved.addListener(g => log({ event: "tabGroups.onRemoved", id: g.id }));
browser.tabGroups.onMoved.addListener(g => log({ event: "tabGroups.onMoved", id: g.id }));

const brief = t => ({
  id: t.id, index: t.index, windowId: t.windowId, active: t.active, pinned: t.pinned,
  groupId: t.groupId, openerTabId: t.openerTabId, discarded: t.discarded, hidden: t.hidden,
  url: t.url, title: t.title,
});
browser.tabs.onCreated.addListener(t => log({ event: "tabs.onCreated", tab: brief(t) }));
browser.tabs.onActivated.addListener(i => log({ event: "tabs.onActivated", ...i }));
browser.tabs.onRemoved.addListener((id, info) => log({ event: "tabs.onRemoved", id, ...info }));
browser.tabs.onMoved.addListener((id, info) => log({ event: "tabs.onMoved", id, ...info }));
browser.tabs.onAttached.addListener((id, info) => log({ event: "tabs.onAttached", id, ...info }));
browser.tabs.onDetached.addListener((id, info) => log({ event: "tabs.onDetached", id, ...info }));
browser.tabs.onUpdated.addListener((id, changeInfo, t) => {
  const keys = Object.keys(changeInfo).filter(k => !["favIconUrl", "status", "title", "attention"].includes(k));
  if (keys.length) log({ event: "tabs.onUpdated", id, changeInfo, tab: brief(t) });
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (msg?.type === "ping") return Promise.resolve({ ok: true, at: Date.now() });
  return undefined;
});
