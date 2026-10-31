"""Group C, check 5: sessions.setTabValue / getTabValue.

- Values on loose tabs (discarded, loaded, failed-load, discarded-after-load) and on a grouped tab
  survive a restart and a second restart, and follow the right tab (matched by URL, ids may change).
- tabs.duplicate: is the value copied?
- sessions.restore of a closed tab: is the value copied back?

Throwaway profile C-tabvalues on Marionette port 2953. Run: python spike/checks/C5_tab_values.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

ADDON = "zen-tidy-spike@local"
PORT = 2953
KEYS = ["tidyKey", "obj", "k1", "k2", "tmp", "afterDiscard", "dupMarker", "restoreMarker"]
OBJ_VALUE = {"n": 1, "nested": {"a": [1, 2, None]}, "s": "ünïcode ​⁣⁤ ✓", "f": 1.5, "b": False}


def call(z, h, path, *args):
    return z.ext(h, "api", [path, list(args)])


def must(r, what):
    if not isinstance(r, dict) or "error" in r:
        raise RuntimeError(f"{what} failed: {r}")
    return r["value"]


def wait_loaded(z, h, tab_id, timeout=8.0):
    deadline = time.time() + timeout
    t = None
    while time.time() < deadline:
        t = must(call(z, h, "tabs.get", tab_id), "tabs.get")
        if t["status"] == "complete" and not t["discarded"]:
            return t
        time.sleep(0.25)
    return t


def snapshot(z, h, spike_url):
    tabs = must(call(z, h, "tabs.query", {}), "tabs.query")
    out = []
    for t in tabs:
        vals = {}
        for k in KEYS:
            r = call(z, h, "sessions.getTabValue", t["id"], k)
            if "error" in r:
                vals[k] = {"error": r["error"]}
            elif r["value"] is not None:
                vals[k] = r["value"]
        out.append({
            "id": t["id"], "index": t["index"], "windowId": t["windowId"], "url": t["url"],
            "title": t.get("title"), "discarded": t["discarded"], "active": t["active"],
            "pinned": t["pinned"], "groupId": t["groupId"], "status": t["status"],
            "isSpikePage": t["url"] == spike_url, "values": vals,
        })
    return out


def identity(tab):
    """URL plus the markers we put on duplicates/restored tabs (they share URLs with originals)."""
    v = tab["values"]
    return f'{tab["url"]}|dup={v.get("dupMarker")}|restored={v.get("restoreMarker")}'


def compare(before, after):
    """Match tabs by identity (URL + markers); report value equality and id changes."""
    b = {}
    for t in before:
        if not t["isSpikePage"]:
            b.setdefault(identity(t), []).append(t)
    a = {}
    for t in after:
        if not t["isSpikePage"]:
            a.setdefault(identity(t), []).append(t)
    rows = []
    for ident, bt in b.items():
        at = a.get(ident, [])
        row = {"identity": ident, "count_before": len(bt), "count_after": len(at)}
        if len(bt) == 1 and len(at) == 1:
            row.update({
                "id_before": bt[0]["id"], "id_after": at[0]["id"],
                "id_changed": bt[0]["id"] != at[0]["id"],
                "values_equal": bt[0]["values"] == at[0]["values"],
                "groupId_before": bt[0]["groupId"], "groupId_after": at[0]["groupId"],
                "values_after": at[0]["values"],
            })
        rows.append(row)
    missing_after = [r["identity"] for r in rows if r["count_after"] == 0]
    new_after = [i for i in a if i not in b]
    ok = all(r.get("values_equal") for r in rows) and not missing_after
    return {"ok": ok, "rows": rows, "missing_after": missing_after, "new_after": new_after}


def main():
    out = {"check": 5, "started": time.time()}
    xpi = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(SPIKE, "profiles", "_xpi", "C-spike-5.xpi"))
    prof = make_profile("C-tabvalues", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        h, spike_url = page["handle"], page["url"]
        base = spike_url.rsplit("/", 1)[0] + "/"
        out["page"] = page

        # --- Create tabs -------------------------------------------------------------------
        specs = {
            "d1": {"url": "https://example.com/c5/d1", "title": "C5 d1", "discarded": True},
            "d2": {"url": "https://example.com/c5/d2", "title": "C5 d2", "discarded": True},
            "d3": {"url": "https://example.com/c5/d3", "title": "C5 d3", "discarded": True},
            "n1": {"url": "https://example.com/c5/n1-novalue", "title": "C5 n1", "discarded": True},
            "g1": {"url": "https://example.com/c5/g1", "title": "C5 g1", "discarded": True},
            "g2": {"url": "https://example.com/c5/g2-novalue", "title": "C5 g2", "discarded": True},
            "l1": {"url": base + "spike.html?c5=l1"},                  # loaded extension page
            "l2": {"url": "https://example.com/c5/l2-failedload"},    # not discarded; load fails (PAC)
            "x1": {"url": base + "spike.html?c5=x1"},                  # loaded, then tabs.discard
            "r1": {"url": "https://example.com/c5/r1", "title": "C5 r1", "discarded": True},
            "r2": {"url": base + "spike.html?c5=r2"},                  # loaded; closed + restored
        }
        ids = {}
        created = {}
        for name, spec in specs.items():
            r = call(z, h, "tabs.create", {**spec, "active": False})
            created[name] = r
            ids[name] = must(r, f"create {name}")["id"]
        out["created"] = {k: {"id": ids[k], "discarded": v["value"]["discarded"], "url": v["value"]["url"]}
                          for k, v in created.items()}
        for name in ("l1", "x1", "r2", "l2"):
            t = wait_loaded(z, h, ids[name], timeout=4 if name == "l2" else 8)
            out.setdefault("loaded_state", {})[name] = {"status": t["status"], "discarded": t["discarded"]}

        gid = must(call(z, h, "tabs.group", {"tabIds": [ids["g1"], ids["g2"]]}), "tabs.group")
        must(call(z, h, "tabGroups.update", gid, {"title": "C5 group"}), "tabGroups.update")
        out["groupId_before"] = gid

        # --- Set values ----------------------------------------------------------------------
        intended = {}
        set_results = {}

        def set_value(name, key, value):
            r = call(z, h, "sessions.setTabValue", ids[name], key, value)
            set_results[f"{name}.{key}"] = r
            if "error" not in r:
                intended.setdefault(name, {})[key] = value

        for name in ("d1", "d2", "d3", "g1", "l1", "l2", "x1", "r1", "r2"):
            set_value(name, "tidyKey", f"C5:{name}:{specs[name]['url']}")
        set_value("d1", "obj", OBJ_VALUE)
        set_value("d2", "k1", 1)
        set_value("d2", "k2", [True, "two"])
        set_value("d2", "tmp", "to-be-removed")
        out["removeTabValue"] = call(z, h, "sessions.removeTabValue", ids["d2"], "tmp")
        if "error" not in out["removeTabValue"]:
            intended["d2"].pop("tmp", None)
        out["discard_x1"] = call(z, h, "tabs.discard", ids["x1"])
        time.sleep(0.5)
        out["x1_after_discard"] = must(call(z, h, "tabs.get", ids["x1"]), "tabs.get x1")["discarded"]
        set_value("x1", "afterDiscard", "set-while-discarded")
        out["set_results"] = set_results
        out["intended"] = intended

        s0 = snapshot(z, h, spike_url)
        out["S0_after_set"] = s0
        by_id0 = {t["id"]: t for t in s0}
        out["S0_matches_intended"] = {
            name: by_id0.get(ids[name], {}).get("values") == intended.get(name, {}) for name in specs
        }

        # --- Duplicate ------------------------------------------------------------------------
        dups = {}
        for name in ("d3", "l1", "g1"):
            r = call(z, h, "tabs.duplicate", ids[name], {"active": False})
            entry = {"result": r}
            if "error" not in r:
                time.sleep(1.0)
                did = r["value"]["id"]
                t = must(call(z, h, "tabs.get", did), "tabs.get dup")
                entry.update({
                    "dup_id": did, "url": t["url"], "discarded": t["discarded"], "active": t["active"],
                    "groupId": t["groupId"], "status": t["status"],
                    "values_on_dup": {k: call(z, h, "sessions.getTabValue", did, k).get("value") for k in KEYS},
                })
                entry["tidyKey_copied"] = entry["values_on_dup"].get("tidyKey") == intended[name]["tidyKey"]
                # Mark the duplicate so it can be told apart after restart.
                entry["set_marker"] = call(z, h, "sessions.setTabValue", did, "dupMarker", f"dup-of-{name}")
                # Independence: a later write on the original must not show up on the copy, and vice versa.
                call(z, h, "sessions.setTabValue", ids[name], "k1", f"orig-{name}-after-dup")
                call(z, h, "sessions.setTabValue", did, "k2", f"dup-{name}-only")
                intended.setdefault(name, {})["k1"] = f"orig-{name}-after-dup"
                entry["independent"] = {
                    "orig_k2": call(z, h, "sessions.getTabValue", ids[name], "k2").get("value"),
                    "dup_k1": call(z, h, "sessions.getTabValue", did, "k1").get("value"),
                }
            dups[name] = entry
        out["duplicate"] = dups
        out["active_after_duplicates"] = [t["id"] for t in must(call(z, h, "tabs.query", {"active": True}), "q")]

        # --- Close and sessions.restore -------------------------------------------------------
        restores = {}
        for name in ("r1", "r2"):
            entry = {"active_before": [t["id"] for t in must(call(z, h, "tabs.query", {"active": True}), "q")]}
            entry["remove"] = call(z, h, "tabs.remove", ids[name])
            time.sleep(0.7)
            closed = must(call(z, h, "sessions.getRecentlyClosed", {"maxResults": 25}), "getRecentlyClosed")
            match = [c for c in closed if c.get("tab") and c["tab"]["url"] == specs[name]["url"]]
            entry["closed_entry_found"] = bool(match)
            if match:
                sid = match[0]["tab"]["sessionId"]
                entry["sessionId"] = sid
                r = call(z, h, "sessions.restore", sid)
                entry["restore"] = r
                if "error" not in r:
                    time.sleep(1.0)
                    rid = r["value"]["tab"]["id"]
                    t = must(call(z, h, "tabs.get", rid), "tabs.get restored")
                    entry.update({
                        "restored_id": rid, "url": t["url"], "discarded": t["discarded"], "active": t["active"],
                        "status": t["status"], "groupId": t["groupId"], "index": t["index"],
                        "values_on_restored": {k: call(z, h, "sessions.getTabValue", rid, k).get("value") for k in KEYS},
                    })
                    entry["tidyKey_copied"] = entry["values_on_restored"].get("tidyKey") == intended[name]["tidyKey"]
                    entry["active_after"] = [x["id"] for x in must(call(z, h, "tabs.query", {"active": True}), "q")]
                    entry["set_marker"] = call(z, h, "sessions.setTabValue", rid, "restoreMarker", f"restored-{name}")
            restores[name] = entry
        out["restore"] = restores

        out["windows_before_restart"] = len(must(call(z, h, "windows.getAll", {}), "windows.getAll"))
        s1 = snapshot(z, h, spike_url)
        out["S1_before_restart"] = s1

        # --- Restart 1 ------------------------------------------------------------------------
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["windows_after_restart1"] = len(must(call(z, h, "windows.getAll", {}), "windows.getAll"))
        s2 = snapshot(z, h, spike_url)
        out["S2_after_restart1"] = s2
        out["groups_after_restart1"] = must(call(z, h, "tabGroups.query", {}), "tabGroups.query")
        out["cmp_S1_S2"] = compare(s1, s2)

        # --- Restart 2 ------------------------------------------------------------------------
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["windows_after_restart2"] = len(must(call(z, h, "windows.getAll", {}), "windows.getAll"))
        s3 = snapshot(z, h, spike_url)
        out["S3_after_restart2"] = s3
        out["groups_after_restart2"] = must(call(z, h, "tabGroups.query", {}), "tabGroups.query")
        out["cmp_S1_S3"] = compare(s1, s3)
        out["cmp_S2_S3"] = compare(s2, s3)
    finally:
        z.quit()
    out["finished"] = time.time()
    tag = sys.argv[1] if len(sys.argv) > 1 else ""
    path = save_result("C-5-tab-values" + (f"-{tag}" if tag else ""), out)

    summary = {
        "S0_matches_intended": out.get("S0_matches_intended"),
        "duplicate": {k: {"tidyKey_copied": v.get("tidyKey_copied"), "discarded": v.get("discarded"),
                          "groupId": v.get("groupId"), "independent": v.get("independent"),
                          "error": v["result"].get("error")} for k, v in out.get("duplicate", {}).items()},
        "restore": {k: {"found": v.get("closed_entry_found"), "tidyKey_copied": v.get("tidyKey_copied"),
                        "active": v.get("active"), "discarded": v.get("discarded"), "status": v.get("status"),
                        "error": (v.get("restore") or {}).get("error")} for k, v in out.get("restore", {}).items()},
        "windows": [out.get("windows_before_restart"), out.get("windows_after_restart1"), out.get("windows_after_restart2")],
        "cmp_S1_S2_ok": out.get("cmp_S1_S2", {}).get("ok"),
        "cmp_S1_S3_ok": out.get("cmp_S1_S3", {}).get("ok"),
        "id_changes_S1_S2": [(r["identity"][:60], r.get("id_before"), r.get("id_after"), r.get("values_equal"))
                             for r in out.get("cmp_S1_S2", {}).get("rows", [])],
        "missing": [out.get("cmp_S1_S2", {}).get("missing_after"), out.get("cmp_S1_S3", {}).get("missing_after")],
        "new": [out.get("cmp_S1_S2", {}).get("new_after"), out.get("cmp_S1_S3", {}).get("new_after")],
    }
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    print("saved", path)


if __name__ == "__main__":
    main()
