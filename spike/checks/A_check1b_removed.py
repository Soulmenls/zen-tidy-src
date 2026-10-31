"""Group A, check 1b: characterise the spurious tabGroups.onRemoved seen once in check 1 (and in smoke).

Repeats group creation (contiguous / non-contiguous / tabIds[0] first or last), title updates, moves to the top
and re-tidy adds, and counts onRemoved events whose group still exists (tabGroups.get succeeds) afterwards.
Usage: python A_check1b_removed.py [variant|base] [iterations]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from A_common import (ADDON, SPIKE, ZenSession, api, build_xpi, create_tabs, inspect, log_entries,  # noqa: E402
                      make_profile, save_result, val)

PORT = 2951


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "variant"
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    src = os.path.join(SPIKE, "variants", "A-events") if which == "variant" else os.path.join(SPIKE, "ext")
    xpi = build_xpi(src, os.path.join(SPIKE, "profiles", "_xpi", f"A-c1b-{which}.xpi"))
    prof = make_profile(f"A-c1b-{which}", PORT)
    out = {"which": which, "iters": iters, "ops": []}
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]

        def mark(label):
            if which == "variant":
                z.ext(h, "bg", [{"type": "mark", "label": label}])
            out["ops"].append(label)

        for i in range(iters):
            ids = create_tabs(z, h, f"r{i}", 4)
            tabs = {t["id"]: t for t in val(api(z, h, "tabs.query", {"currentWindow": True}))}
            strip = sorted(ids, key=lambda t: tabs[t]["index"])
            kind = ["noncontig_last_first", "contig", "first_last"][i % 3]
            tids = {"noncontig_last_first": [strip[3], strip[0]], "contig": [strip[1], strip[2]],
                    "first_last": [strip[0], strip[3]]}[kind]
            mark(f"i{i}:group:{kind}")
            gid = val(api(z, h, "tabs.group", {"tabIds": tids}))
            mark(f"i{i}:update")
            api(z, h, "tabGroups.update", gid, {"title": f"R{i}"})
            cur = val(api(z, h, "tabs.query", {"currentWindow": True}))
            mn = min(t["index"] for t in cur if not t["pinned"])
            mark(f"i{i}:move_top:{gid}")
            api(z, h, "tabGroups.move", gid, {"index": mn})
            if i % 2 == 0:
                loose = [t for t in strip if t not in tids]
                mark(f"i{i}:add_to_group")
                api(z, h, "tabs.group", {"tabIds": [loose[0]], "groupId": gid})
            z.ext(h, "sleep", [150])
        z.ext(h, "sleep", [1500])
        if which == "variant":
            z.ext(h, "bg", [{"type": "flush"}])
        log = log_entries(z, h)
        out["log"] = log
        out["groups_end"] = val(api(z, h, "tabGroups.query", {}))
        out["dom_groups_end"] = [(g["id"], g["label"], len(g["tabs"])) for g in inspect(z)["groups"]]
    finally:
        z.quit()
    removed = [e for e in out["log"] if e["event"] == "tabGroups.onRemoved"]
    alive = {g["id"] for g in out["groups_end"]}
    # attribute each onRemoved to the preceding mark
    last_mark, attributed = None, []
    for e in out["log"]:
        if e["event"] == "mark":
            last_mark = e["label"]
        elif e["event"] == "tabGroups.onRemoved":
            attributed.append({"after_mark": last_mark, "id": e["id"], "stillExists": e.get("stillExists"),
                               "aliveAtEnd": e["id"] in alive})
    out["summary"] = {"onRemoved": len(removed), "attributed": attributed,
                      "groups_alive_end": len(alive), "created": sum(1 for e in out["log"] if e["event"] == "tabGroups.onCreated")}
    print(json.dumps(out["summary"], indent=1))
    print("saved", save_result(f"A-check1b-removed-{which}", out))


if __name__ == "__main__":
    main()
