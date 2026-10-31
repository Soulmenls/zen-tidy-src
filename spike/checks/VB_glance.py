"""VB (adversarial verifier for group B), checks 4b + 4c: Glance detection signals and Zen folder / Essential
detection, as seen through extension APIs. Setup via chrome scope; observation via tabs.query / tabGroups.query.

Usage: python VB_glance.py <port> <suffix>

Steps:
  folder F1/F2 + Essential E1; load P (select it)
  1 open Glance on P               -> width / active / index signals
  2 resize the window              -> does the 80% width signal follow the window?
  3 switch away to B (loads B)     -> Glance lingers?
  4 back to P                      -> which tab is selected?
  5 close via cmd_zenGlanceClose   -> removed?
  6 discard every loose loaded tab, select Essential E1, open Glance from E1
                                   -> does the width heuristic still have a reference tab?
  7 split S1/S2 (activated), then unsplit and select A
                                   -> do ex-split loose tabs keep a reduced width (false positive)?
  8 open Glance on C, tabs.group the GLANCE; open Glance on D, tabs.group the PARENT
  restart                          -> Glance tabs / their groups after restart
"""
import json
import sys

from B_common import ADDON, ZenSession, Page, build_b_xpi, chrome_run, inspect, make_profile, save_result, val

OPEN_GLANCE = r"""
    const p = byId(args[0]);
    win.gBrowser.selectedTab = p;
    await sleep(1500);
    const g = await win.gZenGlanceManager.openGlance({
      url: args[1], clientX: 0, clientY: 0, width: 0, height: 0,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    await sleep(2500);
    return { glanceExtId: g ? tt.getId(g) : null, selectedIsGlance: win.gBrowser.selectedTab === g,
             glanceAttr: g?.hasAttribute("zen-glance-tab"), glancePinnedAttr: g?.pinned,
             glanceParentEl: g?.parentElement?.className, parentPinned: p.pinned };
"""


def ext_view(pg):
    tabs = val(pg.api("tabs.query", {"currentWindow": True}))
    rows = [{"id": t["id"], "index": t["index"], "active": t["active"], "pinned": t["pinned"], "groupId": t["groupId"],
             "discarded": t["discarded"], "w": t.get("width"), "h": t.get("height"), "status": t["status"],
             "url": t["url"].rsplit("/", 1)[-1][:24]} for t in tabs]
    not_inc = [{"id": rows[i]["id"], "index": rows[i]["index"], "prev_index": rows[i - 1]["index"]}
               for i in range(1, len(rows)) if rows[i]["index"] <= rows[i - 1]["index"]]
    groups = val(pg.api("tabGroups.query", {}))
    # The heuristic proposed by group B, applied verbatim.
    split_or_unnamed = {g["id"] for g in groups if g["title"] == ""}
    ref = [r["w"] for r in rows if not r["discarded"] and not r["pinned"] and r["groupId"] not in split_or_unnamed]
    ref_max = max(ref) if ref else None
    flagged_width = [r["id"] for r in rows if not r["discarded"] and not r["pinned"] and r["groupId"] == -1
                     and ref_max and r["w"] < 0.9 * ref_max]
    # Alternative: include pinned loaded tabs in the reference.
    ref_all = [r["w"] for r in rows if not r["discarded"] and r["groupId"] not in split_or_unnamed]
    ref_all_max = max(ref_all) if ref_all else None
    flagged_width_incl_pinned = [r["id"] for r in rows if not r["discarded"] and not r["pinned"] and r["groupId"] == -1
                                 and ref_all_max and r["w"] < 0.9 * ref_all_max]
    return {"rows": rows, "index_not_increasing": not_inc, "active_ids": [r["id"] for r in rows if r["active"]],
            "B_heuristic_ref_max": ref_max, "B_heuristic_flagged": flagged_width,
            "alt_ref_max_incl_pinned": ref_all_max, "alt_flagged": flagged_width_incl_pinned,
            "groups": [{k: g[k] for k in ["id", "title", "color", "collapsed"]} for g in groups]}


def main():
    port = int(sys.argv[1])
    suffix = sys.argv[2]
    out = {"port": port, "steps": {}}
    xpi = build_b_xpi(f"VB-glance-{suffix}")
    prof = make_profile(f"VB-glance-{suffix}", port)
    z = ZenSession(prof, port, headless=True).launch()

    def snap(name, extra=None):
        rec = {"ext": ext_view(pg)}
        c = inspect(z)
        rec["chrome_glances"] = [{"extId": t["extId"], "owner": t["ownerExtId"], "selected": t["selected"],
                                  "parent": t["parentClass"], "pinned": t["pinned"]} for t in c.get("tabs", []) if t["glance"]]
        rec["chrome_selected"] = c.get("selectedExtId")
        if extra:
            rec.update(extra)
        out["steps"][name] = rec
        return rec

    try:
        out["install"] = z.install_addon(xpi)
        pg = Page(z)
        ids = {}
        for n in ["E1", "F1", "F2", "A", "P", "B", "C", "D", "S1", "S2"]:
            ids[n] = val(pg.api("tabs.create", {"url": f"https://example.com/vbg/{n}", "title": f"Tab {n}",
                                                "discarded": True, "active": False}))["id"]
        for n in ["A", "P", "B", "C", "D", "S1", "S2"]:
            pg.api("tabs.move", ids[n], {"index": -1})
        out["ids"] = ids
        out["setup"] = chrome_run(z, r"""
            win.gZenPinnedTabManager.addToEssentials(byId(args[0]));
            const f = win.gZenFolders.createFolder([byId(args[1]), byId(args[2])], { label: "Folder X" });
            await sleep(1000);
            win.gBrowser.selectedTab = byId(args[3]); await sleep(2000);
            return { folder: f.id, essential: byId(args[0]).hasAttribute("zen-essential"),
                     win: [win.outerWidth, win.outerHeight] };
        """, [ids["E1"], ids["F1"], ids["F2"], ids["P"]])
        snap("0_baseline_P_loaded")

        out["open1"] = chrome_run(z, OPEN_GLANCE, [ids["P"], "https://example.com/vbg/G1"])
        g1 = out["open1"]["glanceExtId"]
        snap("1_glance_open")
        out["resize"] = chrome_run(z, r"""
            const before = [win.outerWidth, win.outerHeight];
            win.resizeTo(1000, 700); await sleep(2000);
            return { before, after: [win.outerWidth, win.outerHeight] };
        """)
        snap("2_after_resize")
        out["switch_away"] = chrome_run(z, r"""
            win.gBrowser.selectedTab = byId(args[0]); await sleep(2500);
            const g = byId(args[1]); return { glanceStillThere: !!g && g.isConnected };
        """, [ids["B"], g1])
        snap("3_switched_away")
        out["back_to_parent"] = chrome_run(z, r"""
            win.gBrowser.selectedTab = byId(args[0]); await sleep(2500);
            return { selectedExtId: tt.getId(win.gBrowser.selectedTab) };
        """, [ids["P"]])
        snap("4_back_to_parent")
        out["close_cmd"] = chrome_run(z, r"""
            const g = byId(args[0]);
            if (win.gBrowser.selectedTab !== g) win.gBrowser.selectedTab = g;
            await sleep(500);
            win.document.getElementById("cmd_zenGlanceClose").doCommand();
            for (let i = 0; i < 60 && g.isConnected; i++) await sleep(100);
            await sleep(1000);
            return { glanceRemoved: !g.isConnected, selectedExtId: tt.getId(win.gBrowser.selectedTab) };
        """, [g1])
        snap("5_closed")

        # 6: Glance from an Essential while every loose tab is unloaded.
        out["select_E1"] = chrome_run(z, "win.gBrowser.selectedTab = byId(args[0]); await sleep(2000); return tt.getId(win.gBrowser.selectedTab);", [ids["E1"]])
        loaded_loose = [r["id"] for r in ext_view(pg)["rows"] if not r["pinned"] and not r["discarded"]]
        out["discard_loose"] = {"ids": loaded_loose, "result": pg.api("tabs.discard", loaded_loose) if loaded_loose else None}
        z.ext(pg.h, "sleep", [1000])
        snap("6a_all_loose_discarded_E1_selected")
        out["open_ess"] = chrome_run(z, OPEN_GLANCE, [ids["E1"], "https://example.com/vbg/GE"])
        ge = out["open_ess"]["glanceExtId"]
        snap("6b_glance_from_essential")
        out["close_ess"] = chrome_run(z, r"""
            const g = byId(args[0]);
            if (win.gBrowser.selectedTab !== g) win.gBrowser.selectedTab = g;
            await sleep(500);
            win.document.getElementById("cmd_zenGlanceClose").doCommand();
            for (let i = 0; i < 60 && g.isConnected; i++) await sleep(100);
            await sleep(1000);
            return { glanceRemoved: !g.isConnected };
        """, [ge])

        # 7: split then unsplit: false positive?
        out["split_then_unsplit"] = chrome_run(z, r"""
            const [s1, s2, a] = [byId(args[0]), byId(args[1]), byId(args[2])];
            win.gBrowser.selectedTab = s1; await sleep(1500);
            const d = win.gZenViewSplitter.splitTabs([s1, s2], "grid", 0); await sleep(2500);
            const during = { w1: s1.linkedBrowser.clientWidth, w2: s2.linkedBrowser.clientWidth };
            win.gZenViewSplitter.unsplitCurrentView(); await sleep(2000);
            win.gBrowser.selectedTab = a; await sleep(2500);
            return { ok: !!d, during, after: { w1: s1.linkedBrowser.clientWidth, w2: s2.linkedBrowser.clientWidth,
                     g1: s1.group?.id ?? null, g2: s2.group?.id ?? null } };
        """, [ids["S1"], ids["S2"], ids["A"]])
        snap("7_after_unsplit_A_selected")

        # 8: danger probes.
        out["open3"] = chrome_run(z, OPEN_GLANCE, [ids["C"], "https://example.com/vbg/G3"])
        g3 = out["open3"]["glanceExtId"]
        out["group_glance"] = pg.api("tabs.group", {"tabIds": [g3]})
        z.ext(pg.h, "sleep", [1500])
        out["after_group_glance_chrome"] = chrome_run(z, r"""
            const g = byId(args[0]);
            return { glanceAttr: g?.hasAttribute("zen-glance-tab"), glanceId: g?.getAttribute("glance-id"),
                     parentClass: g?.parentElement?.className, group: g?.group?.id ?? null,
                     selected: win.gBrowser.selectedTab === g,
                     overlayOpen: !!win.document.querySelector(".zen-glance-overlay") };
        """, [g3])
        snap("8a_after_group_glance")
        out["open4"] = chrome_run(z, OPEN_GLANCE, [ids["D"], "https://example.com/vbg/G4"])
        g4 = out["open4"]["glanceExtId"]
        out["group_parent"] = pg.api("tabs.group", {"tabIds": [ids["D"]]})
        z.ext(pg.h, "sleep", [1500])
        out["after_group_parent_chrome"] = chrome_run(z, r"""
            const g = byId(args[0]); const p = byId(args[1]);
            return { glanceAttr: g?.hasAttribute("zen-glance-tab"), glanceParentEl: g?.parentElement?.className,
                     glanceInsideParent: !!p?.contains(g), parentGroup: p?.group?.id ?? null,
                     glanceGroup: g?.group?.id ?? null, selected: tt.getId(win.gBrowser.selectedTab) };
        """, [g4, ids["D"]])
        snap("8b_after_group_parent")
        out["glance_ids"] = {"g1": g1, "ge": ge, "g3": g3, "g4": g4}
        z.restart()
        pg = Page(z)
        out["after_restart_urls"] = [(t["url"].rsplit("/", 1)[-1], t["groupId"], t["pinned"])
                                     for t in val(pg.api("tabs.query", {"currentWindow": True}))]
        out["after_restart_groups"] = [{k: g[k] for k in ["id", "title", "color"]} for g in val(pg.api("tabGroups.query", {}))]
        out["after_restart_chrome"] = chrome_run(z, r"""
            return [...win.gZenWorkspaces.allStoredTabs].map(t => ({ u: t.linkedBrowser?.currentURI?.spec?.split("/").pop(),
              glance: t.hasAttribute("zen-glance-tab"), group: t.group?.id ?? null }));
        """)
    except Exception as e:
        out["error"] = repr(e)
        raise
    finally:
        z.quit()
        save_result(f"VB-glance-{suffix}", out)
    for k in ["setup", "open1", "resize", "switch_away", "back_to_parent", "close_cmd", "select_E1", "discard_loose",
              "open_ess", "close_ess", "split_then_unsplit", "open3", "group_glance", "after_group_glance_chrome",
              "open4", "group_parent", "after_group_parent_chrome", "glance_ids"]:
        print(k, json.dumps(out.get(k)))
    for name, rec in out["steps"].items():
        e = rec["ext"]
        print(f"== {name}: active={e['active_ids']} chrome_sel={rec['chrome_selected']} glances={rec['chrome_glances']}")
        print(f"   not_increasing={e['index_not_increasing']} B_ref_max={e['B_heuristic_ref_max']} B_flagged={e['B_heuristic_flagged']}"
              f" alt_ref_max={e['alt_ref_max_incl_pinned']} alt_flagged={e['alt_flagged']}")
        for r in e["rows"]:
            if not r["discarded"] or r["url"] in ("G1",):
                print("     ", json.dumps(r))
    print("groups at 1:", json.dumps(out["steps"]["1_glance_open"]["ext"]["groups"], ensure_ascii=True))
    print("after_restart_urls", out["after_restart_urls"])
    print("after_restart_groups", json.dumps(out["after_restart_groups"], ensure_ascii=True))
    print("after_restart_chrome", json.dumps(out["after_restart_chrome"]))


if __name__ == "__main__":
    sys.exit(main())
