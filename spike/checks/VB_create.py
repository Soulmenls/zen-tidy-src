"""VB (adversarial verifier for group B), check 7: tabs.create({discarded:true, url, title, index, active:false})
placement, URL rejections, what a view-source: tab really is, and what a tab created INSIDE a split / group becomes
after a restart. Copy of B_create.py + B_create_split.py with VB port/profile names and extra probes.

Usage: python VB_create.py <port>

Layout: loose A, B, [G1 G2 tidy group], C, [S1 S2 split], D, E  (pinned area: Essential + folder + spike page)
"""
import json
import sys

from B_common import ADDON, SIG, ZenSession, Page, build_b_xpi, chrome_run, make_profile, save_result, val

TAB_TRUTH = r"""
    const t = byId(args[0]);
    let ss = null; try { ss = JSON.parse(SessionStore.getTabState(t)); } catch (e) { ss = { error: String(e) }; }
    return { parentClass: t.parentElement?.className, group: t.group?.id ?? null,
             groupIsSplit: t.group?.hasAttribute("split-view-group") ?? null, splitViewFlag: !!t.splitView,
             pinned: t.pinned, pending: t.hasAttribute("pending"), ws: t.getAttribute("zen-workspace-id"),
             currentURI: t.linkedBrowser?.currentURI?.spec, label: t.label,
             ssEntries: (ss.entries || []).map(e => e.url), ssUserTyped: ss.userTypedValue ?? null,
             gbIndex: win.gBrowser.tabs.indexOf(t),
             inSplitData: (win.gZenViewSplitter._data || []).some(d => d.tabs.includes(t)) };
"""

STATE = r"""
    const res = {};
    for (const t of win.gBrowser.tabs) {
      const u = t.linkedBrowser.currentURI.spec;
      if (!u.includes("/vbc/") && !u.startsWith("view-source:")) continue;
      res[u.startsWith("view-source:") ? u : u.split("/").pop()] = { splitViewFlag: !!t.splitView, group: t.group?.id ?? null,
        groupIsSplit: t.group?.hasAttribute("split-view-group") ?? null, groupLabel: t.group?.label ?? null,
        inSplitData: (win.gZenViewSplitter._data || []).some(d => d.tabs.includes(t)), gbIndex: win.gBrowser.tabs.indexOf(t),
        pending: t.hasAttribute("pending") };
    }
    res._splitData = (win.gZenViewSplitter._data || []).map(d => ({ groupId: d.groupId,
      tabs: d.tabs.map(t => t.linkedBrowser.currentURI.spec.split("/").pop()) }));
    return res;
"""


def query(pg):
    return val(pg.api("tabs.query", {"currentWindow": True}))


def nm(t):
    return t["url"].rsplit("/", 1)[-1][:16]


def layout(pg):
    return [(nm(t), t["index"], t["groupId"] if t["groupId"] != -1 else "", "P" if t["pinned"] else "") for t in query(pg)]


def main():
    port = int(sys.argv[1])
    out = {"port": port, "cases": {}, "rejections": {}}
    xpi = build_b_xpi("VB-create")
    prof = make_profile("VB-create", port)
    z = ZenSession(prof, port, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        pg = Page(z)
        ids = {}
        order = ["A", "B", "G1", "G2", "C", "S1", "S2", "D", "E", "ESS", "F1", "F2"]
        for n in order:
            ids[n] = val(pg.api("tabs.create", {"url": f"https://example.com/vbc/{n}", "title": f"Tab {n}",
                                                "discarded": True, "active": False}))["id"]
        out["default_order_after_creates"] = layout(pg)
        for n in order:
            pg.api("tabs.move", ids[n], {"index": -1})
        out["setup_essential_folder"] = chrome_run(z, r"""
            win.gZenPinnedTabManager.addToEssentials(byId(args[0]));
            const f = win.gZenFolders.createFolder([byId(args[1]), byId(args[2])], { label: "Folder F" });
            await sleep(1000);
            return { folder: f.id };
        """, [ids["ESS"], ids["F1"], ids["F2"]])
        gid = val(pg.api("tabs.group", {"tabIds": [ids["G1"], ids["G2"]]}))
        pg.api("tabGroups.update", gid, {"title": SIG + "Tidy G"})
        out["setup_split"] = chrome_run(z, r"""
            const d = win.gZenViewSplitter.splitTabs([byId(args[0]), byId(args[1])], "grid", -1);
            await sleep(1200);
            return { ok: !!d, groupId: d?.groupId };
        """, [ids["S1"], ids["S2"]])
        z.ext(pg.h, "sleep", [800])
        out["ids"], out["tidy_group"] = ids, gid
        out["layout_before"] = layout(pg)
        out["pref_newtab_top"] = chrome_run(z, 'return Services.prefs.getBoolPref("zen.view.show-newtab-button-top", null);')

        def idx(name, delta=0):
            return next(t["index"] for t in query(pg) if t["id"] == ids[name]) + delta

        def loose_start():
            return min(t["index"] for t in query(pg) if not t["pinned"])

        def end_index():
            return max(t["index"] for t in query(pg)) + 1

        cases = [
            ("c01_loose_start", lambda: loose_start()),
            ("c02_middle_A_B", lambda: idx("B")),
            ("c03_group_leading_edge", lambda: idx("G1")),
            ("c04_inside_group", lambda: idx("G2")),
            ("c05_group_trailing_edge", lambda: idx("G2", 1)),
            ("c06_split_leading_edge", lambda: idx("S1")),
            ("c07_inside_split", lambda: idx("S2")),
            ("c08_split_trailing_edge", lambda: idx("S2", 1)),
            ("c09_end", lambda: end_index()),
            ("c10_huge_9999", lambda: 9999),
            ("c11_no_index", lambda: None),
            ("c12_index_0", lambda: 0),
        ]
        for name, fn in cases:
            requested = fn()
            props = {"url": f"https://example.com/vbc/{name}", "title": f"New {name}", "discarded": True, "active": False}
            if requested is not None:
                props["index"] = requested
            r = pg.api("tabs.create", props)
            rec = {"requested_index": requested, "create_result": {k: r["value"].get(k) for k in ["id", "index", "groupId", "discarded"]}
                   if "value" in r else r}
            if "value" in r:
                nid = r["value"]["id"]
                z.ext(pg.h, "sleep", [300])
                g = val(pg.api("tabs.get", nid))
                rec["tabs_get"] = {k: g.get(k) for k in ["index", "groupId", "discarded", "pinned", "status"]}
                tabs = query(pg)
                pos = next(i for i, t in enumerate(tabs) if t["id"] == nid)
                rec["prev"] = (nm(tabs[pos - 1]), tabs[pos - 1]["index"], tabs[pos - 1]["groupId"]) if pos else None
                rec["next"] = (nm(tabs[pos + 1]), tabs[pos + 1]["index"], tabs[pos + 1]["groupId"]) if pos + 1 < len(tabs) else None
                rec["chrome"] = chrome_run(z, TAB_TRUTH, [nid])
                pg.api("tabs.remove", nid)
                z.ext(pg.h, "sleep", [300])
            out["cases"][name] = rec
        out["layout_after_cases"] = layout(pg)

        # Default position when Zen's "new tab at top" pref is off (throwaway profile only).
        chrome_run(z, 'Services.prefs.setBoolPref("zen.view.show-newtab-button-top", false); return 1;')
        r = pg.api("tabs.create", {"url": "https://example.com/vbc/noindex_pref_off", "title": "x", "discarded": True,
                                   "active": False})
        out["c11b_no_index_pref_off"] = {"result_index": r.get("value", {}).get("index"), "layout": layout(pg)}
        if "value" in r:
            pg.api("tabs.remove", r["value"]["id"])
        chrome_run(z, 'Services.prefs.setBoolPref("zen.view.show-newtab-button-top", true); return 1;')

        rejections = [
            ("r01_about_blank_discarded", {"url": "about:blank", "discarded": True, "active": False}),
            ("r02_about_robots_discarded", {"url": "about:robots", "discarded": True, "active": False}),
            ("r03_about_blank_not_discarded_CONTROL", {"url": "about:blank", "active": False}),
            ("r04_file_discarded", {"url": "file:///C:/Windows/win.ini", "discarded": True, "active": False}),
            ("r05_file_not_discarded", {"url": "file:///C:/Windows/win.ini", "active": False}),
            ("r07_data_discarded", {"url": "data:text/html,hi", "discarded": True, "active": False}),
            ("r08_javascript_discarded", {"url": "javascript:void(0)", "discarded": True, "active": False}),
            ("r09_discarded_active_true", {"url": "https://example.com/vbc/r09", "discarded": True, "active": True}),
            ("r10_discarded_pinned_true", {"url": "https://example.com/vbc/r10", "discarded": True, "pinned": True, "active": False}),
            ("r11_http_localhost_discarded_CONTROL", {"url": "http://127.0.0.1:9/x", "discarded": True, "active": False, "title": "local"}),
            ("r12_title_without_discarded", {"url": "https://example.com/vbc/r12", "title": "x", "active": False}),
            ("r13_about_newtab_discarded", {"url": "about:newtab", "discarded": True, "active": False}),
            ("r14_no_url_discarded", {"discarded": True, "active": False}),
            ("r15_moz_ext_other_discarded", {"url": "moz-extension://00000000-0000-0000-0000-000000000000/x.html", "discarded": True, "active": False}),
        ]
        for name, props in rejections:
            r = pg.api("tabs.create", props)
            out["rejections"][name] = {"props": props, "result": {"error": r["error"]} if "error" in r else
                                       {"ok": True, "url": r["value"]["url"], "discarded": r["value"]["discarded"]}}
            if "value" in r:
                pg.api("tabs.remove", r["value"]["id"])

        # view-source: keep these open, inspect what they really are, and see what the restart restores.
        vs_d = pg.api("tabs.create", {"url": "view-source:https://example.com/vbc/vsd", "title": "vsd", "discarded": True, "active": False})
        vs_n = pg.api("tabs.create", {"url": "view-source:https://example.com/vbc/vsn", "active": False})
        out["vs_discarded"] = vs_d
        out["vs_not_discarded"] = vs_n
        z.ext(pg.h, "sleep", [1500])
        out["vs_discarded_truth"] = chrome_run(z, TAB_TRUTH, [vs_d["value"]["id"]]) if "value" in vs_d else None
        out["vs_not_discarded_truth"] = chrome_run(z, TAB_TRUTH, [vs_n["value"]["id"]]) if "value" in vs_n else None
        out["vs_not_discarded_get"] = pg.api("tabs.get", vs_n["value"]["id"]) if "value" in vs_n else None

        # Keep a tab INSIDE the split and one INSIDE the tidy group, then restart.
        out["keep_inside_split"] = pg.api("tabs.create", {"url": "https://example.com/vbc/NEWSPLIT", "title": "NS",
                                                          "discarded": True, "active": False, "index": idx("S2")})
        out["keep_inside_group"] = pg.api("tabs.create", {"url": "https://example.com/vbc/NEWGROUP", "title": "NG",
                                                          "discarded": True, "active": False, "index": idx("G2")})
        z.ext(pg.h, "sleep", [800])
        out["state_before_restart"] = chrome_run(z, STATE)
        out["layout_before_restart"] = layout(pg)
        z.restart()
        out["state_after_restart"] = chrome_run(z, STATE)
        pg = Page(z)
        out["layout_after_restart"] = layout(pg)
        out["query_after_restart_vs"] = [{k: t.get(k) for k in ["url", "discarded", "title"]} for t in query(pg)
                                         if "vs" in t["url"] or "view-source" in t["url"]]
    except Exception as e:
        out["error"] = repr(e)
        raise
    finally:
        z.quit()
        save_result("VB-create", out)
    print("pref newtab top:", out.get("pref_newtab_top"))
    print("default order after creates:", out["default_order_after_creates"])
    print("layout before:", out["layout_before"])
    for name, rec in out["cases"].items():
        print(f"{name:26} req={rec['requested_index']!s:5} ret={rec['create_result'].get('index')} get={rec.get('tabs_get')}"
              f" prev={rec.get('prev')} next={rec.get('next')} chrome={json.dumps({k: rec.get('chrome', {}).get(k) for k in ['parentClass', 'group', 'groupIsSplit', 'inSplitData', 'ws']})}")
    print("c11b no index pref off:", json.dumps(out["c11b_no_index_pref_off"]))
    for name, rec in out["rejections"].items():
        print(f"{name:40} {json.dumps(rec['result'])}")
    for k in ["vs_discarded", "vs_not_discarded"]:
        v = out[k]
        print(k, json.dumps({kk: v["value"].get(kk) for kk in ["url", "discarded", "status", "title"]} if "value" in v else v))
    print("vs_discarded_truth", json.dumps(out.get("vs_discarded_truth")))
    print("vs_not_discarded_truth", json.dumps(out.get("vs_not_discarded_truth")))
    g = out.get("vs_not_discarded_get") or {}
    print("vs_not_discarded_get", json.dumps({k: g.get("value", {}).get(k) for k in ["url", "status", "discarded", "title"]}))
    for k in ["state_before_restart", "state_after_restart"]:
        print("==", k)
        for n, s in out[k].items():
            print("  ", n, json.dumps(s, ensure_ascii=True))
    print("layout_before_restart", out["layout_before_restart"])
    print("layout_after_restart", out["layout_after_restart"])
    print("query_after_restart_vs", out["query_after_restart_vs"])


if __name__ == "__main__":
    sys.exit(main())
