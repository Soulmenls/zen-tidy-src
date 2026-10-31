"""Check 8 follow-up: do discarded tabs created by tabs.create keep their Space across a restart?

Usage: python B_spaces_ws.py <quit_in: A|B> <port>
  quit_in=B -> Space B is active at quit (suspected move of Space A's discarded tabs to B)
  quit_in=A -> Space A is active at quit (control: nothing should move)

Space A gets, via extension APIs: a discarded tab, a non-discarded background tab, two discarded tabs in a
SIG group, and a discarded tab that is then passed to tabs.warmup. SessionStore.getBrowserState() is read
to see what zenWorkspace each tab is saved with.
"""
import json
import sys

from B_common import (ADDON, SIG, ZenSession, api, build_b_xpi, chrome_run, ext_handle, inspect, Page, make_profile, save_result,
                      val)

WS_STATE = r"""
    const res = { active: win.gZenWorkspaces.activeWorkspace, tabs: {} };
    for (const t of win.gZenWorkspaces.allStoredTabs) {
      const u = t.linkedBrowser?.currentURI?.spec || "";
      if (!u.includes("/ws/")) continue;
      res.tabs[u.split("/").pop()] = { wsAttr: t.getAttribute("zen-workspace-id"),
        containerWs: t.closest("zen-workspace")?.id ?? null, group: t.group?.id ?? null,
        groupLabel: t.group?.label ?? null, pending: t.hasAttribute("pending"),
        hasBrowserInserted: !!t.linkedBrowser?.isConnected && !!t.linkedBrowser?.browsingContext,
        inVisibleTabs: win.gBrowser.tabs.includes(t) };
    }
    const state = JSON.parse(SessionStore.getBrowserState());
    res.session = [];
    for (const w of state.windows) for (const t of w.tabs) {
      const e = t.entries?.[t.index - 1] || t.entries?.[0] || {};
      const u = e.url || t.userTypedValue || "";
      if (u.includes("/ws/")) res.session.push({ name: u.split("/").pop(), zenWorkspace: t.zenWorkspace ?? null,
                                                  groupId: t.groupId ?? null });
    }
    res.sessionGroups = state.windows.flatMap(w => (w.groups || []).map(g => ({ id: g.id, name: g.name,
                                                  zenWorkspace: g.zenWorkspace ?? g.workspaceId ?? null })));
    return res;
"""


def main():
    quit_in = sys.argv[1]
    port = int(sys.argv[2])
    out = {"quit_in": quit_in, "port": port}
    xpi = build_b_xpi(f"B-events-ws-{quit_in}")
    prof = make_profile(f"B-ws-quit{quit_in}", port)
    z = ZenSession(prof, port, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        h = ext_handle(z)
        page = z.open_ext_page(ADDON)
        out["page_to_essential"] = chrome_run(z, r"""
            const t = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === args[0]);
            win.gZenPinnedTabManager.addToEssentials(t); await sleep(800);
            return { spaceA: win.gZenWorkspaces.activeWorkspace };
        """, [page["url"]])
        space_a = out["page_to_essential"]["spaceA"]
        ids = {}

        def mk(name, discarded=True):
            props = {"url": f"https://example.com/ws/{name}", "active": False}
            if discarded:
                props.update({"discarded": True, "title": f"Tab {name}"})
            ids[name] = val(api(z, h, "tabs.create", props))["id"]

        mk("A_disc")
        mk("A_live", discarded=False)
        mk("A_grp1")
        mk("A_grp2")
        mk("A_warm")
        g = val(api(z, h, "tabs.group", {"tabIds": [ids["A_grp1"], ids["A_grp2"]]}))
        api(z, h, "tabGroups.update", g, {"title": SIG + "Group A"})
        out["warmup"] = api(z, h, "tabs.warmup", ids["A_warm"])
        z.ext(h, "sleep", [2000])
        out["A_warm_after_warmup"] = api(z, h, "tabs.get", ids["A_warm"])
        out["create_space_b"] = chrome_run(z, r"""
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Space B"); await sleep(2000);
            return { uuid: ws.uuid, active: win.gZenWorkspaces.activeWorkspace };
        """)
        space_b = out["create_space_b"]["uuid"]
        mk("B_disc")
        out["space_a"], out["space_b"], out["ids"] = space_a, space_b, ids
        target = space_b if quit_in == "B" else space_a
        out["switch_before_quit"] = chrome_run(z, r"""
            await win.gZenWorkspaces.changeWorkspaceWithID(args[0]); await sleep(2000);
            return { active: win.gZenWorkspaces.activeWorkspace };
        """, [target])
        out["before_quit"] = chrome_run(z, WS_STATE)

        z.restart()
        out["after_restart"] = chrome_run(z, WS_STATE)
        pg = Page(z)
        out["after_restart_query_active_space"] = [t["url"].rsplit("/", 1)[-1] for t in
                                                   val(pg.api("tabs.query", {"currentWindow": True}))]
        other = space_a if out["after_restart"]["active"] != space_a else space_b
        chrome_run(z, "await win.gZenWorkspaces.changeWorkspaceWithID(args[0]); await sleep(2000); return 1;", [other])
        out["after_restart_query_other_space"] = [t["url"].rsplit("/", 1)[-1] for t in
                                                  val(pg.api("tabs.query", {"currentWindow": True}))]
        out["after_restart_other_space_id"] = other
    except Exception as e:
        out["error"] = repr(e)
        save_result(f"B-spaces-ws-quit{quit_in}", out)
        raise
    finally:
        z.quit()
    path = save_result(f"B-spaces-ws-quit{quit_in}", out)
    print("saved", path)
    name = {out["space_a"]: "A", out["space_b"]: "B", None: None}
    for phase in ["before_quit", "after_restart"]:
        st = out[phase]
        print(f"== {phase} (active {name.get(st['active'], st['active'])})")
        for n, t in st["tabs"].items():
            print(f"   {n:8} wsAttr={name.get(t['wsAttr'], t['wsAttr'])} container={name.get(t['containerWs'], t['containerWs'])}"
                  f" group={t['groupLabel']!r} pending={t['pending']} visible={t['inVisibleTabs']}")
        print("   session:", [(s["name"], name.get(s["zenWorkspace"], s["zenWorkspace"])) for s in st["session"]])
        print("   sessionGroups:", json.dumps(st["sessionGroups"], ensure_ascii=True))
    print("warmup:", json.dumps(out["warmup"]), "A_warm after:",
          json.dumps({k: out["A_warm_after_warmup"].get("value", {}).get(k) for k in ["discarded", "status", "url"]}))
    print("after restart query (active):", out["after_restart_query_active_space"])
    print("after restart query (other):", name.get(out["after_restart_other_space_id"]), out["after_restart_query_other_space"])


if __name__ == "__main__":
    sys.exit(main())
