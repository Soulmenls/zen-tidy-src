"""VB (adversarial verifier for group B), check 4a/4d: split views vs tabs.group / ungroup / move, and whether a
split group is distinguishable from an unnamed plain group through the extension API.

Usage: python VB_split.py <port> <profile-suffix>

Layout after setup (each pair Xn is a Zen split made via gZenViewSplitter.splitTabs):
  L1 [VF1 VF2] L2 [VB1 VB2] L3 [XA1 XA2] [XN1 XN2] [XG1 XG2] [W1 W2] [Y1 Y2] [Z1 Z2] [T1 T2](tidy) [U1 U2](unnamed) L4
Probes (all through extension APIs):
  XA: tabs.group({tabIds:[XA1]})                 split ACTIVATED at creation (initialIndex 0)
  XN: tabs.group({tabIds:[XN1]})                 split NOT activated (initialIndex -1)
  XG: tabs.group({tabIds:[XG1], groupId: T})     one split tab into an existing tidy group
  W : tabs.group({tabIds:[W1, W2]})
  Y : tabs.ungroup([Y1])
  VF: tabs.move(L1, {index: VF2.index - 1})       forward move to a slot strictly inside the split
  VB: tabs.move(L3, {index: VB2.index})           backward move to a slot strictly inside the split
  Z : untouched control
Restart twice; record all stored tabs by URL, split data and sessions.getRecentlyClosed.
"""
import json
import sys

from B_common import ADDON, SIG, ZenSession, Page, build_b_xpi, chrome_run, make_profile, save_result, val

STATE = r"""
    const res = { tabs: {} };
    const all = win.gZenWorkspaces?.allStoredTabs ? [...win.gZenWorkspaces.allStoredTabs] : [...win.gBrowser.tabs];
    for (const t of all) {
      const u = t.linkedBrowser?.currentURI?.spec || "";
      if (!u.includes("/vbs/")) continue;
      res.tabs[u.split("/").pop()] = { splitViewFlag: !!t.splitView, group: t.group?.id ?? null,
        groupIsSplit: t.group?.hasAttribute("split-view-group") ?? null,
        groupLabelAttrCps: t.group ? [...(t.group.getAttribute("label") || "")].map(c => c.codePointAt(0).toString(16)) : null,
        inSplitData: (win.gZenViewSplitter._data || []).some(d => d.tabs.includes(t)),
        gbIndex: win.gBrowser.tabs.indexOf(t), extId: (() => { try { return tt.getId(t); } catch (e) { return null; } })() };
    }
    const nm = t => (t.linkedBrowser?.currentURI?.spec || "?").split("/").pop();
    res.splitData = (win.gZenViewSplitter._data || []).map(d => ({ groupId: d.groupId,
      groupConnected: !!win.document.getElementById(d.groupId), tabs: d.tabs.map(nm) }));
    res.splitGroupsDom = [...win.gBrowser.tabGroups].filter(g => g.hasAttribute("split-view-group"))
      .map(g => ({ id: g.id, tabs: g.tabs.map(nm) }));
    res.selected = nm(win.gBrowser.selectedTab);
    res.closedTabCount = SessionStore.getClosedTabCountForWindow ? SessionStore.getClosedTabCountForWindow(win) : null;
    return res;
"""

SPLIT = r"""
    const tabs = args[0].map(byId);
    const data = win.gZenViewSplitter.splitTabs(tabs, "grid", args[1]);
    await sleep(1200);
    return { ok: !!data, groupId: data?.groupId, flags: tabs.map(t => !!t.splitView),
             selected: tt.getId(win.gBrowser.selectedTab) };
"""


def names_layout(pg):
    return [(t["url"].rsplit("/", 1)[-1], t["index"], t["groupId"]) for t in val(pg.api("tabs.query", {"currentWindow": True}))
            if "/vbs/" in t["url"]]


def main():
    port = int(sys.argv[1])
    suffix = sys.argv[2]
    out = {"port": port}
    xpi = build_b_xpi(f"VB-split-{suffix}")
    prof = make_profile(f"VB-split-{suffix}", port)
    z = ZenSession(prof, port, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        pg = Page(z)
        order = ["L1", "VF1", "VF2", "L2", "VB1", "VB2", "L3", "XA1", "XA2", "XN1", "XN2", "XG1", "XG2", "W1", "W2",
                 "Y1", "Y2", "Z1", "Z2", "T1", "T2", "U1", "U2", "L4"]
        ids = {}
        for n in order:
            ids[n] = val(pg.api("tabs.create", {"url": f"https://example.com/vbs/{n}", "title": f"Tab {n}",
                                                "discarded": True, "active": False}))["id"]
        for n in order:
            pg.api("tabs.move", ids[n], {"index": -1})
        out["ids"] = ids
        out["split_XA"] = chrome_run(z, SPLIT, [[ids["XA1"], ids["XA2"]], 0])
        for s in ["VF", "VB", "XN", "XG", "W", "Y", "Z"]:
            out[f"split_{s}"] = chrome_run(z, SPLIT, [[ids[f"{s}1"], ids[f"{s}2"]], -1])
        tid = val(pg.api("tabs.group", {"tabIds": [ids["T1"], ids["T2"]]}))
        pg.api("tabGroups.update", tid, {"title": SIG + "Tidy T"})
        uid = val(pg.api("tabs.group", {"tabIds": [ids["U1"], ids["U2"]]}))
        out["tidy_gid"], out["unnamed_gid"] = tid, uid
        z.ext(pg.h, "sleep", [1000])
        out["layout_0"] = names_layout(pg)
        out["state_0"] = chrome_run(z, STATE)
        # 4a: full API objects for every group and every tab, to look for ANY field that differs.
        out["api_groups_0"] = val(pg.api("tabGroups.query", {}))
        out["api_tabs_0"] = [t for t in val(pg.api("tabs.query", {"currentWindow": True})) if "/vbs/" in t["url"]]

        # 4d probes.
        out["XA_group_one"] = pg.api("tabs.group", {"tabIds": [ids["XA1"]]})
        out["XN_group_one"] = pg.api("tabs.group", {"tabIds": [ids["XN1"]]})
        out["XG_into_tidy"] = pg.api("tabs.group", {"tabIds": [ids["XG1"]], "groupId": tid})
        out["W_group_both"] = pg.api("tabs.group", {"tabIds": [ids["W1"], ids["W2"]]})
        out["Y_ungroup_one"] = pg.api("tabs.ungroup", [ids["Y1"]])
        z.ext(pg.h, "sleep", [800])
        vf2 = val(pg.api("tabs.get", ids["VF2"]))
        l1 = val(pg.api("tabs.get", ids["L1"]))
        out["VF_before"] = {"L1": l1["index"], "VF2": vf2["index"]}
        out["VF_move"] = pg.api("tabs.move", ids["L1"], {"index": vf2["index"] - 1})
        out["VF_after"] = {n: (lambda t: (t["index"], t["groupId"]))(val(pg.api("tabs.get", ids[n])))
                           for n in ["L1", "VF1", "VF2"]}
        vb2 = val(pg.api("tabs.get", ids["VB2"]))
        l3 = val(pg.api("tabs.get", ids["L3"]))
        out["VB_before"] = {"L3": l3["index"], "VB2": vb2["index"]}
        out["VB_move"] = pg.api("tabs.move", ids["L3"], {"index": vb2["index"]})
        out["VB_after"] = {n: (lambda t: (t["index"], t["groupId"]))(val(pg.api("tabs.get", ids[n])))
                           for n in ["L3", "VB1", "VB2"]}
        z.ext(pg.h, "sleep", [1000])
        out["layout_1"] = names_layout(pg)
        out["state_1"] = chrome_run(z, STATE)
        out["count_1"] = len([t for t in val(pg.api("tabs.query", {})) if "/vbs/" in t["url"]])

        z.restart()
        out["state_r1"] = chrome_run(z, STATE)
        pg = Page(z)
        out["layout_r1"] = names_layout(pg)
        out["count_r1"] = len([t for t in val(pg.api("tabs.query", {})) if "/vbs/" in t["url"]])
        rc = pg.api("sessions.getRecentlyClosed", {})
        out["recently_closed_r1"] = [
            {"tab": (e.get("tab") or {}).get("url"), "window": bool(e.get("window")),
             "lastModified": e.get("lastModified")} for e in rc.get("value", [])] if "value" in rc else rc
        out["closed_groups_r1"] = chrome_run(z, r"""
            const st = JSON.parse(SessionStore.getBrowserState());
            return st.windows.map(w => ({ closedGroups: (w.closedGroups || []).map(g => ({ name: g.name,
              tabs: (g.tabs || []).map(t => (t.state?.entries?.[0]?.url || t.url || "?")) })),
              closedTabs: (w._closedTabs || []).map(t => t.state?.entries?.[0]?.url || "?") }));
        """)
        z.restart()
        out["state_r2"] = chrome_run(z, STATE)
        pg = Page(z)
        out["layout_r2"] = names_layout(pg)
        out["count_r2"] = len([t for t in val(pg.api("tabs.query", {})) if "/vbs/" in t["url"]])
    except Exception as e:
        out["error"] = repr(e)
        raise
    finally:
        z.quit()
        save_result(f"VB-split-{suffix}", out)
    summarize(out)


def summarize(out):
    for k in ["split_XA", "split_XN", "XA_group_one", "XN_group_one", "XG_into_tidy", "W_group_both", "Y_ungroup_one",
              "VF_before", "VF_move", "VF_after", "VB_before", "VB_move", "VB_after"]:
        v = out.get(k)
        if isinstance(v, dict) and isinstance(v.get("value"), list):
            v = [(t["id"], t["index"], t["groupId"]) for t in v["value"]]
        print(k, json.dumps(v))
    print("api groups:")
    for g in out.get("api_groups_0", []):
        print("  ", json.dumps(g, ensure_ascii=True))
    for k in ["state_0", "state_1", "state_r1", "state_r2"]:
        st = out.get(k)
        if not st:
            continue
        print("==", k, "selected", st.get("selected"), "closedTabCount", st.get("closedTabCount"))
        for n, t in st["tabs"].items():
            print("   ", f"{n:4}", json.dumps(t))
        print("    splitData", json.dumps(st["splitData"]))
        print("    splitGroupsDom", json.dumps(st["splitGroupsDom"]))
    for k in ["count_1", "count_r1", "count_r2", "recently_closed_r1", "closed_groups_r1"]:
        print(k, json.dumps(out.get(k)))


if __name__ == "__main__":
    sys.exit(main())
