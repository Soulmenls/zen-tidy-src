"""Harness smoke test: launch, install the spike extension, call APIs, restart, check persistence."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

ADDON = "zen-tidy-spike@local"
PORT = 2941


def main():
    out = {}
    xpi = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(SPIKE, "profiles", "_xpi", "spike-smoke.xpi"))
    prof = make_profile("smoke", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        out["page"] = page
        h = page["handle"]
        urls = [f"https://example.com/smoke/{i}" for i in range(4)]
        created = []
        for i, u in enumerate(urls):
            r = z.ext(h, "api", ["tabs.create", [{"url": u, "title": f"Smoke {i}", "discarded": True, "active": False}]])
            created.append(r)
        out["created"] = created
        ids = [c["value"]["id"] for c in created if "value" in c]
        out["group"] = z.ext(h, "api", ["tabs.group", [{"tabIds": ids[:2]}]])
        gid = out["group"].get("value")
        out["update"] = z.ext(h, "api", ["tabGroups.update", [gid, {"title": "Smoke group"}]])
        out["query_before"] = z.ext(h, "api", ["tabs.query", [{"currentWindow": True}]])
        out["groups_before"] = z.ext(h, "api", ["tabGroups.query", [{}]])
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["query_after"] = z.ext(h, "api", ["tabs.query", [{"currentWindow": True}]])
        out["groups_after"] = z.ext(h, "api", ["tabGroups.query", [{}]])
        out["log"] = z.ext(h, "api", ["storage.local.get", ["spikeLog"]])
    finally:
        z.quit()
    path = save_result("smoke", out)
    summary = {
        "install": out.get("install"),
        "group": out.get("group"),
        "groups_before": [(g["id"], g["title"]) for g in out.get("groups_before", {}).get("value", [])],
        "groups_after": [(g["id"], g["title"]) for g in out.get("groups_after", {}).get("value", [])],
        "tabs_after": [(t["id"], t["groupId"], t["pinned"], t["url"][:60]) for t in out.get("query_after", {}).get("value", [])],
    }
    print(json.dumps(summary, indent=1))
    print("saved", path)


if __name__ == "__main__":
    main()
