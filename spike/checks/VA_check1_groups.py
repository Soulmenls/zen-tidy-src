"""Group A, check 1: tabs.group on loose tabs -> unpinned group in the active Space's loose area.

Covers: DOM container, tab.pinned / group.pinned, tabGroups.update(title, collapsed), placement relative to
other loose tabs (before tabIds[0]?), tabGroups.move to the top of the loose area, restart persistence.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VA_common import (TRACER_JS, TRACE_READ_JS, ADDON, SPIKE, ZenSession, api, build_xpi, create_tabs, group_dom, inspect,  # noqa: E402
                      log_entries, loose_summary, make_profile, save_result, val)

PORT = 2961


def short(u):
    # VA: DOM labels of discarded tabs read "New Tab", so identify tabs by URL instead
    return (u or "").replace("https://example.com/", "")


def dom_strip(insp):
    """VA: every tab in gBrowser.tabs order as (url, group-label, pinned)."""
    return [(short(t["url"]), t["pinned"], t["empty"]) for t in insp["allTabs"] if t["kind"] == "tab"]


def brief(insp):
    """Compact view of the loose area order and groups."""
    order = []
    for el in insp["normalOrder"] or []:
        if el["kind"] == "tab":
            order.append(("tab", short(el["url"]), "EMPTY" if el["empty"] else ""))
        else:
            g = group_dom(insp, el["id"])
            order.append(("group", el["id"], el["label"], [short(t["url"]) for t in (g["tabs"] if g else [])]))
    groups = [{k: g[k] for k in ("id", "label", "where", "pinnedProp", "pinnedAttr", "collapsedAttr",
                                  "workspaceAttr", "workspaceEl", "parentClass", "tag")} | {
        "tabs": [(t["label"], t["pinned"]) for t in g["tabs"]]} for g in insp["groups"]]
    return {"activeWorkspace": insp["activeWorkspace"], "normalOrder": order,
            "pinnedOrder": [(e.get("label") or e.get("id")) for e in insp["pinnedOrder"] or []], "groups": groups}


def main():
    out = {"steps": []}

    def step(name, **data):
        try:
            z.ext(h, "bg", [{"type": "mark", "label": name}])
        except Exception:
            pass
        out["steps"].append({"step": name, **data})
        print("==", name, json.dumps(data, ensure_ascii=True)[:1500])

    which = sys.argv[1] if len(sys.argv) > 1 else "variant"
    src = os.path.join(SPIKE, "variants", "VA-events") if which == "variant" else os.path.join(SPIKE, "ext")
    xpi = build_xpi(src, os.path.join(SPIKE, "profiles", "_xpi", f"VA-c1-{which}.xpi"))
    run = sys.argv[2] if len(sys.argv) > 2 else ""
    prof = make_profile(f"VA-c1-{which}{run}", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    z.chrome(TRACER_JS)
    h = None
    try:
        r = z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        step("install", r=r)
        ids = create_tabs(z, h, "c1", 6)
        step("created", ids=ids, loose=loose_summary(z, h), dom=brief(inspect(z)))

        # G1 from two contiguous loose tabs, tabIds[0] is a middle tab.
        tabs = {t["id"]: t for t in val(api(z, h, "tabs.query", {"currentWindow": True}))}
        mid = sorted([i for i in ids], key=lambda i: tabs[i]["index"])  # loose tabs in strip order
        step("strip_order_ids", mid=mid, titles=[tabs[i]["title"] for i in mid])
        g1_ids = [mid[3], mid[2]]  # tabIds[0] = 4th tab in strip order, second arg is the 3rd
        win_id = tabs[mid[0]]["windowId"]
        r = api(z, h, "tabs.group", {"tabIds": g1_ids, "createProperties": {"windowId": win_id}})
        g1 = val(r)
        step("group_g1", tabIds=g1_ids, titles=[tabs[i]["title"] for i in g1_ids], groupId=g1,
             loose=loose_summary(z, h), dom=brief(inspect(z)))

        # update title + collapsed, read back through get
        u1 = api(z, h, "tabGroups.update", g1, {"title": "G1 title", "collapsed": True})
        get1 = api(z, h, "tabGroups.get", g1)
        insp = inspect(z)
        step("update_g1_collapsed", update=u1, get=get1, dom_group=group_dom(insp, g1))
        u2 = api(z, h, "tabGroups.update", g1, {"collapsed": False})
        step("update_g1_expand", update=u2, get=api(z, h, "tabGroups.get", g1))

        # G2: non-contiguous tabs, tabIds[0] is the LAST loose tab, second is the first loose tab.
        g2_ids = [mid[5], mid[0]]
        g2 = val(api(z, h, "tabs.group", {"tabIds": g2_ids, "createProperties": {"windowId": win_id}}))
        api(z, h, "tabGroups.update", g2, {"title": "G2 title"})
        step("group_g2", tabIds=g2_ids, titles=[tabs[i]["title"] for i in g2_ids], groupId=g2,
             loose=loose_summary(z, h), dom=brief(inspect(z)))

        # Move G2 to the top of the loose area: index = min index among unpinned tabs.
        cur = val(api(z, h, "tabs.query", {"currentWindow": True}))
        min_unpinned = min(t["index"] for t in cur if not t["pinned"])
        mv = api(z, h, "tabGroups.move", g2, {"index": min_unpinned})
        step("move_g2_top", minUnpinnedIndex=min_unpinned, move=mv, loose=loose_summary(z, h), dom=brief(inspect(z)))

        # Then G1 to the top too (reverse final order: final = G1, G2, loose...).
        cur = val(api(z, h, "tabs.query", {"currentWindow": True}))
        min_unpinned = min(t["index"] for t in cur if not t["pinned"])
        mv = api(z, h, "tabGroups.move", g1, {"index": min_unpinned})
        step("move_g1_top", minUnpinnedIndex=min_unpinned, move=mv, loose=loose_summary(z, h), dom=brief(inspect(z)))

        out["groups_before"] = val(api(z, h, "tabGroups.query", {}))
        out["tabs_before"] = val(api(z, h, "tabs.query", {"currentWindow": True}))
        out["dom_before"] = inspect(z)

        out["trace_before_restart"] = z.chrome(TRACE_READ_JS)
        z.restart()
        z.chrome(TRACER_JS)
        h = z.open_ext_page(ADDON)["handle"]
        out["groups_after"] = val(api(z, h, "tabGroups.query", {}))
        out["tabs_after"] = val(api(z, h, "tabs.query", {"currentWindow": True}))
        out["dom_after"] = inspect(z)
        step("after_restart", groups=out["groups_after"], loose=loose_summary(z, h), dom=brief(out["dom_after"]))

        # VA extra 1: 3-tab group with tabIds in mixed strip order (middle, last, first)
        xids = create_tabs(z, h, "x", 5)
        tabs = {t["id"]: t for t in val(api(z, h, "tabs.query", {"currentWindow": True}))}
        xs = sorted(xids, key=lambda i: tabs[i]["index"])
        win_id = tabs[xs[0]]["windowId"]
        before_strip = loose_summary(z, h)
        g3_ids = [xs[2], xs[4], xs[0]]
        g3 = val(api(z, h, "tabs.group", {"tabIds": g3_ids, "createProperties": {"windowId": win_id}}))
        api(z, h, "tabGroups.update", g3, {"title": "G3"})
        insp3 = inspect(z)
        step("va_group_g3_mixed", tabIds=g3_ids, titles=[tabs[i]["title"] for i in g3_ids], before=before_strip,
             loose=loose_summary(z, h), domStrip=dom_strip(insp3), dom=brief(insp3))
        # VA extra 2: tabIds[0] = the loose tab directly after an existing group (G2 end) -> must not nest into G2
        cur = val(api(z, h, "tabs.query", {"currentWindow": True}))
        g2_last = max(t["index"] for t in cur if t["groupId"] == g2)
        after_g2 = [t for t in cur if t["index"] == g2_last + 1][0]
        other = [t for t in cur if t["groupId"] == -1 and not t["pinned"] and t["id"] != after_g2["id"]][-1]
        g4_ids = [after_g2["id"], other["id"]]
        g4 = val(api(z, h, "tabs.group", {"tabIds": g4_ids, "createProperties": {"windowId": win_id}}))
        api(z, h, "tabGroups.update", g4, {"title": "G4"})
        insp4 = inspect(z)
        g4dom = group_dom(insp4, g4)
        step("va_group_g4_after_g2", tabIds=g4_ids, titles=[after_g2["title"], other["title"]],
             loose=loose_summary(z, h), domStrip=dom_strip(insp4), dom=brief(insp4),
             g4_parentClass=g4dom["parentClass"] if g4dom else None, g4_where=g4dom["where"] if g4dom else None,
             g2_members=[t["title"] for t in val(api(z, h, "tabs.query", {"currentWindow": True})) if t["groupId"] == g2])

        # Negative probe: what does tabGroups.move into the pinned range (index 0) do?
        g1_after = g1
        mv0 = api(z, h, "tabGroups.move", g1_after, {"index": 0})
        step("probe_move_index0", move=mv0, loose=loose_summary(z, h), dom=brief(inspect(z)),
             get=api(z, h, "tabGroups.get", g1_after))
        if which == "variant":
            z.ext(h, "bg", [{"type": "flush"}])
        out["log"] = log_entries(z, h)
    finally:
        z.quit()

    # Verdicts
    def membership(tabs_list):
        m = {}
        for t in tabs_list:
            if t["groupId"] != -1:
                m.setdefault(t["groupId"], []).append(t["url"])
        return {k: sorted(v) for k, v in m.items()}

    before = {g["id"]: (g["title"], g["collapsed"]) for g in out["groups_before"]}
    after = {g["id"]: (g["title"], g["collapsed"]) for g in out["groups_after"]}
    out["verdict"] = {
        "ids_titles_same": before == after,
        "membership_same": membership(out["tabs_before"]) == membership(out["tabs_after"]),
        "membership_before": membership(out["tabs_before"]),
        "membership_after": membership(out["tabs_after"]),
        "dom_groups_after": [(g["id"], g["label"], g["where"], g["pinnedProp"]) for g in out["dom_after"]["groups"]],
    }
    print(json.dumps(out["verdict"], indent=1))
    print("saved", save_result("VA-check1-groups" + ("" if which == "variant" else "-" + which) + (f"-run{run}" if run else ""), out))


if __name__ == "__main__":
    main()
