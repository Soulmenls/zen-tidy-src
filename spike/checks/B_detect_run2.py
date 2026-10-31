"""Run 2 (reproducibility, port 2956) of B_detect.py. Check 4: detect split views, Zen folders, Essentials and Glance tabs through extension APIs only.

Setup through chrome scope (gZenViewSplitter.splitTabs, gZenFolders.createFolder,
gZenPinnedTabManager.addToEssentials, gZenGlanceManager.openGlance); then record what tabs.query,
tabs.get and tabGroups.query report. Port 2952, profile B-detect.
"""
import json
import sys

from B_common import (ADDON, SIG, ZenSession, api, brief_group, brief_tab, build_b_xpi, chrome_run, ext_snapshot,
                      inspect, make_profile, save_result, val)

PORT = 2956


def main():
    out = {"port": PORT}
    xpi = build_b_xpi("B-events-detect2")
    prof = make_profile("B-detect2", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["page"] = page

        names = ["L1", "S1", "S2", "L2", "F1", "F2", "E1", "P", "L3", "U1", "U2", "T1", "T2"]
        ids = {}
        for n in names:
            r = api(z, h, "tabs.create", {"url": f"https://example.com/detect/{n}", "title": f"Tab {n}",
                                          "discarded": True, "active": False})
            ids[n] = val(r)["id"]
        out["ids"] = ids

        # Controls: an unnamed user group made by the extension, and a tidy-style group.
        out["unnamed_group"] = api(z, h, "tabs.group", {"tabIds": [ids["U1"], ids["U2"]]})
        out["tidy_group"] = api(z, h, "tabs.group", {"tabIds": [ids["T1"], ids["T2"]]})
        tidy_gid = out["tidy_group"].get("value")
        out["tidy_update"] = api(z, h, "tabGroups.update", tidy_gid, {"title": SIG + "Tidy"})
        # A user group explicitly titled "" vs. one titled with a lone U+200B (what Zen gives split groups?).
        out["snap0_baseline"] = {"ext": ext_snapshot(z, h), "chrome": inspect(z)}

        # 1) Split view of S1 + S2 (activates the split, selecting S1).
        out["setup_split"] = chrome_run(z, r"""
            const [s1, s2] = [byId(args[0]), byId(args[1])];
            const data = win.gZenViewSplitter.splitTabs([s1, s2], "grid", 0);
            await sleep(1500);
            return { ok: !!data, groupId: data?.groupId, splitViewFlags: [s1.splitView, s2.splitView],
                     selected: win.gBrowser.selectedTab === s1 };
        """, [ids["S1"], ids["S2"]])
        out["snap1_split_active"] = {"ext": ext_snapshot(z, h), "chrome": inspect(z)}

        # 2) Zen folder with F1 + F2.
        out["setup_folder"] = chrome_run(z, r"""
            const tabs = [byId(args[0]), byId(args[1])];
            const folder = win.gZenFolders.createFolder(tabs, { label: "Folder X" });
            await sleep(1000);
            return { id: folder.id, tag: folder.tagName, label: folder.label, pinned: tabs.map(t => t.pinned) };
        """, [ids["F1"], ids["F2"]])

        # 3) Essential E1.
        out["setup_essential"] = chrome_run(z, r"""
            const t = byId(args[0]);
            const r = win.gZenPinnedTabManager.addToEssentials(t);
            await sleep(1000);
            return { ret: String(r), essential: t.hasAttribute("zen-essential"), pinned: t.pinned };
        """, [ids["E1"]])

        # 4) Glance from P: select P (a plain loose tab), then open a Glance on it.
        out["setup_glance"] = chrome_run(z, r"""
            const p = byId(args[0]);
            win.gBrowser.selectedTab = p;
            await sleep(1500);
            const glanceTab = await win.gZenGlanceManager.openGlance({
              url: "https://example.com/detect/glance", clientX: 0, clientY: 0, width: 0, height: 0,
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            });
            await sleep(2500);
            return { glanceExtId: glanceTab ? tt.getId(glanceTab) : null,
                     selectedIsGlance: win.gBrowser.selectedTab === glanceTab,
                     parentSelectedAttr: p.selected, parentHasGlanceId: p.getAttribute("glance-id"),
                     glanceParentTag: glanceTab?.parentElement?.className };
        """, [ids["P"]])
        glance_id = out["setup_glance"].get("glanceExtId")
        out["snap2_all_special"] = {"ext": ext_snapshot(z, h, [glance_id] if glance_id else []), "chrome": inspect(z)}

        # Re-read a second time after a pause to rule out a transient state.
        api(z, h, "tabs.query", {})
        z.ext(h, "sleep", [2000])
        out["snap2b_all_special_again"] = {"ext": ext_snapshot(z, h, [glance_id] if glance_id else []),
                                           "chrome": inspect(z)}

        # 5) Close the Glance and confirm the tab disappears.
        out["close_glance"] = chrome_run(z, r"""
            await win.gZenGlanceManager.closeGlance({ noAnimation: true, onTabClose: true, skipPermitUnload: true });
            await sleep(2000);
            return { selectedUrl: win.gBrowser.selectedTab.linkedBrowser.currentURI.spec };
        """)
        out["snap3_glance_closed"] = {"ext": ext_snapshot(z, h, [glance_id] if glance_id else []),
                                      "chrome": inspect(z)}

        # 6) Glance opened from a SPLIT tab is out of scope; but a Glance on an Essential? Glance from L2 again
        # with the split NOT active, to check the "two active tabs" signal a second time.
        out["setup_glance2"] = chrome_run(z, r"""
            const p = byId(args[0]);
            win.gBrowser.selectedTab = p;
            await sleep(1500);
            const g = await win.gZenGlanceManager.openGlance({
              url: "https://example.com/detect/glance2", clientX: 0, clientY: 0, width: 0, height: 0,
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            });
            await sleep(2500);
            return { glanceExtId: g ? tt.getId(g) : null };
        """, [ids["L2"]])
        g2 = out["setup_glance2"].get("glanceExtId")
        out["snap4_glance2"] = {"ext": ext_snapshot(z, h, [g2] if g2 else []), "chrome": inspect(z)}

        out["event_log"] = api(z, h, "storage.local.get", "spikeLog")
    finally:
        z.quit()

    path = save_result("B-detect-run2", out)
    print("saved", path)
    summarize(out)


def summarize(out):
    def show(label, snap):
        e = snap["ext"]
        print(f"\n== {label}")
        if "error" in snap["chrome"]:
            print("chrome error", snap["chrome"])
        print(" tabs.query(currentWindow):")
        for t in e["tabs_query_currentWindow"].get("value", []):
            print("  ", json.dumps(brief_tab(t), ensure_ascii=True))
        print(" tabGroups.query:")
        for g in e["tabGroups_query"].get("value", []):
            print("  ", json.dumps(brief_group(g), ensure_ascii=True))
    for k in ["snap1_split_active", "snap2_all_special", "snap3_glance_closed", "snap4_glance2"]:
        if k in out:
            show(k, out[k])
    for k in ["setup_split", "setup_folder", "setup_essential", "setup_glance", "close_glance", "setup_glance2"]:
        print(k, json.dumps(out.get(k), ensure_ascii=True))


if __name__ == "__main__":
    sys.exit(main())
