"""Verifier copy of group C check 5 (sessions.setTabValue / getTabValue), with adversarial additions.

Copied from C5_tab_values.py. Changes:
- Marionette port 2963, profile VC-tabvalues-<tag>, results VC-5-tab-values-<tag>.
- POSITIONAL comparison (non-spike tabs in tab-strip order: url + values + groupId), which does not
  depend on the values themselves for matching (their compare() uses markers that are tab values).
- Same-URL twins with different keys (tA/tB): must keep their keys in the same strip positions.
- A tab moved (tabs.move to the end) after its key was set; a tab grouped after its key was set;
  a tab ungrouped after its key was set.
- A key written immediately before quit (no sleep), to test the flush on a normal quit.
- After reading all values on lazy tabs, re-query to prove reading did not load them.

Run: python spike/checks/VC_5_tab_values.py [tag]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

ADDON = "zen-tidy-spike@local"
PORT = 2963
KEYS = ["tidyKey", "obj", "k1", "k2", "tmp", "afterDiscard", "dupMarker", "restoreMarker", "late"]
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


def positional(before, after, ignore_keys=()):
    """Compare non-spike tabs in strip order. Matching is by position only, never by value."""
    def seq(s):
        rows = sorted((t for t in s if not t["isSpikePage"]), key=lambda t: t["index"])
        return [(t["url"], {k: v for k, v in t["values"].items() if k not in ignore_keys}, t["groupId"],
                 t["id"]) for t in rows]
    b, a = seq(before), seq(after)
    diffs = []
    for i in range(max(len(b), len(a))):
        bi = b[i] if i < len(b) else None
        ai = a[i] if i < len(a) else None
        if not bi or not ai or bi[0] != ai[0] or bi[1] != ai[1] or bi[2] != ai[2]:
            diffs.append({"pos": i, "before": bi, "after": ai})
    return {"ok": not diffs and len(a) == len(b), "len_before": len(b), "len_after": len(a), "diffs": diffs,
            "ids_changed": sum(1 for x, y in zip(b, a) if x[3] != y[3]),
            "ids_after_in_strip_order": [y[3] for y in a]}


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "r1"
    out = {"check": 5, "verifier": True, "tag": tag, "started": time.time()}
    xpi = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(SPIKE, "profiles", "_xpi", f"VC-spike-5-{tag}.xpi"))
    prof = make_profile(f"VC-tabvalues-{tag}", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        h, spike_url = page["handle"], page["url"]
        base = spike_url.rsplit("/", 1)[0] + "/"
        out["page"] = page

        specs = {
            "d1": {"url": "https://example.com/c5/d1", "title": "C5 d1", "discarded": True},
            "d2": {"url": "https://example.com/c5/d2", "title": "C5 d2", "discarded": True},
            "d3": {"url": "https://example.com/c5/d3", "title": "C5 d3", "discarded": True},
            "n1": {"url": "https://example.com/c5/n1-novalue", "title": "C5 n1", "discarded": True},
            "g1": {"url": "https://example.com/c5/g1", "title": "C5 g1", "discarded": True},
            "g2": {"url": "https://example.com/c5/g2-novalue", "title": "C5 g2", "discarded": True},
            "ug": {"url": "https://example.com/vc5/ungrouped-later", "title": "VC ug", "discarded": True},
            "gm": {"url": "https://example.com/vc5/grouped-later", "title": "VC gm", "discarded": True},
            "tA": {"url": "https://example.com/vc5/twin", "title": "VC twin", "discarded": True},
            "tB": {"url": "https://example.com/vc5/twin", "title": "VC twin", "discarded": True},
            "m1": {"url": "https://example.com/vc5/moved", "title": "VC moved", "discarded": True},
            "l1": {"url": base + "spike.html?c5=l1"},
            "l2": {"url": "https://example.com/c5/l2-failedload"},
            "x1": {"url": base + "spike.html?c5=x1"},
            "r1": {"url": "https://example.com/c5/r1", "title": "C5 r1", "discarded": True},
            "r2": {"url": base + "spike.html?c5=r2"},
        }
        ids = {}
        created = {}
        for name, spec in specs.items():
            r = call(z, h, "tabs.create", {**spec, "active": False})
            created[name] = r
            ids[name] = must(r, f"create {name}")["id"]
        out["created"] = {k: {"id": ids[k], "discarded": v["value"]["discarded"], "url": v["value"]["url"],
                              "index": v["value"]["index"]} for k, v in created.items()}
        for name in ("l1", "x1", "r2", "l2"):
            t = wait_loaded(z, h, ids[name], timeout=4 if name == "l2" else 8)
            out.setdefault("loaded_state", {})[name] = {"status": t["status"], "discarded": t["discarded"]}

        gid = must(call(z, h, "tabs.group", {"tabIds": [ids["g1"], ids["g2"], ids["ug"]]}), "tabs.group")
        must(call(z, h, "tabGroups.update", gid, {"title": "C5 group"}), "tabGroups.update")
        out["groupId_before"] = gid

        intended = {}
        set_results = {}

        def set_value(name, key, value):
            r = call(z, h, "sessions.setTabValue", ids[name], key, value)
            set_results[f"{name}.{key}"] = r
            if "error" not in r:
                intended.setdefault(name, {})[key] = value

        for name in ("d1", "d2", "d3", "g1", "l1", "l2", "x1", "r1", "r2", "ug", "gm", "m1"):
            set_value(name, "tidyKey", f"C5:{name}:{specs[name]['url']}")
        set_value("tA", "tidyKey", "VC5:twin-A")
        set_value("tB", "tidyKey", "VC5:twin-B")
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

        # Structural changes AFTER the keys were set.
        out["move_m1"] = call(z, h, "tabs.move", ids["m1"], {"index": -1})
        out["group_gm"] = call(z, h, "tabs.group", {"tabIds": [ids["gm"]], "groupId": gid})
        out["ungroup_ug"] = call(z, h, "tabs.ungroup", [ids["ug"]])
        time.sleep(0.5)
        out["after_struct"] = {n: {k: must(call(z, h, "tabs.get", ids[n]), "get")[k] for k in ("index", "groupId")}
                               for n in ("m1", "gm", "ug", "tA", "tB")}
        out["set_results"] = set_results
        out["intended"] = dict(intended)

        s0 = snapshot(z, h, spike_url)
        out["S0_after_set"] = s0
        by_id0 = {t["id"]: t for t in s0}
        out["S0_matches_intended"] = {
            name: by_id0.get(ids[name], {}).get("values") == intended.get(name, {}) for name in specs
        }

        # --- Duplicate ------------------------------------------------------------------------
        dups = {}
        for name in ("d3", "l1", "g1"):
            src_index = must(call(z, h, "tabs.get", ids[name]), "get")["index"]
            r = call(z, h, "tabs.duplicate", ids[name], {"active": False})
            entry = {"result": r, "src_index": src_index}
            if "error" not in r:
                time.sleep(1.0)
                did = r["value"]["id"]
                t = must(call(z, h, "tabs.get", did), "tabs.get dup")
                entry.update({
                    "dup_id": did, "url": t["url"], "discarded": t["discarded"], "active": t["active"],
                    "groupId": t["groupId"], "status": t["status"], "index": t["index"],
                    "values_on_dup": {k: call(z, h, "sessions.getTabValue", did, k).get("value") for k in KEYS},
                })
                entry["tidyKey_copied"] = entry["values_on_dup"].get("tidyKey") == intended[name]["tidyKey"]
                entry["set_marker"] = call(z, h, "sessions.setTabValue", did, "dupMarker", f"dup-of-{name}")
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

        # Write "late" keys immediately before the quit: no sleep between these and restart().
        late = {}
        for name in ("d2", "tA", "m1"):
            late[name] = call(z, h, "sessions.setTabValue", ids[name], "late", f"late-{name}")
        out["late_set"] = late
        s1_late = [dict(t, values=dict(t["values"])) for t in s1]
        for t in s1_late:
            for name in ("d2", "tA", "m1"):
                if t["id"] == ids[name]:
                    t["values"]["late"] = f"late-{name}"

        # --- Restart 1 ------------------------------------------------------------------------
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["windows_after_restart1"] = len(must(call(z, h, "windows.getAll", {}), "windows.getAll"))
        s2 = snapshot(z, h, spike_url)
        out["S2_after_restart1"] = s2
        requery = must(call(z, h, "tabs.query", {}), "tabs.query")
        out["S2_discarded_after_reading_values"] = {t["id"]: (t["discarded"], t["status"]) for t in requery
                                                    if t["url"] != spike_url}
        out["groups_after_restart1"] = must(call(z, h, "tabGroups.query", {}), "tabGroups.query")
        out["pos_S1late_S2"] = positional(s1_late, s2)

        # --- Restart 2 ------------------------------------------------------------------------
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["windows_after_restart2"] = len(must(call(z, h, "windows.getAll", {}), "windows.getAll"))
        s3 = snapshot(z, h, spike_url)
        out["S3_after_restart2"] = s3
        out["groups_after_restart2"] = must(call(z, h, "tabGroups.query", {}), "tabGroups.query")
        out["pos_S1late_S3"] = positional(s1_late, s3)
        out["pos_S2_S3"] = positional(s2, s3)
        # Negative control for the comparator itself: a deliberately corrupted copy must FAIL.
        corrupted = [dict(t, values=dict(t["values"])) for t in s3]
        for t in corrupted:
            if t["values"].get("tidyKey") == "VC5:twin-A":
                t["values"]["tidyKey"] = "VC5:twin-B"
            elif t["values"].get("tidyKey") == "VC5:twin-B":
                t["values"]["tidyKey"] = "VC5:twin-A"
        out["comparator_negative_control_swap_twins"] = positional(s1_late, corrupted)["ok"]
    finally:
        z.quit()
    out["finished"] = time.time()
    path = save_result(f"VC-5-tab-values-{tag}", out)

    summary = {
        "S0_matches_intended": out.get("S0_matches_intended"),
        "after_struct": out.get("after_struct"),
        "duplicate": {k: {"tidyKey_copied": v.get("tidyKey_copied"), "discarded": v.get("discarded"),
                          "status": v.get("status"), "src_index": v.get("src_index"), "index": v.get("index"),
                          "groupId": v.get("groupId"), "independent": v.get("independent"),
                          "error": v["result"].get("error")} for k, v in out.get("duplicate", {}).items()},
        "restore": {k: {"found": v.get("closed_entry_found"), "tidyKey_copied": v.get("tidyKey_copied"),
                        "active": v.get("active"), "discarded": v.get("discarded"), "status": v.get("status"),
                        "active_before": v.get("active_before"), "active_after": v.get("active_after"),
                        "error": (v.get("restore") or {}).get("error")} for k, v in out.get("restore", {}).items()},
        "late_set": out.get("late_set"),
        "windows": [out.get("windows_before_restart"), out.get("windows_after_restart1"), out.get("windows_after_restart2")],
        "pos_S1late_S2": {k: out.get("pos_S1late_S2", {}).get(k) for k in ("ok", "len_before", "len_after", "diffs", "ids_changed")},
        "pos_S1late_S3": {k: out.get("pos_S1late_S3", {}).get(k) for k in ("ok", "len_before", "len_after", "diffs", "ids_changed")},
        "pos_S2_S3": {k: out.get("pos_S2_S3", {}).get(k) for k in ("ok", "ids_changed")},
        "ids_after_r1": out.get("pos_S1late_S2", {}).get("ids_after_in_strip_order"),
        "comparator_negative_control_ok_value(should be False)": out.get("comparator_negative_control_swap_twins"),
        "discarded_after_reading": out.get("S2_discarded_after_reading_values"),
        "groups": [[(g["id"], g["title"]) for g in out.get(k, [])] for k in ("groups_after_restart1", "groups_after_restart2")],
        "groupId_before": out.get("groupId_before"),
    }
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    print("saved", path)


if __name__ == "__main__":
    main()
