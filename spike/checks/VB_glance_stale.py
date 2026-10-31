"""VB (adversarial verifier for group B), check 4b follow-up: tabs.query `width` comes from frameLoader.lazyWidth,
which is only refreshed while a browser is rendered. Does that break group B's Glance width heuristic?

Usage: python VB_glance_stale.py <port> <suffix>

  S1 load B, C, P at 1366x768; resize to 1000x700; load D       -> NO Glance open: heuristic false positive?
  S2 resize back; open Glance on D; switch to E (Glance inactive)
  S3 discard every other loose loaded tab; resize to 1000x700   -> Glance inactive and stale: false negative?
  S4 select D (Glance reselected); fullyOpenGlance               -> expanded width
"""
import json
import sys

from B_common import ZenSession, Page, build_b_xpi, chrome_run, make_profile, save_result, val

SEL = "win.gBrowser.selectedTab = byId(args[0]); await sleep(2500); return tt.getId(win.gBrowser.selectedTab);"
RESIZE = "win.resizeTo(args[0], args[1]); await sleep(2500); return [win.outerWidth, win.outerHeight];"


def heur(pg):
    tabs = val(pg.api("tabs.query", {"currentWindow": True}))
    groups = val(pg.api("tabGroups.query", {}))
    empty = {g["id"] for g in groups if g["title"] == ""}
    rows = [{"id": t["id"], "index": t["index"], "active": t["active"], "pinned": t["pinned"], "groupId": t["groupId"],
             "w": t.get("width"), "h": t.get("height"), "url": t["url"].rsplit("/", 1)[-1][:20]}
            for t in tabs if not t["discarded"]]
    ref = [r["w"] for r in rows if not r["pinned"] and r["groupId"] not in empty]
    ref_max = max(ref) if ref else None
    flagged = [r["url"] for r in rows if not r["pinned"] and r["groupId"] == -1 and ref_max and r["w"] < 0.9 * ref_max]
    order = [t["index"] for t in tabs]
    not_inc = [tabs[i]["url"].rsplit("/", 1)[-1][:20] for i in range(1, len(tabs)) if tabs[i]["index"] <= tabs[i - 1]["index"]]
    return {"loaded": rows, "ref_max": ref_max, "width_flagged": flagged, "index_not_increasing": not_inc, "order": order}


def main():
    port = int(sys.argv[1])
    suffix = sys.argv[2]
    out = {"port": port, "steps": {}}
    xpi = build_b_xpi(f"VB-glance-stale-{suffix}")
    prof = make_profile(f"VB-glance-stale-{suffix}", port)
    z = ZenSession(prof, port, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        pg = Page(z)
        ids = {}
        for n in ["P", "B", "C", "D", "E"]:
            ids[n] = val(pg.api("tabs.create", {"url": f"https://example.com/vbgs/{n}", "title": n, "discarded": True,
                                                "active": False}))["id"]
        for n in ["P", "B", "C", "D", "E"]:
            pg.api("tabs.move", ids[n], {"index": -1})
        out["ids"] = ids
        for n in ["B", "C", "P"]:
            chrome_run(z, SEL, [ids[n]])
        out["steps"]["S1a_loaded_B_C_P_at_1366"] = heur(pg)
        out["resize1"] = chrome_run(z, RESIZE, [1000, 700])
        chrome_run(z, SEL, [ids["D"]])
        out["steps"]["S1b_resized_D_loaded_NO_GLANCE"] = heur(pg)

        out["resize2"] = chrome_run(z, RESIZE, [1366, 768])
        out["open_glance"] = chrome_run(z, r"""
            const p = byId(args[0]);
            win.gBrowser.selectedTab = p; await sleep(1500);
            const g = await win.gZenGlanceManager.openGlance({
              url: "https://example.com/vbgs/GL", clientX: 0, clientY: 0, width: 0, height: 0,
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
            await sleep(2500);
            return { glanceExtId: g ? tt.getId(g) : null, selectedIsGlance: win.gBrowser.selectedTab === g };
        """, [ids["D"]])
        gl = out["open_glance"]["glanceExtId"]
        out["steps"]["S2a_glance_open_1366"] = heur(pg)
        chrome_run(z, SEL, [ids["E"]])
        out["steps"]["S2b_switched_to_E"] = heur(pg)

        others = [r["id"] for r in out["steps"]["S2b_switched_to_E"]["loaded"]
                  if not r["pinned"] and r["id"] not in (gl, ids["E"])]
        out["discard"] = {"ids": others, "r": pg.api("tabs.discard", others) if others else None}
        z.ext(pg.h, "sleep", [1000])
        out["resize3"] = chrome_run(z, RESIZE, [1000, 700])
        out["steps"]["S3_glance_inactive_after_resize"] = heur(pg)
        out["truth_S3"] = chrome_run(z, r"""
            const g = byId(args[0]);
            return { glanceAttr: g?.hasAttribute("zen-glance-tab"), connected: !!g?.isConnected,
                     lazyWidth: g?.linkedBrowser?.frameLoader?.lazyWidth, clientWidth: g?.linkedBrowser?.clientWidth };
        """, [gl])

        out["reselect_parent"] = chrome_run(z, SEL, [ids["D"]])
        out["steps"]["S4a_parent_reselected"] = heur(pg)
        out["expand"] = chrome_run(z, r"""
            await win.gZenGlanceManager.fullyOpenGlance(); await sleep(2500);
            const g = byId(args[0]); return { glanceAttr: g.hasAttribute("zen-glance-tab"), selected: win.gBrowser.selectedTab === g };
        """, [gl])
        out["steps"]["S4b_expanded"] = heur(pg)
    except Exception as e:
        out["error"] = repr(e)
        raise
    finally:
        z.quit()
        save_result(f"VB-glance-stale-{suffix}", out)
    for k in ["resize1", "resize2", "open_glance", "discard", "resize3", "truth_S3", "reselect_parent", "expand"]:
        print(k, json.dumps(out.get(k)))
    for name, s in out["steps"].items():
        print(f"== {name}: ref_max={s['ref_max']} width_flagged={s['width_flagged']} index_not_increasing={s['index_not_increasing']}")
        for r in s["loaded"]:
            print("     ", json.dumps(r))


if __name__ == "__main__":
    sys.exit(main())
