"""VB copy (port 2966, profile VB-spaces-danger) of B_spaces_danger.py. Check 8 follow-up: cross-Space tabs.group danger with tabs that carry a real zen-workspace-id.
Port 2952, profile B-spaces-danger. Groups use LOADED (non-discarded) tabs so every tab has a Space attribute
(discarded tabs created by tabs.create never get one; see B_spaces_ws.py).

With Space A active:
  D1 tabs.group({tabIds:[A_live], groupId: GB})   (A_live: loaded, zen-workspace-id = A)
  D2 tabs.group({tabIds:[A_disc], groupId: GB})   (A_disc: discarded, no zen-workspace-id)
  D3 tabs.move(B_x, {index: 2})                   (B_x id known only from tabs.get)
Then switch to B, then restart with Space A active.
"""
import json
import sys

from B_common import (SIG, ZenSession, Page, build_b_xpi, chrome_run, make_profile, save_result, val)

PORT = 2966

STATE = r"""
    const names = { [args[0]]: "A", [args[1]]: "B" };
    const res = { active: names[win.gZenWorkspaces.activeWorkspace], tabs: {} };
    for (const t of win.gZenWorkspaces.allStoredTabs) {
      const u = t.linkedBrowser?.currentURI?.spec || "";
      if (!u.includes("/sd/")) continue;
      res.tabs[u.split("/").pop()] = { wsAttr: names[t.getAttribute("zen-workspace-id")] ?? t.getAttribute("zen-workspace-id"),
        container: names[t.closest("zen-workspace")?.id] ?? null, group: t.group?.label ?? null,
        visibleInActiveSpace: win.gBrowser.tabs.includes(t), selected: t.selected };
    }
    return res;
"""


def main():
    out = {"port": PORT}
    xpi = build_b_xpi("VB-spaces-danger")
    prof = make_profile("VB-spaces-danger", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        pg = Page(z)
        page = z.open_ext_page("zen-tidy-spike-b@local")
        out["essential"] = chrome_run(z, r"""
            const t = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === args[0]);
            win.gZenPinnedTabManager.addToEssentials(t); await sleep(800);
            return { spaceA: win.gZenWorkspaces.activeWorkspace };
        """, [page["url"]])
        space_a = out["essential"]["spaceA"]
        ids = {}

        def mk(name, discarded):
            props = {"url": f"https://example.com/sd/{name}", "active": False}
            if discarded:
                props.update({"discarded": True, "title": name})
            ids[name] = val(pg.api("tabs.create", props))["id"]

        for n in ["A_live", "A_g1", "A_g2"]:
            mk(n, False)
        mk("A_disc", True)
        ga = val(pg.api("tabs.group", {"tabIds": [ids["A_g1"], ids["A_g2"]]}))
        pg.api("tabGroups.update", ga, {"title": SIG + "Test A"})
        out["space_b"] = chrome_run(z, r"""
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Space B"); await sleep(2000);
            return ws.uuid;
        """)
        space_b = out["space_b"]
        for n in ["B_g1", "B_g2", "B_x"]:
            mk(n, False)
        gb = val(pg.api("tabs.group", {"tabIds": [ids["B_g1"], ids["B_g2"]]}))
        pg.api("tabGroups.update", gb, {"title": SIG + "Test B"})
        z.ext(pg.h, "sleep", [2000])
        chrome_run(z, "await win.gZenWorkspaces.changeWorkspaceWithID(args[0]); await sleep(2000); return 1;", [space_a])
        out["ids"], out["ga"], out["gb"] = ids, ga, gb
        sp = [space_a, space_b]
        out["s0_in_A"] = chrome_run(z, STATE, sp)
        out["q0_in_A"] = [t["url"].rsplit("/", 1)[-1] for t in val(pg.api("tabs.query", {"currentWindow": True}))]

        out["D1"] = pg.api("tabs.group", {"tabIds": [ids["A_live"]], "groupId": gb})
        out["D2"] = pg.api("tabs.group", {"tabIds": [ids["A_disc"]], "groupId": gb})
        out["D3_get_before"] = pg.api("tabs.get", ids["B_x"])
        out["D3"] = pg.api("tabs.move", ids["B_x"], {"index": 2})
        z.ext(pg.h, "sleep", [1500])
        out["s1_in_A"] = chrome_run(z, STATE, sp)
        out["q1_in_A"] = [(t["url"].rsplit("/", 1)[-1], t["index"], t["groupId"])
                          for t in val(pg.api("tabs.query", {"currentWindow": True}))]
        chrome_run(z, "await win.gZenWorkspaces.changeWorkspaceWithID(args[0]); await sleep(2000); return 1;", [space_b])
        out["s2_in_B"] = chrome_run(z, STATE, sp)
        out["q2_in_B"] = [(t["url"].rsplit("/", 1)[-1], t["index"], t["groupId"])
                          for t in val(pg.api("tabs.query", {"currentWindow": True}))]
        chrome_run(z, "await win.gZenWorkspaces.changeWorkspaceWithID(args[0]); await sleep(2000); return 1;", [space_a])
        z.restart()
        out["s3_after_restart"] = chrome_run(z, STATE, sp)
        pg = Page(z)
        out["q3_after_restart"] = [(t["url"].rsplit("/", 1)[-1], t["groupId"])
                                   for t in val(pg.api("tabs.query", {"currentWindow": True}))]
    except Exception as e:
        out["error"] = repr(e)
        raise
    finally:
        z.quit()
        save_result("VB-spaces-danger", out)
    for k in ["D1", "D2", "D3"]:
        r = out.get(k, {})
        print(k, json.dumps(r if "error" in r else (r.get("value") if not isinstance(r.get("value"), list)
                                                     else [(t["index"], t["groupId"]) for t in r["value"]])))
    print("D3 tabs.get before:", json.dumps({k: out["D3_get_before"]["value"].get(k) for k in ["index", "groupId"]}))
    for k in ["s0_in_A", "s1_in_A", "s2_in_B", "s3_after_restart"]:
        st = out.get(k)
        print("==", k, "active", st["active"])
        for n, t in st["tabs"].items():
            print("  ", f"{n:7}", json.dumps(t, ensure_ascii=True))
    for k in ["q0_in_A", "q1_in_A", "q2_in_B", "q3_after_restart"]:
        print(k, out.get(k))


if __name__ == "__main__":
    sys.exit(main())
