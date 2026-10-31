"""Check 4 (part 2): what tabs.group / tabs.ungroup / tabs.move do to Zen split views. Port 2956, profile B-splitbreak.

Splits (set up via gZenViewSplitter.splitTabs):
  X: tabs.group({tabIds:[X1]})        -> one split tab pulled into a new group
  W: tabs.group({tabIds:[W1, W2]})    -> both split tabs pulled into a new group
  Y: tabs.ungroup([Y1])               -> one split tab ungrouped
  V: tabs.move(L1, index inside V)    -> loose tab moved into the middle of a split
     tabs.move(L2, index = V first)   -> loose tab moved to the split's leading edge
  Z: untouched (positive control)
Then restart and check which splits Zen restores.
"""
import json
import sys

from B_common import (ADDON, ZenSession, api, build_b_xpi, chrome_run, ext_snapshot, inspect, make_profile,
                      save_result, val)

PORT = 2956

SPLIT = r"""
    const tabs = args[0].map(byId);
    const data = win.gZenViewSplitter.splitTabs(tabs, "grid", args[1]);
    await sleep(1200);
    return { ok: !!data, groupId: data?.groupId, flags: tabs.map(t => !!t.splitView) };
"""

SPLIT_STATE = r"""
    const res = {};
    for (const [name, id] of Object.entries(args[0])) {
      let t = null; try { t = byId(id); } catch (e) {}
      if (!t) { res[name] = null; continue; }
      res[name] = { splitViewFlag: !!t.splitView, group: t.group?.id ?? null,
                    groupIsSplit: t.group?.hasAttribute("split-view-group") ?? null,
                    groupLabelAttr: t.group?.getAttribute("label") ?? null,
                    inSplitData: (win.gZenViewSplitter._data || []).some(d => d.tabs.includes(t)),
                    gbIndex: win.gBrowser.tabs.indexOf(t) };
    }
    res._splitData = (win.gZenViewSplitter._data || []).map(d => ({
      groupId: d.groupId, groupConnected: !!win.document.getElementById(d.groupId),
      tabs: d.tabs.map(t => { try { return tt.getId(t); } catch (e) { return "?"; } }) }));
    res._splitGroups = [...win.gBrowser.tabGroups].filter(g => g.hasAttribute("split-view-group"))
      .map(g => ({ id: g.id, tabs: g.tabs.map(t => tt.getId(t)) }));
    return res;
"""

SPLIT_STATE_BY_URL = r"""
    const res = {};
    for (const t of win.gBrowser.tabs) {
      const u = t.linkedBrowser.currentURI.spec;
      if (!u.includes("/split/")) continue;
      res[u.split("/").pop()] = { splitViewFlag: !!t.splitView, group: t.group?.id ?? null,
        groupIsSplit: t.group?.hasAttribute("split-view-group") ?? null,
        inSplitData: (win.gZenViewSplitter._data || []).some(d => d.tabs.includes(t)), gbIndex: win.gBrowser.tabs.indexOf(t) };
    }
    res._splitData = (win.gZenViewSplitter._data || []).map(d => ({
      groupId: d.groupId, tabs: d.tabs.map(t => t.linkedBrowser.currentURI.spec.split("/").pop()) }));
    res._splitGroups = [...win.gBrowser.tabGroups].filter(g => g.hasAttribute("split-view-group"))
      .map(g => ({ id: g.id, tabs: g.tabs.map(t => t.linkedBrowser.currentURI.spec.split("/").pop()) }));
    return res;
"""


def main():
    out = {"port": PORT}
    xpi = build_b_xpi("B-events-splitbreak")
    prof = make_profile("B-splitbreak", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        names = ["L1", "L2", "X1", "X2", "W1", "W2", "Y1", "Y2", "V1", "V2", "Z1", "Z2", "L3"]
        ids = {}
        for n in names:
            ids[n] = val(api(z, h, "tabs.create", {"url": f"https://example.com/split/{n}", "title": f"Tab {n}",
                                                   "discarded": True, "active": False}))["id"]
        out["ids"] = ids
        out["split_X"] = chrome_run(z, SPLIT, [[ids["X1"], ids["X2"]], 0])   # activated split
        for s in ["W", "Y", "V", "Z"]:
            out[f"split_{s}"] = chrome_run(z, SPLIT, [[ids[f"{s}1"], ids[f"{s}2"]], -1])
        out["state_0"] = chrome_run(z, SPLIT_STATE, [ids])
        out["ext_0"] = ext_snapshot(z, h)

        out["X_group_one"] = api(z, h, "tabs.group", {"tabIds": [ids["X1"]]})
        out["W_group_both"] = api(z, h, "tabs.group", {"tabIds": [ids["W1"], ids["W2"]]})
        out["Y_ungroup_one"] = api(z, h, "tabs.ungroup", [ids["Y1"]])
        z.ext(h, "sleep", [1000])

        v1 = val(api(z, h, "tabs.get", ids["V1"]))
        out["V_move_inside"] = api(z, h, "tabs.move", ids["L1"], {"index": v1["index"]})  # L1 is before V1: moving forward
        out["V_after_inside"] = {n: val(api(z, h, "tabs.get", ids[n])) for n in ["L1", "V1", "V2"]}
        v1 = val(api(z, h, "tabs.get", ids["V1"]))
        out["V_move_edge"] = api(z, h, "tabs.move", ids["L3"], {"index": v1["index"]})     # L3 is after: moving backward
        out["V_after_edge"] = {n: val(api(z, h, "tabs.get", ids[n])) for n in ["L3", "L1", "V1", "V2"]}
        z.ext(h, "sleep", [1000])
        out["state_1"] = chrome_run(z, SPLIT_STATE, [ids])
        out["ext_1"] = ext_snapshot(z, h)

        z.restart()
        h = z.open_ext_page(ADDON)["handle"]
        z.ext(h, "sleep", [1500])
        out["state_after_restart"] = chrome_run(z, SPLIT_STATE_BY_URL)
        out["ext_after_restart"] = ext_snapshot(z, h)
        out["chrome_after_restart"] = inspect(z)
    finally:
        z.quit()
    path = save_result("B-splitbreak", out)
    print("saved", path)
    for k in ["split_X", "split_W", "split_Y", "split_V", "split_Z", "X_group_one", "W_group_both", "Y_ungroup_one",
              "V_move_inside", "V_move_edge"]:
        print(k, json.dumps(out.get(k)))
    for k in ["V_after_inside", "V_after_edge"]:
        print(k, json.dumps({n: (t["index"], t["groupId"]) for n, t in out[k].items()}))
    for k in ["state_0", "state_1", "state_after_restart"]:
        print("==", k)
        for n, s in out[k].items():
            print("  ", n, json.dumps(s))


if __name__ == "__main__":
    sys.exit(main())
