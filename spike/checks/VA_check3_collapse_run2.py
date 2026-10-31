"""Group A, check 3: collapse.

Phase A (collapseMode off): collapse fix hides tabs of collapsed SIG groups; plain group (no fix) = positive
control; selected-tab exception; restart -> does Zen re-expand collapsed groups on restore? (+ event log)
Phase B (collapseMode restore): variant background saves user collapse state per group id and re-applies it on
runtime.onStartup (immediately and after settle delays); restart -> prove collapsed.
Phase C: re-tidy via tabs.group({groupId}) into a collapsed group: does Zen expand? Can the extension re-collapse?
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VA_common import (ADDON, SPIKE, TRACE_READ_JS, TRACER_JS, ZenSession, api, build_css, build_xpi,  # noqa: E402
                      create_tabs, group_dom, icon_str, inspect, log_entries, make_profile, save_result, screenshot,
                      sig_str, val)

PORT = 2965
ICONS = {"000": "folder", "001": "code", "012": "book", "432": "star", "444": "globe"}

SESSION_GROUPS_JS = r"""
const done = arguments[arguments.length - 1];
const win = Services.wm.getMostRecentWindow("navigator:browser");
const st = JSON.parse(win.SessionStore.getBrowserState());
done((st.windows || []).map(w => (w.groups || []).map(g => ({id: g.id, name: g.name, collapsed: g.collapsed}))));
"""

USER_COLLAPSE_JS = r"""
const [domId, value, done] = arguments;
const win = Services.wm.getMostRecentWindow("navigator:browser");
const g = win.gBrowser.getTabGroupById(domId);
if (!g) return done({error: "no group " + domId});
g.collapsed = value;   // what a click on the group label does (MozTabbrowserTabGroup.on_click toggles .collapsed)
done({collapsed: g.collapsed, attr: g.hasAttribute("collapsed")});
"""


def api_to_dom_id(gid):
    s = str(gid)
    return f"{s[:-3]}-{int(s[-3:])}"


def gstate(insp, gid):
    g = group_dom(insp, gid)
    if not g:
        return None
    return {"label": g["label"], "collapsedAttr": g["collapsedAttr"],
            "tabs": [(t["label"], t["selected"], t["display"], t["height"]) for t in g["tabs"]],
            "visible_tabs": sum(1 for t in g["tabs"] if t["display"] != "none" and t["height"] > 0),
            "hidden_tabs": sum(1 for t in g["tabs"] if t["display"] == "none" or t["height"] == 0)}


def main():
    css = build_css(ICONS, collapse_fix=True)
    out = {"css": css, "steps": []}
    xpi = build_xpi(os.path.join(SPIKE, "variants", "VA-events"), os.path.join(SPIKE, "profiles", "_xpi", "VA-c3r2.xpi"))
    prof = make_profile("VA-c3r2", PORT, user_chrome_css=css)
    z = ZenSession(prof, PORT, headless=True).launch()
    z.chrome(TRACER_JS)
    h = None

    def mark(label):
        z.ext(h, "bg", [{"type": "mark", "label": label}])

    def step(name, **data):
        out["steps"].append({"step": name, "t": time.time(), **data})
        print("==", name, json.dumps(data, ensure_ascii=True)[:2500])

    def snap(gids):
        insp = inspect(z)
        return {k: gstate(insp, g) for k, g in gids.items()}, {
            k: val(api(z, h, "tabGroups.get", g)) for k, g in gids.items()}

    try:
        z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        t_alpha = create_tabs(z, h, "alpha", 3)
        t_beta = create_tabs(z, h, "beta", 2)
        t_plain = create_tabs(z, h, "plain", 2)
        create_tabs(z, h, "loose", 1)
        G = {}
        G["alpha"] = val(api(z, h, "tabs.group", {"tabIds": t_alpha}))
        api(z, h, "tabGroups.update", G["alpha"], {"title": sig_str() + icon_str("001") + "Alpha"})
        G["beta"] = val(api(z, h, "tabs.group", {"tabIds": t_beta}))
        api(z, h, "tabGroups.update", G["beta"], {"title": sig_str() + icon_str("012") + "Beta"})
        G["plain"] = val(api(z, h, "tabs.group", {"tabIds": t_plain}))
        api(z, h, "tabGroups.update", G["plain"], {"title": "Plain"})
        out["G"] = G
        dom, apis = snap(G)
        step("A0_expanded", dom=dom)

        # ---- Phase A: collapse via API (alpha, plain) and via user-like DOM toggle (beta)
        mark("A1_collapse")
        api(z, h, "tabGroups.update", G["alpha"], {"collapsed": True})
        api(z, h, "tabGroups.update", G["plain"], {"collapsed": True})
        out["user_collapse_beta"] = z.chrome(USER_COLLAPSE_JS, [api_to_dom_id(G["beta"]), True])
        z.ext(h, "sleep", [400])
        dom, apis = snap(G)
        step("A1_collapsed", dom=dom, api={k: v["collapsed"] for k, v in apis.items()},
             user_collapse=out["user_collapse_beta"])
        out["shot_A1"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", "VA-check3-run2-A1-collapsed.png"))

        # selected-tab exception: activate a tab inside collapsed beta
        mark("A2_select_in_collapsed")
        api(z, h, "tabs.update", t_beta[1], {"active": True})
        z.ext(h, "sleep", [600])
        dom, apis = snap(G)
        step("A2_selected_in_collapsed_beta", dom={"beta": dom["beta"]}, api_beta=apis["beta"])
        # re-select the extension page so later steps start from a neutral selection
        page_tab = [t for t in val(api(z, h, "tabs.query", {"currentWindow": True})) if t["url"].startswith("moz-extension")][0]
        api(z, h, "tabs.update", page_tab["id"], {"active": True})
        z.ext(h, "sleep", [400])
        dom, apis = snap(G)
        step("A3_after_reselect_page", dom=dom, api={k: v["collapsed"] for k, v in apis.items()})
        # make sure all three are collapsed before the restart
        for k in G:
            if not apis[k]["collapsed"]:
                api(z, h, "tabGroups.update", G[k], {"collapsed": True})
        out["session_before_restartA"] = z.chrome(SESSION_GROUPS_JS)
        step("A4_before_restart", session=out["session_before_restartA"])
        out["trace_A"] = z.chrome(TRACE_READ_JS)

        z.restart()
        z.chrome(TRACER_JS)
        h = z.open_ext_page(ADDON)["handle"]
        dom, apis = snap(G)
        out["session_after_restartA"] = z.chrome(SESSION_GROUPS_JS)
        step("A5_after_restart_mode_off", dom=dom, api={k: v["collapsed"] for k, v in apis.items()},
             session=out["session_after_restartA"])

        # ---- Phase B: enable persistence, collapse again (user-like for beta), restart
        api(z, h, "storage.local.set", {"collapseMode": "restore", "collapsedById": {}})
        z.ext(h, "sleep", [3500])  # let the post-startup settle window (if any) pass
        mark("B1_collapse_mode_restore")
        api(z, h, "tabGroups.update", G["alpha"], {"collapsed": True})
        api(z, h, "tabGroups.update", G["plain"], {"collapsed": True})
        z.chrome(USER_COLLAPSE_JS, [api_to_dom_id(G["beta"]), True])
        z.ext(h, "sleep", [500])
        state = z.ext(h, "bg", [{"type": "state"}])
        dom, apis = snap(G)
        step("B1_collapsed_saved", state=state, api={k: v["collapsed"] for k, v in apis.items()}, dom=dom)
        out["trace_A_after"] = z.chrome(TRACE_READ_JS)
        z.restart()
        z.chrome(TRACER_JS)
        h = z.open_ext_page(ADDON)["handle"]
        early_dom, early_api = snap(G)
        step("B2_after_restart_early", dom=early_dom, api={k: v["collapsed"] for k, v in early_api.items()})
        z.ext(h, "sleep", [9000])
        dom, apis = snap(G)
        state = z.ext(h, "bg", [{"type": "state"}])
        step("B3_after_restart_settled", dom=dom, api={k: v["collapsed"] for k, v in apis.items()}, state=state)
        out["shot_B3"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", "VA-check3-run2-B3-restored.png"))

        # ---- Phase C: re-tidy into collapsed groups
        new_tabs = create_tabs(z, h, "retidy", 2)
        tabs_now = {t["id"]: t for t in val(api(z, h, "tabs.query", {"currentWindow": True}))}
        alpha_first = min(t["index"] for t in tabs_now.values() if t["groupId"] == G["alpha"])
        step("C0_positions", new_tab_index=tabs_now[new_tabs[0]]["index"], alpha_first_index=alpha_first)
        mark("C1_retidy_alpha_recollapse")
        r1 = z.ext(h, "bg", [{"type": "retidy", "tabIds": [new_tabs[0]], "groupId": G["alpha"], "recollapse": True}])
        z.ext(h, "sleep", [2000])
        dom, apis = snap(G)
        step("C1_retidy_alpha_with_recollapse", result=r1, dom={"alpha": dom["alpha"]}, api_alpha=apis["alpha"])
        mark("C2_retidy_beta_no_recollapse")
        r2 = z.ext(h, "bg", [{"type": "retidy", "tabIds": [new_tabs[1]], "groupId": G["beta"], "recollapse": False}])
        z.ext(h, "sleep", [2000])
        dom, apis = snap(G)
        step("C2_retidy_beta_no_recollapse", result=r2, dom={"beta": dom["beta"]}, api_beta=apis["beta"])
        state = z.ext(h, "bg", [{"type": "state"}])
        step("C3_state_after_retidy", state=state)
        out["trace_C"] = z.chrome(TRACE_READ_JS)
        z.ext(h, "bg", [{"type": "flush"}])
        out["log"] = log_entries(z, h)
    finally:
        z.quit()
    print("saved", save_result("VA-check3-collapse-run2", out))


if __name__ == "__main__":
    main()
