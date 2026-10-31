"""VB (adversarial verifier for group B), check 8b: do discarded tabs created by tabs.create keep their Space
across a restart? Copy of B_spaces_ws.py with VB ports/profiles plus extra controls.

Usage: python VB_spaces_ws.py <quit_in: A|B> <port>

Space A gets (via extension APIs): A_disc (discarded), A_live (not discarded), A_grp1/A_grp2 (discarded, SIG group),
A_lg1/A_lg2 (NOT discarded, SIG group: control for grouping), A_warm (discarded + tabs.warmup).
Space B gets B_disc (discarded) and B_live (not discarded).
Restart 1 with Space <quit_in> active. Then switch to the OTHER Space and restart again (restart 2): checks that
tabs restored from the session (now carrying zen-workspace-id) stay put.
"""
import json
import sys

from B_common import ADDON, SIG, ZenSession, api, build_b_xpi, chrome_run, ext_handle, Page, make_profile, save_result, val

WS_STATE = r"""
    const res = { active: win.gZenWorkspaces.activeWorkspace, tabs: {} };
    for (const t of win.gZenWorkspaces.allStoredTabs) {
      const u = t.linkedBrowser?.currentURI?.spec || "";
      if (!u.includes("/vbws/")) continue;
      res.tabs[u.split("/").pop()] = { wsAttr: t.getAttribute("zen-workspace-id"),
        containerWs: t.closest("zen-workspace")?.id ?? null, group: t.group?.id ?? null,
        groupLabel: t.group?.label ?? null, groupWsContainer: t.group?.closest("zen-workspace")?.id ?? null,
        pending: t.hasAttribute("pending"), inVisibleTabs: win.gBrowser.tabs.includes(t) };
    }
    const state = JSON.parse(SessionStore.getBrowserState());
    res.session = [];
    for (const w of state.windows) for (const t of w.tabs) {
      const e = t.entries?.[t.index - 1] || t.entries?.[0] || {};
      const u = e.url || t.userTypedValue || "";
      if (u.includes("/vbws/")) res.session.push({ name: u.split("/").pop(), zenWorkspace: t.zenWorkspace ?? null });
    }
    res.sessionGroups = state.windows.flatMap(w => (w.groups || []).map(g => ({ name: g.name,
      zenWorkspace: g.zenWorkspace ?? g.workspaceId ?? null })));
    return res;
"""

SWITCH = "await win.gZenWorkspaces.changeWorkspaceWithID(args[0]); await sleep(2000); return win.gZenWorkspaces.activeWorkspace;"


def q_names(pg):
    return [t["url"].rsplit("/", 1)[-1] for t in val(pg.api("tabs.query", {"currentWindow": True})) if "/vbws/" in t["url"]]


def main():
    quit_in = sys.argv[1]
    port = int(sys.argv[2])
    out = {"quit_in": quit_in, "port": port}
    xpi = build_b_xpi(f"VB-ws-{quit_in}")
    prof = make_profile(f"VB-ws-quit{quit_in}", port)
    z = ZenSession(prof, port, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        h = ext_handle(z)
        page = z.open_ext_page(ADDON)
        out["page_to_essential"] = chrome_run(z, r"""
            const t = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === args[0]);
            win.gZenPinnedTabManager.addToEssentials(t); await sleep(800);
            return { spaceA: win.gZenWorkspaces.activeWorkspace, essential: t.hasAttribute("zen-essential") };
        """, [page["url"]])
        space_a = out["page_to_essential"]["spaceA"]
        ids = {}

        def mk(name, discarded=True):
            props = {"url": f"https://example.com/vbws/{name}", "active": False}
            if discarded:
                props.update({"discarded": True, "title": f"Tab {name}"})
            ids[name] = val(api(z, h, "tabs.create", props))["id"]

        mk("A_disc")
        mk("A_live", discarded=False)
        mk("A_grp1")
        mk("A_grp2")
        mk("A_lg1", discarded=False)
        mk("A_lg2", discarded=False)
        mk("A_warm")
        g = val(api(z, h, "tabs.group", {"tabIds": [ids["A_grp1"], ids["A_grp2"]]}))
        api(z, h, "tabGroups.update", g, {"title": SIG + "Group A disc"})
        g2 = val(api(z, h, "tabs.group", {"tabIds": [ids["A_lg1"], ids["A_lg2"]]}))
        api(z, h, "tabGroups.update", g2, {"title": SIG + "Group A live"})
        out["warmup"] = api(z, h, "tabs.warmup", ids["A_warm"])
        z.ext(h, "sleep", [2000])
        out["A_warm_after_warmup"] = api(z, h, "tabs.get", ids["A_warm"])
        out["state_after_create_in_A"] = chrome_run(z, WS_STATE)
        out["create_space_b"] = chrome_run(z, r"""
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Space B"); await sleep(2000);
            return { uuid: ws.uuid, active: win.gZenWorkspaces.activeWorkspace };
        """)
        space_b = out["create_space_b"]["uuid"]
        mk("B_disc")
        mk("B_live", discarded=False)
        z.ext(h, "sleep", [1500])
        out["space_a"], out["space_b"], out["ids"] = space_a, space_b, ids
        # Before quitting: which tabs does each Space's tabs.query show?
        out["switch_to_A_pre"] = chrome_run(z, SWITCH, [space_a])
        out["pre_query_in_A"] = q_names(Page(z))
        out["switch_to_B_pre"] = chrome_run(z, SWITCH, [space_b])
        out["pre_query_in_B"] = q_names(Page(z))
        target = space_b if quit_in == "B" else space_a
        out["switch_before_quit"] = chrome_run(z, SWITCH, [target])
        out["before_quit"] = chrome_run(z, WS_STATE)

        z.restart()
        out["after_restart1"] = chrome_run(z, WS_STATE)
        pg = Page(z)
        out["r1_query_active"] = q_names(pg)
        other = space_a if out["after_restart1"]["active"] != space_a else space_b
        out["r1_switch_other"] = chrome_run(z, SWITCH, [other])
        out["r1_query_other"] = q_names(pg)
        out["r1_other_id"] = other
        out["before_restart2"] = chrome_run(z, WS_STATE)
        z.restart()
        out["after_restart2"] = chrome_run(z, WS_STATE)
        pg = Page(z)
        out["r2_query_active"] = q_names(pg)
    except Exception as e:
        out["error"] = repr(e)
        raise
    finally:
        z.quit()
        save_result(f"VB-spaces-ws-quit{quit_in}", out)
    name = {out["space_a"]: "A", out["space_b"]: "B", None: None}
    for phase in ["state_after_create_in_A", "before_quit", "after_restart1", "before_restart2", "after_restart2"]:
        st = out[phase]
        print(f"== {phase} (active {name.get(st['active'], st['active'])})")
        for n, t in st["tabs"].items():
            print(f"   {n:8} wsAttr={name.get(t['wsAttr'], t['wsAttr'])} container={name.get(t['containerWs'], t['containerWs'])}"
                  f" group={t['groupLabel']!r} groupCont={name.get(t['groupWsContainer'], t['groupWsContainer'])}"
                  f" pending={t['pending']} visible={t['inVisibleTabs']}")
        print("   session:", [(s["name"], name.get(s["zenWorkspace"], s["zenWorkspace"])) for s in st["session"]])
        print("   sessionGroups:", json.dumps([(g["name"], name.get(g["zenWorkspace"], g["zenWorkspace"])) for g in st["sessionGroups"]], ensure_ascii=True))
    print("warmup:", json.dumps(out["warmup"]), "A_warm after:",
          json.dumps({k: out["A_warm_after_warmup"].get("value", {}).get(k) for k in ["discarded", "status", "url"]}))
    for k in ["pre_query_in_A", "pre_query_in_B", "r1_query_active", "r1_query_other", "r2_query_active"]:
        print(k, out[k])


if __name__ == "__main__":
    sys.exit(main())
