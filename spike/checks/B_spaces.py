"""Check 8: two Spaces. Port 2952, profile B-spaces.

Space A and Space B each get loose tabs and a tidy-style group (title starts with SIG). With Space A active,
record what tabs.query / tabGroups.query / tabs.get report, apply the planned filter, then demonstrate the
danger of tabs.group({tabIds:[A tab], groupId: <B group>}). Ends with a restart to see where that tab lands.
The spike page is made an Essential so it stays visible in both Spaces.
"""
import json
import sys

from B_common import (ADDON, SIG, ZenSession, api, brief_group, brief_tab, build_b_xpi, chrome_run, ext_snapshot,
                      inspect, make_profile, save_result, val)

PORT = 2952

TAB_TRUTH = r"""
    const res = {};
    for (const [name, id] of Object.entries(args[0])) {
      let t = null; try { t = byId(id); } catch (e) {}
      if (!t) { res[name] = null; continue; }
      res[name] = { ws: t.getAttribute("zen-workspace-id"), containerWs: t.closest("zen-workspace")?.id ?? null,
                    parentClass: t.parentElement?.className, group: t.group?.id ?? null,
                    groupWs: t.group?.getAttribute("zen-workspace-id") ?? null,
                    groupContainerWs: t.group?.closest("zen-workspace")?.id ?? null,
                    inGBrowserTabs: win.gBrowser.tabs.includes(t), hidden: t.hidden, essential: t.hasAttribute("zen-essential"),
                    visibleInStrip: !!(t.getBoundingClientRect().height) };
    }
    res._active = win.gZenWorkspaces.activeWorkspace;
    return res;
"""


def tidy_filter(snap):
    """The planned rule: a tidy group counts only if >=1 of its tabs is in the current tabs.query result."""
    q = snap["tabs_query_currentWindow"]["value"]
    groups = snap["tabGroups_query"]["value"]
    sig_groups = [g for g in groups if g["title"].startswith(SIG)]
    visible_gids = {t["groupId"] for t in q if t["groupId"] != -1}
    kept = [g for g in sig_groups if g["id"] in visible_gids and
            all(not t["pinned"] for t in q if t["groupId"] == g["id"])]
    return {"naive_title_only": [g["title"] for g in sig_groups], "filtered": [g["title"] for g in kept]}


def main():
    out = {"port": PORT}
    xpi = build_b_xpi("B-events-spaces")
    prof = make_profile("B-spaces", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["page_to_essential"] = chrome_run(z, r"""
            const t = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === args[0]);
            win.gZenPinnedTabManager.addToEssentials(t);
            await sleep(800);
            return { essential: t.hasAttribute("zen-essential"), spaceA: win.gZenWorkspaces.activeWorkspace,
                     spaces: win.gZenWorkspaces.getWorkspaces().map(w => [w.uuid, w.name]) };
        """, [page["url"]])
        space_a = out["page_to_essential"]["spaceA"]

        ids = {}
        for n in ["A1", "A2", "A3", "A4"]:
            ids[n] = val(api(z, h, "tabs.create", {"url": f"https://example.com/spaces/{n}", "title": f"Tab {n}",
                                                   "discarded": True, "active": False}))["id"]
        ga = val(api(z, h, "tabs.group", {"tabIds": [ids["A2"], ids["A3"]]}))
        api(z, h, "tabGroups.update", ga, {"title": SIG + "Test A"})
        # Select A4 so Space A has a loose selected tab (the empty tab otherwise).
        chrome_run(z, "win.gBrowser.selectedTab = byId(args[0]); await sleep(800); return true;", [ids["A4"]])

        out["create_space_b"] = chrome_run(z, r"""
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Space B");
            await sleep(2000);
            return { uuid: ws?.uuid, active: win.gZenWorkspaces.activeWorkspace,
                     spaces: win.gZenWorkspaces.getWorkspaces().map(w => [w.uuid, w.name]) };
        """)
        space_b = out["create_space_b"]["uuid"]
        for n in ["B1", "B2", "B3", "B4"]:
            ids[n] = val(api(z, h, "tabs.create", {"url": f"https://example.com/spaces/{n}", "title": f"Tab {n}",
                                                   "discarded": True, "active": False}))["id"]
        gb = val(api(z, h, "tabs.group", {"tabIds": [ids["B2"], ids["B3"]]}))
        api(z, h, "tabGroups.update", gb, {"title": SIG + "Test B"})
        chrome_run(z, "win.gBrowser.selectedTab = byId(args[0]); await sleep(800); return true;", [ids["B4"]])
        out["ids"], out["ga"], out["gb"], out["space_a"], out["space_b"] = ids, ga, gb, space_a, space_b
        out["truth_in_B"] = chrome_run(z, TAB_TRUTH, [ids])
        out["snap_in_B"] = {"ext": ext_snapshot(z, h, ids.values()), "chrome": inspect(z)}
        out["filter_in_B"] = tidy_filter(out["snap_in_B"]["ext"])

        out["switch_to_A"] = chrome_run(z, r"""
            await win.gZenWorkspaces.changeWorkspaceWithID(args[0]);
            await sleep(2000);
            return { active: win.gZenWorkspaces.activeWorkspace };
        """, [space_a])
        out["truth_in_A"] = chrome_run(z, TAB_TRUTH, [ids])
        snap = ext_snapshot(z, h, ids.values())
        out["snap_in_A"] = {"ext": snap, "chrome": inspect(z)}
        out["in_A"] = {
            "tabs_query_currentWindow": [brief_tab(t) for t in snap["tabs_query_currentWindow"]["value"]],
            "tabs_query_all": [brief_tab(t) for t in snap["tabs_query_all"]["value"]],
            "tabGroups_query": [brief_group(g) for g in snap["tabGroups_query"]["value"]],
            "tabs_get_B": {n: snap["tabs_get"][str(ids[n])] for n in ["B1", "B2", "B3", "B4"]},
            "tabGroups_get_GB": api(z, h, "tabGroups.get", gb),
        }
        out["filter_in_A"] = tidy_filter(snap)

        # DANGER 1: put a Space A tab into the Space B group.
        out["danger_group_A1_into_GB"] = api(z, h, "tabs.group", {"tabIds": [ids["A1"]], "groupId": gb})
        z.ext(h, "sleep", [1500])
        out["truth_after_danger1_in_A"] = chrome_run(z, TAB_TRUTH, [ids])
        out["ext_after_danger1_in_A"] = {
            "A1_get": api(z, h, "tabs.get", ids["A1"]),
            "query_ids": [t["id"] for t in val(api(z, h, "tabs.query", {"currentWindow": True}))],
            "groups": [brief_group(g) for g in val(api(z, h, "tabGroups.query", {}))],
        }
        # DANGER 2: tabs.group on a Space B tab id (obtained only via tabs.get) while Space A is active.
        out["danger_group_B1_new_group"] = api(z, h, "tabs.group", {"tabIds": [ids["B1"]]})
        z.ext(h, "sleep", [1500])
        out["truth_after_danger2_in_A"] = chrome_run(z, TAB_TRUTH, [ids])
        out["ext_after_danger2_in_A"] = {
            "B1_get": api(z, h, "tabs.get", ids["B1"]),
            "query_ids": [t["id"] for t in val(api(z, h, "tabs.query", {"currentWindow": True}))],
            "groups": [brief_group(g) for g in val(api(z, h, "tabGroups.query", {}))],
        }

        out["switch_to_B_again"] = chrome_run(z, r"""
            await win.gZenWorkspaces.changeWorkspaceWithID(args[0]); await sleep(2000);
            return { active: win.gZenWorkspaces.activeWorkspace };
        """, [space_b])
        out["truth_in_B_after"] = chrome_run(z, TAB_TRUTH, [ids])
        out["ext_in_B_after"] = {"query": [brief_tab(t) for t in val(api(z, h, "tabs.query", {"currentWindow": True}))]}
        out["chrome_in_B_after"] = inspect(z)

        out["event_log"] = api(z, h, "storage.local.get", "spikeLog")
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        z.ext(h, "sleep", [1500])
        out["after_restart_chrome"] = inspect(z)
        out["after_restart_ext"] = ext_snapshot(z, h)
    finally:
        z.quit()
    path = save_result("B-spaces", out)
    print("saved", path)
    print("spaces", out["space_a"], out["space_b"], json.dumps(out["create_space_b"]))
    print("filter_in_B", json.dumps(out["filter_in_B"], ensure_ascii=True))
    print("filter_in_A", json.dumps(out["filter_in_A"], ensure_ascii=True))
    print("in A, tabs.query(currentWindow):")
    for t in out["in_A"]["tabs_query_currentWindow"]:
        print("  ", json.dumps(t, ensure_ascii=True))
    print("in A, tabs.query({}) count", len(out["in_A"]["tabs_query_all"]))
    print("in A, tabGroups.query:")
    for g in out["in_A"]["tabGroups_query"]:
        print("  ", json.dumps(g, ensure_ascii=True))
    for n, r in out["in_A"]["tabs_get_B"].items():
        print("  tabs.get", n, json.dumps(brief_tab(r["value"]) if "value" in r else r, ensure_ascii=True))
    print("tabGroups.get(GB)", json.dumps(out["in_A"]["tabGroups_get_GB"], ensure_ascii=True))
    print("truth_in_A", json.dumps(out["truth_in_A"]))
    print("danger1", json.dumps(out["danger_group_A1_into_GB"]), json.dumps(out["truth_after_danger1_in_A"]["A1"]))
    print("danger1 ext", json.dumps(out["ext_after_danger1_in_A"], ensure_ascii=True))
    print("danger2", json.dumps(out["danger_group_B1_new_group"]), json.dumps(out["truth_after_danger2_in_A"]["B1"]))
    print("danger2 ext", json.dumps(out["ext_after_danger2_in_A"], ensure_ascii=True))
    print("in B after:", json.dumps(out["truth_in_B_after"]))
    print("ext in B after:", [(t["url"][-2:], t["index"], t["groupId"]) for t in out["ext_in_B_after"]["query"]])
    ar = out["after_restart_chrome"]
    print("after restart active", ar.get("activeSpace"))
    for t in ar.get("tabs", []):
        if "/spaces/" in (t["url"] or ""):
            print("  ", t["url"][-2:], "ws", t["ws"], "containerWs", t["wsContainerId"], "group", t["groupId"], t["parentClass"])
    for g in ar.get("groups", []):
        print("   G", g["id"], json.dumps(g["label"], ensure_ascii=True), "ws", g["ws"], "containerWs", g["wsContainerId"], g["tabExtIds"])


if __name__ == "__main__":
    sys.exit(main())
