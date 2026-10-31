"""VA: positive control for group A's onRemoved conclusion (their 1b loop had none: 0 events could also mean a dead
listener). Real removals must produce tabGroups.onRemoved with isWindowClosing:false; partial ungroup must not.
Throwaway spike code."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VA_common import (ADDON, SPIKE, ZenSession, api, build_xpi, create_tabs, log_entries, make_profile,  # noqa: E402
                       save_result, val)

PORT = 2965


def main():
    xpi = build_xpi(os.path.join(SPIKE, "variants", "VA-events"), os.path.join(SPIKE, "profiles", "_xpi", "VA-c1c.xpi"))
    prof = make_profile("VA-c1c", PORT)
    out = {}
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        mark = lambda label: z.ext(h, "bg", [{"type": "mark", "label": label}])  # noqa: E731
        a, b, c = create_tabs(z, h, "a", 2), create_tabs(z, h, "b", 2), create_tabs(z, h, "c", 2)
        ga = val(api(z, h, "tabs.group", {"tabIds": a}))
        gb = val(api(z, h, "tabs.group", {"tabIds": b}))
        gc = val(api(z, h, "tabs.group", {"tabIds": c}))
        out["ids"] = {"ga": ga, "gb": gb, "gc": gc}
        mark("ungroup_all_a")
        out["ungroup_a"] = api(z, h, "tabs.ungroup", a)
        z.ext(h, "sleep", [300])
        mark("remove_tabs_b")
        out["remove_b"] = api(z, h, "tabs.remove", b)
        z.ext(h, "sleep", [300])
        mark("ungroup_one_c")
        out["ungroup_c1"] = api(z, h, "tabs.ungroup", [c[0]])
        z.ext(h, "sleep", [300])
        mark("end")
        out["groups_end"] = val(api(z, h, "tabGroups.query", {}))
        z.ext(h, "bg", [{"type": "flush"}])
        out["log"] = log_entries(z, h)
    finally:
        z.quit()
    last, rows = None, []
    for e in out["log"]:
        if e["event"] == "mark":
            last = e["label"]
        elif e["event"].startswith("tabGroups.onRemoved"):
            rows.append({"after": last, "event": e["event"], "id": e["id"], "info": e.get("info"),
                         "stillExists": e.get("stillExists")})
    out["summary"] = {"removed_events": rows, "alive_end": [g["id"] for g in out["groups_end"]], "ids": out["ids"]}
    print(json.dumps(out["summary"], indent=1))
    print("saved", save_result("VA-check1c-removed-ctrl", out))


if __name__ == "__main__":
    main()
