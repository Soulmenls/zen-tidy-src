"""Check 7: tabs.create({discarded:true, url, title, index, active:false}) placement and URL rejections.
Port 2956, profile B-create.

Layout (pinned area: Essential + folder + pinned spike page):
  loose: A, B, [G: G1, G2 (tidy group)], C, [S: S1, S2 (Zen split)], D, E
Each case computes its index from a FRESH tabs.query, creates one discarded tab, then records the returned
tab, a re-read via tabs.get, its neighbours in tabs.query order, and chrome ground truth (DOM parent, group).
"""
import json
import sys

from B_common import (ADDON, SIG, ZenSession, api, build_b_xpi, chrome_run, ext_snapshot, inspect, make_profile,
                      save_result, val)

PORT = 2956

TAB_TRUTH = r"""
    const t = byId(args[0]);
    return { parentClass: t.parentElement?.className, group: t.group?.id ?? null,
             groupIsSplit: t.group?.hasAttribute("split-view-group") ?? null, splitViewFlag: !!t.splitView,
             pinned: t.pinned, pending: t.hasAttribute("pending"), ws: t.getAttribute("zen-workspace-id"),
             gbIndex: win.gBrowser.tabs.indexOf(t), inSplitData: (win.gZenViewSplitter._data || []).some(d => d.tabs.includes(t)),
             browserLoaded: !!t.linkedBrowser?.browsingContext?.currentWindowGlobal };
"""


def query(z, h):
    return val(api(z, h, "tabs.query", {"currentWindow": True}))


def names_by_id(tabs):
    return {t["id"]: t["url"].rsplit("/", 1)[-1] for t in tabs}


def layout(z, h):
    tabs = query(z, h)
    return [(t["url"].rsplit("/", 1)[-1][:14], t["index"], t["groupId"] if t["groupId"] != -1 else "", "P" if t["pinned"] else "")
            for t in tabs]


def main():
    out = {"port": PORT, "cases": {}, "rejections": {}}
    xpi = build_b_xpi("B-events-create")
    prof = make_profile("B-create", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        ids = {}
        order = ["A", "B", "G1", "G2", "C", "S1", "S2", "D", "E", "ESS", "F1", "F2"]
        for n in order:
            ids[n] = val(api(z, h, "tabs.create", {"url": f"https://example.com/create/{n}", "title": f"Tab {n}",
                                                   "discarded": True, "active": False}))["id"]
        # Zen inserts new tabs at the TOP of the loose area; record that, then move into the wanted order.
        out["default_order_after_creates"] = layout(z, h)
        for n in order:
            api(z, h, "tabs.move", ids[n], {"index": -1})
        out["setup_essential_folder"] = chrome_run(z, r"""
            win.gZenPinnedTabManager.addToEssentials(byId(args[0]));
            const f = win.gZenFolders.createFolder([byId(args[1]), byId(args[2])], { label: "Folder F" });
            await sleep(1000);
            return { folder: f.id };
        """, [ids["ESS"], ids["F1"], ids["F2"]])
        gid = val(api(z, h, "tabs.group", {"tabIds": [ids["G1"], ids["G2"]]}))
        api(z, h, "tabGroups.update", gid, {"title": SIG + "Tidy G"})
        out["setup_split"] = chrome_run(z, r"""
            const d = win.gZenViewSplitter.splitTabs([byId(args[0]), byId(args[1])], "grid", -1);
            await sleep(1200);
            return { ok: !!d, groupId: d?.groupId };
        """, [ids["S1"], ids["S2"]])
        z.ext(h, "sleep", [800])
        tabs = query(z, h)
        sgid = next(t["groupId"] for t in tabs if t["id"] == ids["S1"])
        out["ids"], out["tidy_group"], out["split_group"] = ids, gid, sgid
        out["layout_before"] = layout(z, h)
        out["snap_before"] = {"ext": ext_snapshot(z, h), "chrome": inspect(z)}

        def idx(name, delta=0):
            return next(t["index"] for t in query(z, h) if t["id"] == ids[name]) + delta

        def loose_start():
            return min(t["index"] for t in query(z, h) if not t["pinned"])

        def end_index():
            return max(t["index"] for t in query(z, h)) + 1

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
            ("c12_index_0_pinned_area", lambda: 0),
            ("c13_index_of_pinned_spike_page", lambda: next(t["index"] for t in query(z, h)
                                                             if t["url"].startswith("moz-extension:"))),
        ]
        for name, fn in cases:
            requested = fn()
            props = {"url": f"https://example.com/create/{name}", "title": f"New {name}", "discarded": True,
                     "active": False}
            if requested is not None:
                props["index"] = requested
            before = layout(z, h)
            r = api(z, h, "tabs.create", props)
            rec = {"requested_index": requested, "create_result": r, "layout_before": before}
            if "value" in r:
                nid = r["value"]["id"]
                z.ext(h, "sleep", [300])
                rec["tabs_get"] = api(z, h, "tabs.get", nid)
                tabs = query(z, h)
                pos = next(i for i, t in enumerate(tabs) if t["id"] == nid)
                nm = names_by_id(tabs)
                rec["prev"] = (nm[tabs[pos - 1]["id"]], tabs[pos - 1]["index"], tabs[pos - 1]["groupId"]) if pos else None
                rec["next"] = ((nm[tabs[pos + 1]["id"]], tabs[pos + 1]["index"], tabs[pos + 1]["groupId"])
                               if pos + 1 < len(tabs) else None)
                rec["chrome"] = chrome_run(z, TAB_TRUTH, [nid])
                rec["layout_after"] = layout(z, h)
                # Remove the probe so every case starts from the same layout.
                rec["remove"] = api(z, h, "tabs.remove", nid)
                z.ext(h, "sleep", [300])
            out["cases"][name] = rec

        rejections = [
            ("r01_about_blank_discarded", {"url": "about:blank", "discarded": True, "active": False}),
            ("r02_about_robots_discarded", {"url": "about:robots", "discarded": True, "active": False}),
            ("r03_about_blank_not_discarded_CONTROL", {"url": "about:blank", "active": False}),
            ("r04_file_discarded", {"url": "file:///C:/Windows/win.ini", "discarded": True, "active": False}),
            ("r05_file_not_discarded", {"url": "file:///C:/Windows/win.ini", "active": False}),
            ("r06_view_source_discarded", {"url": "view-source:https://example.com/", "discarded": True, "active": False}),
            ("r07_data_discarded", {"url": "data:text/html,hi", "discarded": True, "active": False}),
            ("r08_javascript_discarded", {"url": "javascript:void(0)", "discarded": True, "active": False}),
            ("r09_discarded_active_true", {"url": "https://example.com/create/r09", "discarded": True, "active": True}),
            ("r10_discarded_pinned_true", {"url": "https://example.com/create/r10", "discarded": True, "pinned": True,
                                           "active": False}),
            ("r11_http_localhost_discarded_CONTROL", {"url": "http://127.0.0.1:9/x", "discarded": True, "active": False,
                                                      "title": "local"}),
            ("r12_title_without_discarded", {"url": "https://example.com/create/r12", "title": "x", "active": False}),
            ("r13_about_newtab_discarded", {"url": "about:newtab", "discarded": True, "active": False}),
            ("r14_no_url_discarded", {"discarded": True, "active": False}),
        ]
        for name, props in rejections:
            r = api(z, h, "tabs.create", props)
            out["rejections"][name] = {"props": props, "result": {"error": r["error"]} if "error" in r else
                                       {"ok": True, "id": r["value"]["id"], "url": r["value"]["url"],
                                        "discarded": r["value"]["discarded"], "title": r["value"]["title"]}}
            if "value" in r:
                api(z, h, "tabs.remove", r["value"]["id"])
        out["layout_end"] = layout(z, h)
        out["event_log"] = api(z, h, "storage.local.get", "spikeLog")
    finally:
        z.quit()
    path = save_result("B-create", out)
    print("saved", path)
    print("default order after creates:", out["default_order_after_creates"])
    print("layout before:", out["layout_before"])
    for name, rec in out["cases"].items():
        r = rec["create_result"].get("value", rec["create_result"])
        g = rec.get("tabs_get", {}).get("value", {})
        print(f"{name:32} req={rec['requested_index']!s:5} ret_idx={r.get('index')} get_idx={g.get('index')} "
              f"grp={g.get('groupId')} pinned={g.get('pinned')} disc={g.get('discarded')} prev={rec.get('prev')} "
              f"next={rec.get('next')} chrome={json.dumps(rec.get('chrome'))}")
    for name, rec in out["rejections"].items():
        print(f"{name:40} {json.dumps(rec['result'])}")


if __name__ == "__main__":
    sys.exit(main())
