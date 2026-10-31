"""Check 7 follow-up: a discarded tab created at an index INSIDE a Zen split lands in the split group's DOM but
not in gZenViewSplitter data. What happens to it (and the split) across a restart? Port 2956, profile B-create-split.
Also probes view-source: without `discarded` (the discarded variant was accepted in B_create.py).
"""
import json
import sys

from B_common import ADDON, ZenSession, Page, build_b_xpi, chrome_run, make_profile, save_result, val

PORT = 2956

STATE = r"""
    const res = {};
    for (const t of win.gBrowser.tabs) {
      const u = t.linkedBrowser.currentURI.spec;
      if (!u.includes("/cs/")) continue;
      res[u.split("/").pop()] = { splitViewFlag: !!t.splitView, group: t.group?.id ?? null,
        groupIsSplit: t.group?.hasAttribute("split-view-group") ?? null,
        inSplitData: (win.gZenViewSplitter._data || []).some(d => d.tabs.includes(t)), gbIndex: win.gBrowser.tabs.indexOf(t) };
    }
    res._splitData = (win.gZenViewSplitter._data || []).map(d => ({ groupId: d.groupId,
      tabs: d.tabs.map(t => t.linkedBrowser.currentURI.spec.split("/").pop()) }));
    return res;
"""


def main():
    out = {"port": PORT}
    xpi = build_b_xpi("B-events-create-split")
    prof = make_profile("B-create-split", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        pg = Page(z)
        ids = {}
        for n in ["A", "S1", "S2", "B"]:
            ids[n] = val(pg.api("tabs.create", {"url": f"https://example.com/cs/{n}", "title": n, "discarded": True,
                                                "active": False}))["id"]
        for n in ["A", "S1", "S2", "B"]:
            pg.api("tabs.move", ids[n], {"index": -1})
        out["split"] = chrome_run(z, r"""
            const d = win.gZenViewSplitter.splitTabs([byId(args[0]), byId(args[1])], "grid", -1); await sleep(1200);
            return { ok: !!d, groupId: d?.groupId };
        """, [ids["S1"], ids["S2"]])
        s2 = val(pg.api("tabs.get", ids["S2"]))
        out["create_inside"] = pg.api("tabs.create", {"url": "https://example.com/cs/NEW", "title": "NEW",
                                                      "discarded": True, "active": False, "index": s2["index"]})
        out["state_before"] = chrome_run(z, STATE)
        out["ext_before"] = [(t["url"].rsplit("/", 1)[-1], t["index"], t["groupId"])
                             for t in val(pg.api("tabs.query", {"currentWindow": True}))]
        out["view_source_not_discarded"] = pg.api("tabs.create", {"url": "view-source:https://example.com/cs/vs",
                                                                  "active": False})
        if "value" in out["view_source_not_discarded"]:
            pg.api("tabs.remove", out["view_source_not_discarded"]["value"]["id"])
        z.restart()
        out["state_after_restart"] = chrome_run(z, STATE)
        pg = Page(z)
        out["ext_after_restart"] = [(t["url"].rsplit("/", 1)[-1], t["index"], t["groupId"])
                                    for t in val(pg.api("tabs.query", {"currentWindow": True}))]
    except Exception as e:
        out["error"] = repr(e)
        raise
    finally:
        z.quit()
        save_result("B-create-split", out)
    print(json.dumps({k: out.get(k) for k in ["split", "create_inside", "view_source_not_discarded"]})[:1500])
    for k in ["state_before", "ext_before", "state_after_restart", "ext_after_restart"]:
        print("==", k, json.dumps(out.get(k)))


if __name__ == "__main__":
    sys.exit(main())
