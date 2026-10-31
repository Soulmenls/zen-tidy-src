"""Group B spike helpers (checks 4, 7, 8). Throwaway experiment code.

Chrome scope is used only for SETUP and for INSPECTING ground truth; the behaviour under test
always goes through the extension APIs (z.ext(handle, "api", ...)).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402,F401

ADDON = "zen-tidy-spike-b@local"
SIG = "⁠⁣"


def build_b_xpi(name="B-events"):
    return build_xpi(os.path.join(SPIKE, "variants", "B-events"),
                     os.path.join(SPIKE, "profiles", "_xpi", f"{name}.xpi"))


def codepoints(s):
    if s is None:
        return None
    return [f"U+{ord(c):04X}" for c in s]


# Ground truth from chrome scope: every tab Zen stores (all Spaces), with extension id mapping.
INSPECT_JS = r"""
const done = arguments[arguments.length - 1];
(async () => {
  try {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const tt = ExtensionParent.apiManager.global.tabTracker;
    const gb = win.gBrowser;
    const extId = t => { try { return t ? tt.getId(t) : null; } catch (e) { return "err:" + e; } };
    const stored = win.gZenWorkspaces?.allStoredTabs ? [...win.gZenWorkspaces.allStoredTabs] : [...gb.tabs];
    const visible = [...gb.tabs];
    const cps = s => s == null ? null : [...s].map(c => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
    const tabs = stored.map(t => ({
      extId: extId(t),
      url: t.linkedBrowser?.currentURI?.spec,
      label: t.label,
      gbTabsIndex: visible.indexOf(t),
      allTabsIndex: [...gb.tabContainer.allTabs].indexOf(t),
      pinned: t.pinned,
      selected: t.selected,
      visuallyselected: t.hasAttribute("visuallyselected"),
      hidden: t.hidden,
      essential: t.hasAttribute("zen-essential"),
      splitView: !!t.splitView,
      glance: t.hasAttribute("zen-glance-tab"),
      glanceId: t.getAttribute("glance-id"),
      emptyTab: t.hasAttribute("zen-empty-tab"),
      pending: t.hasAttribute("pending"),
      ws: t.getAttribute("zen-workspace-id"),
      ownerExtId: extId(t.owner),
      openerExtId: extId(t.openerTab),
      groupId: t.group?.id ?? null,
      groupTag: t.group?.tagName ?? null,
      groupLabelCps: t.group ? cps(t.group.label) : null,
      groupSplitAttr: t.group ? t.group.hasAttribute("split-view-group") : null,
      parentTag: t.parentElement?.tagName,
      parentId: t.parentElement?.id || null,
      parentClass: t.parentElement?.className || null,
      wsContainerId: t.closest("zen-workspace")?.id ?? null,
      inEssentialsSection: !!t.closest(".zen-essentials-container"),
    }));
    const groups = [...gb.tabGroups].map(g => ({
      id: g.id,
      tag: g.tagName,
      label: g.label,
      labelCps: cps(g.label),
      labelAttrCps: cps(g.getAttribute("label")),
      color: g.color,
      collapsed: g.collapsed,
      splitAttr: g.hasAttribute("split-view-group"),
      isZenFolder: !!g.isZenFolder,
      ws: g.getAttribute("zen-workspace-id"),
      parentTag: g.parentElement?.tagName,
      parentId: g.parentElement?.id || null,
      parentClass: g.parentElement?.className || null,
      wsContainerId: g.closest("zen-workspace")?.id ?? null,
      tabExtIds: g.tabs.map(extId),
      pinned: g.pinned ?? null,
    }));
    const split = (win.gZenViewSplitter?._data || []).map(d => ({
      groupId: d.groupId, gridType: d.gridType, tabExtIds: d.tabs.map(extId),
    }));
    const spaces = (win.gZenWorkspaces?.getWorkspaces?.() || []).map(w => ({ uuid: w.uuid, name: w.name }));
    done({
      tabs, groups, split, spaces,
      activeSpace: win.gZenWorkspaces?.activeWorkspace,
      selectedExtId: extId(gb.selectedTab),
      pinnedTabCount: gb.pinnedTabCount,
      numEssentials: gb._numZenEssentials,
      splitCurrentView: win.gZenViewSplitter?.currentView,
    });
  } catch (e) { done({ error: String(e), stack: e.stack }); }
})();
"""


def inspect(z):
    return z.chrome(INSPECT_JS)


def ext_handle(z, tries=4):
    """Open (or re-find) the spike page and make sure its handle answers. After a restart Zen may replace the
    restored spike tab's browsing context once more, so verify and retry."""
    import time
    last = None
    for _ in range(tries):
        try:
            h = z.open_ext_page(ADDON)["handle"]
            z.ext(h, "sleep", [1500])
            z.ext(h, "api", ["tabs.query", [{"currentWindow": True}]])
            return h
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2)
    raise RuntimeError(f"spike page not reachable: {last}")


class Page:
    """Spike page wrapper that re-opens the page if Zen replaced its browsing context (seen after restarts)."""

    def __init__(self, z):
        self.z = z
        self.h = ext_handle(z)

    def api(self, path, *args):
        for attempt in range(3):
            try:
                return self.z.ext(self.h, "api", [path, list(args)])
            except RuntimeError as e:
                if "no such window" not in str(e) or attempt == 2:
                    raise
                self.h = ext_handle(self.z)


def api(z, h, path, *args):
    """Call a browser.* API through the extension page. Returns {"value": ...} or {"error": ...}."""
    return z.ext(h, "api", [path, list(args)])


def val(r):
    if isinstance(r, dict) and "value" in r:
        return r["value"]
    raise RuntimeError(f"api error: {r}")


def ext_snapshot(z, h, extra_ids=()):
    """What the extension sees: tabs.query (window + all), tabs.get for each id, tabGroups.query."""
    snap = {
        "tabs_query_currentWindow": api(z, h, "tabs.query", {"currentWindow": True}),
        "tabs_query_all": api(z, h, "tabs.query", {}),
        "tabs_query_active": api(z, h, "tabs.query", {"active": True}),
        "tabGroups_query": api(z, h, "tabGroups.query", {}),
    }
    ids = set(extra_ids)
    for t in snap["tabs_query_all"].get("value", []):
        ids.add(t["id"])
    snap["tabs_get"] = {str(i): api(z, h, "tabs.get", i) for i in sorted(ids)}
    return snap


def brief_tab(t):
    keys = ["id", "index", "groupId", "splitViewId", "pinned", "active", "highlighted", "hidden", "discarded",
            "openerTabId", "status", "title", "url"]
    return {k: t.get(k) for k in keys}


def brief_group(g):
    return {"id": g["id"], "title": g["title"], "titleCps": codepoints(g["title"]), "color": g["color"],
            "collapsed": g["collapsed"], "windowId": g["windowId"]}


def chrome_run(z, body, args=None):
    """Run an async chrome snippet. `body` is the inside of an async function with `win` and `args` in scope;
    whatever it returns is the result."""
    js = r"""
const done = arguments[arguments.length - 1];
const args = Array.from(arguments).slice(0, -1);
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tt = ExtensionParent.apiManager.global.tabTracker;
  const byId = id => tt.getTab(id);
  try {
""" + body + r"""
  } catch (e) { return { error: String(e), stack: e.stack }; }
})().then(done, e => done({ error: String(e) }));
"""
    return z.chrome(js, args or [])
