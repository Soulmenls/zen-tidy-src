"""VA (adversarial verifier for group A), check 3 stress: does the collapse/restore story hold with ~250 tabs?

Group A tested 3 groups / 8 tabs. Here: 20 SIG groups x 12 tabs + 10 loose tabs (250 tabs), 15 groups collapsed
(12 via API, 3 via the DOM toggle path), one selected tab inside a collapsed group at quit.
Phase A: collapseMode off -> restart -> does Zen still expand everything before the background loads? Any onUpdated?
Phase B: collapseMode restore -> restart -> does the onStartup re-collapse win, and stay collapsed 9 s later?
Phase B2: second restart in restore mode (stability across cycles; the isWindowClosing onRemoved must not wipe state).
Throwaway spike code.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VA_common import (ADDON, SPIKE, ZenSession, api, build_css, build_xpi, create_tabs, group_dom,  # noqa: E402
                       icon_str, inspect, log_entries, make_profile, save_result, screenshot, sig_str, val)

PORT = int(os.environ.get("VA_PORT", "2961"))
RUN = os.environ.get("VA_RUN", "1")
ICONS = {"000": "folder", "001": "code", "012": "book", "432": "star", "444": "globe"}
NG, PER, NLOOSE, NCOLL = 20, 12, 10, 15

USER_COLLAPSE_JS = r"""
const [domId, value, done] = arguments;
const win = Services.wm.getMostRecentWindow("navigator:browser");
const g = win.gBrowser.getTabGroupById(domId);
if (!g) return done({error: "no group " + domId});
g.collapsed = value;
done({collapsed: g.collapsed});
"""

SESSION_GROUPS_JS = r"""
const done = arguments[arguments.length - 1];
const win = Services.wm.getMostRecentWindow("navigator:browser");
const st = JSON.parse(win.SessionStore.getBrowserState());
done((st.windows || []).map(w => (w.groups || []).map(g => ({id: g.id, collapsed: g.collapsed}))));
"""


def api_to_dom_id(gid):
    s = str(gid)
    return f"{s[:-3]}-{int(s[-3:])}"


def main():
    css = build_css(ICONS, collapse_fix=True)
    out = {"steps": [], "config": {"groups": NG, "per": PER, "loose": NLOOSE, "collapsed": NCOLL}}
    xpi = build_xpi(os.path.join(SPIKE, "variants", "VA-events"), os.path.join(SPIKE, "profiles", "_xpi", f"VA-c3s{RUN}.xpi"))
    prof = make_profile(f"VA-c3s{RUN}", PORT, user_chrome_css=css)
    z = ZenSession(prof, PORT, headless=True).launch()
    h = None

    def step(name, **data):
        out["steps"].append({"step": name, "t": time.time(), **data})
        print("==", name, json.dumps(data, ensure_ascii=True)[:1500], flush=True)

    def dom_state(G):
        insp = inspect(z)
        res = {}
        for i, gid in G.items():
            g = group_dom(insp, gid)
            if not g:
                res[i] = None
                continue
            vis = sum(1 for t in g["tabs"] if t["display"] != "none" and t["height"] > 0)
            res[i] = (g["collapsedAttr"], vis, len(g["tabs"]) - vis, sum(1 for t in g["tabs"] if t["selected"]))
        return res

    def api_state(G):
        return {i: val(api(z, h, "tabGroups.get", gid))["collapsed"] for i, gid in G.items()}

    def summarize(dom, apis, want_collapsed):
        bad = []
        for i in dom:
            d = dom[i]
            exp = i in want_collapsed
            if d is None or apis[i] != exp or d[0] != exp:
                bad.append((i, d, apis[i], exp))
            elif exp and d[1] > d[3]:  # collapsed: only selected tabs may stay visible
                bad.append((i, d, apis[i], exp))
        return bad

    try:
        z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        t0 = time.time()
        G, tabs_by_group = {}, {}
        for i in range(NG):
            tabs_by_group[i] = create_tabs(z, h, f"g{i}", PER)
        create_tabs(z, h, "loose", NLOOSE)
        codes = list(ICONS)
        for i in range(NG):
            gid = val(api(z, h, "tabs.group", {"tabIds": tabs_by_group[i]}))
            api(z, h, "tabGroups.update", gid, {"title": sig_str() + icon_str(codes[i % len(codes)]) + f"Group {i}"})
            G[i] = gid
        out["G"] = G
        step("setup", seconds=round(time.time() - t0, 1),
             ntabs=len(val(api(z, h, "tabs.query", {"currentWindow": True}))))

        want = set(range(NCOLL))

        def collapse_all():
            for i in range(NCOLL):
                if i % 5 == 4:   # 3 of 15 through the DOM toggle (user-click path)
                    z.chrome(USER_COLLAPSE_JS, [api_to_dom_id(G[i]), True])
                else:
                    api(z, h, "tabGroups.update", G[i], {"collapsed": True})
            # selected tab inside a collapsed group at quit
            api(z, h, "tabs.update", tabs_by_group[2][5], {"active": True})
            z.ext(h, "sleep", [800])

        # ---- Phase A: mode off
        collapse_all()
        dom, apis = dom_state(G), api_state(G)
        step("A1_collapsed", bad=summarize(dom, apis, want), dom=dom)
        step("A2_session_before", session=z.chrome(SESSION_GROUPS_JS))
        z.restart()
        h = z.open_ext_page(ADDON)["handle"]
        dom, apis = dom_state(G), api_state(G)
        step("A3_after_restart_mode_off", n_collapsed_api=sum(apis.values()),
             n_expanded_api=sum(1 for v in apis.values() if not v), dom=dom,
             session=z.chrome(SESSION_GROUPS_JS))

        # ---- Phase B: mode restore
        api(z, h, "storage.local.set", {"collapseMode": "restore", "collapsedById": {}})
        z.ext(h, "sleep", [3500])
        api(z, h, "tabs.update", [t for t in val(api(z, h, "tabs.query", {"currentWindow": True}))
                                  if t["url"].startswith("moz-extension")][0]["id"], {"active": True})
        collapse_all()
        st = z.ext(h, "bg", [{"type": "state"}])
        dom, apis = dom_state(G), api_state(G)
        step("B1_collapsed_saved", saved_count=len(st["value"]["saved"]), saved_true=sum(st["value"]["saved"].values()),
             bad=summarize(dom, apis, want))
        for cycle in (1, 2):
            z.restart()
            h = z.open_ext_page(ADDON)["handle"]
            dom, apis = dom_state(G), api_state(G)
            step(f"B{cycle}_early", bad=summarize(dom, apis, want), dom=dom)
            z.ext(h, "sleep", [9000])
            dom, apis = dom_state(G), api_state(G)
            st = z.ext(h, "bg", [{"type": "state"}])
            step(f"B{cycle}_settled", bad=summarize(dom, apis, want), saved_true=sum(st["value"]["saved"].values()),
                 saved_count=len(st["value"]["saved"]))
        out["shot"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", f"VA-check3s-run{RUN}.png"))
        z.ext(h, "bg", [{"type": "flush"}])
        out["log"] = log_entries(z, h)
    finally:
        z.quit()

    # log analysis per background lifetime
    lives, cur = [], None
    for e in out["log"]:
        if e["event"] == "bgLoaded":
            cur = {"bgLoaded": e["t"], "events": []}
            lives.append(cur)
        elif cur is not None:
            cur["events"].append(e)
    analysis = []
    for life in lives:
        ev = life["events"]
        first = next((e for e in ev if e["event"] in ("onStartup", "onInstalled")), None)
        upd = [e for e in ev if e["event"] == "tabGroups.onUpdated"]
        startup_mode = next((e for e in ev if e["event"] == "startup.mode"), None)
        applies = [{"label": e["label"], "sinceBg": e["sinceBg"],
                    "was_false": sum(1 for x in e["out"] if x.get("was") is False),
                    "errors": sum(1 for x in e["out"] if "error" in x)} for e in ev if e["event"] == "apply"]
        analysis.append({
            "first": first and {k: first.get(k) for k in ("event", "sinceBg", "droppedBuffered", "reason")},
            "startup_snapshot_collapsed": startup_mode and sum(1 for g in startup_mode["groups"] if g["collapsed"]),
            "startup_snapshot_sinceBg": startup_mode and startup_mode["sinceBg"],
            "onUpdated_unsuppressed_collapsed_false": [(e["id"], e["sinceBg"], e["phase"]) for e in upd
                                                       if not e["collapsed"] and not e["suppressed"]],
            "onUpdated_total": len(upd),
            "onUpdated_before_startup": [(e["id"], e["collapsed"], e["sinceBg"]) for e in upd
                                         if first is None or e["t"] < first["t"]],
            "onRemoved": [(e["info"]) for e in ev if e["event"] == "tabGroups.onRemoved"][:2],
            "onRemoved_count": sum(1 for e in ev if e["event"] == "tabGroups.onRemoved"),
            "applies": applies,
        })
    out["analysis"] = analysis
    print(json.dumps(analysis, indent=1, ensure_ascii=True))
    print("saved", save_result(f"VA-check3s-stress-run{RUN}", out))


if __name__ == "__main__":
    main()
