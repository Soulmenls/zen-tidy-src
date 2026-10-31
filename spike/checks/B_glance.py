"""Check 4(b): Glance tab lifecycle as seen through extension APIs. Port 2952, profile B-glance.

Steps (setup via chrome scope, observation via extension APIs):
  open glance on P -> index refresh via tabs.move -> switch to another tab -> back to P ->
  close via cmd_zenGlanceClose (user path) -> open + expand (fullyOpenGlance) ->
  open glance on B and tabs.group the GLANCE -> open glance on C and tabs.group the PARENT -> restart.
"""
import json
import sys

from B_common import (ADDON, ZenSession, api, brief_tab, build_b_xpi, chrome_run, ext_snapshot, inspect,
                      make_profile, save_result, val)

PORT = 2952

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
             glanceAttr: g?.hasAttribute("zen-glance-tab"), parentGlanceId: p.getAttribute("glance-id") };
"""


def analyze(snap):
    """Extension-visible signals: order anomalies, active tabs, widths."""
    tabs = snap["ext"]["tabs_query_currentWindow"].get("value", [])
    out = {"order": [(t["id"], t["index"], t["active"], t["discarded"], t.get("width"), t.get("height"),
                      t["groupId"], t["url"][-28:]) for t in tabs]}
    out["index_not_increasing"] = [
        {"id": tabs[i]["id"], "index": tabs[i]["index"], "prev_id": tabs[i - 1]["id"], "prev_index": tabs[i - 1]["index"]}
        for i in range(1, len(tabs)) if tabs[i]["index"] <= tabs[i - 1]["index"]]
    out["active_ids"] = [t["id"] for t in tabs if t["active"]]
    c = snap["chrome"]
    out["chrome_glances"] = [{"extId": t["extId"], "owner": t["ownerExtId"], "selected": t["selected"],
                              "parent": t["parentClass"], "gb": t["gbTabsIndex"]}
                             for t in c.get("tabs", []) if t["glance"]]
    out["chrome_selected"] = c.get("selectedExtId")
    return out


def main():
    out = {"port": PORT}
    xpi = build_b_xpi("B-events-glance")
    prof = make_profile("B-glance", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        ids = {}
        for n in ["A", "P", "B", "C", "D", "E"]:
            ids[n] = val(api(z, h, "tabs.create", {"url": f"https://example.com/glance/{n}", "title": f"Tab {n}",
                                                   "discarded": True, "active": False}))["id"]
        out["ids"] = ids
        snaps = {}

        def snap(name, extra=()):
            snaps[name] = {"ext": ext_snapshot(z, h, extra), "chrome": inspect(z)}
            out.setdefault("analysis", {})[name] = analyze(snaps[name])

        snap("0_baseline")
        out["open1"] = chrome_run(z, OPEN_GLANCE, [ids["P"], "https://example.com/glance/G1"])
        g1 = out["open1"]["glanceExtId"]
        snap("1_glance_open", [g1])

        # Any tab move refreshes Firefox's cached _index for all tabs.
        out["refresh_move"] = api(z, h, "tabs.move", ids["E"], {"index": -1})
        snap("2_after_index_refresh", [g1])

        # User clicks another tab while the Glance is open.
        out["switch_away"] = chrome_run(z, r"""
            win.gBrowser.selectedTab = byId(args[0]); await sleep(2000);
            const g = byId(args[1]);
            return { glanceStillThere: !!g && g.isConnected, glanceAttr: g?.hasAttribute("zen-glance-tab") };
        """, [ids["B"], g1])
        snap("3_switched_away", [g1])

        # User clicks the parent again.
        out["back_to_parent"] = chrome_run(z, r"""
            win.gBrowser.selectedTab = byId(args[0]); await sleep(2500);
            return { selectedExtId: tt.getId(win.gBrowser.selectedTab) };
        """, [ids["P"]])
        snap("4_back_to_parent", [g1])

        # Close the Glance the way the UI does (Escape / close button => cmd_zenGlanceClose).
        out["close_cmd"] = chrome_run(z, r"""
            const g = byId(args[0]);
            if (win.gBrowser.selectedTab !== g) win.gBrowser.selectedTab = g;
            await sleep(500);
            win.document.getElementById("cmd_zenGlanceClose").doCommand();
            for (let i = 0; i < 60 && g.isConnected; i++) await sleep(100);
            await sleep(1000);
            return { glanceRemoved: !g.isConnected, selectedExtId: tt.getId(win.gBrowser.selectedTab) };
        """, [g1])
        snap("5_closed_by_command", [g1])

        # Open + expand (fullyOpenGlance): becomes a normal tab after the parent.
        out["open2"] = chrome_run(z, OPEN_GLANCE, [ids["P"], "https://example.com/glance/G2"])
        g2 = out["open2"]["glanceExtId"]
        out["expand2"] = chrome_run(z, r"""
            await win.gZenGlanceManager.fullyOpenGlance();
            await sleep(2000);
            const g = byId(args[0]);
            return { glanceAttr: g.hasAttribute("zen-glance-tab"), parentClass: g.parentElement.className,
                     selected: win.gBrowser.selectedTab === g };
        """, [g2])
        snap("6_expanded", [g2])

        # Danger probe 1: tabs.group on an open GLANCE tab.
        out["open3"] = chrome_run(z, OPEN_GLANCE, [ids["B"], "https://example.com/glance/G3"])
        g3 = out["open3"]["glanceExtId"]
        snap("7_glance3_open", [g3])
        out["group_glance"] = api(z, h, "tabs.group", {"tabIds": [g3]})
        z.ext(h, "sleep", [1500])
        out["after_group_glance_chrome"] = chrome_run(z, r"""
            const g = byId(args[0]);
            return { glanceAttr: g?.hasAttribute("zen-glance-tab"), glanceId: g?.getAttribute("glance-id"),
                     parentClass: g?.parentElement?.className, group: g?.group?.id ?? null,
                     selected: win.gBrowser.selectedTab === g,
                     overlayOpen: !!win.document.querySelector(".zen-glance-overlay") };
        """, [g3])
        snap("8_after_group_glance", [g3])

        # Danger probe 2: tabs.group on the PARENT of an open Glance.
        out["open4"] = chrome_run(z, OPEN_GLANCE, [ids["C"], "https://example.com/glance/G4"])
        g4 = out["open4"]["glanceExtId"]
        snap("9_glance4_open", [g4])
        out["group_parent"] = api(z, h, "tabs.group", {"tabIds": [ids["C"]]})
        z.ext(h, "sleep", [1500])
        out["after_group_parent_chrome"] = chrome_run(z, r"""
            const g = byId(args[0]); const p = byId(args[1]);
            return { glanceAttr: g?.hasAttribute("zen-glance-tab"), glanceParentEl: g?.parentElement?.className,
                     glanceInsideParent: !!p?.contains(g), parentGroup: p?.group?.id ?? null,
                     glanceGroup: g?.group?.id ?? null, selected: tt.getId(win.gBrowser.selectedTab) };
        """, [g4, ids["C"]])
        snap("10_after_group_parent", [g4])
        out["event_log_before_restart"] = api(z, h, "storage.local.get", "spikeLog")

        z.restart()
        h = z.open_ext_page(ADDON)["handle"]
        snap("11_after_restart", [g1, g2, g3, g4])
        out["glance_ids"] = {"g1": g1, "g2": g2, "g3": g3, "g4": g4}
    finally:
        z.quit()
    out["snaps"] = snaps
    path = save_result("B-glance", out)
    print("saved", path)
    for k, a in out.get("analysis", {}).items():
        print("==", k, "active", a["active_ids"], "chrome_sel", a["chrome_selected"], "glances", a["chrome_glances"])
        print("   not-increasing:", a["index_not_increasing"])
        print("   order:", a["order"])
    for k in ["open1", "switch_away", "back_to_parent", "close_cmd", "open2", "expand2", "open3", "group_glance",
              "after_group_glance_chrome", "open4", "group_parent", "after_group_parent_chrome"]:
        print(k, json.dumps(out.get(k)))


if __name__ == "__main__":
    sys.exit(main())
