"""Verifier extra for check 5: sessions tab values are scoped to the gecko id.

Installs three copies of spike/ext (manifest id overridden at build time, nothing edited on disk):
  A zen-tidy-spike@local (permanent), B vc-other@local (permanent), T vc-temp@local (TEMPORARY install).
A sets key "tidyKey" on a tab; B and T read the same key name on the same tab (expected undefined);
B writes its own value under the same name; A must still read its own. T checks that a temporary
install with an explicit id can use the sessions storage methods. Survives a restart for A and B.
Profile VC-idscope-<tag>, Marionette port 2963.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

PORT = 2963
IDS = {"A": "zen-tidy-spike@local", "B": "vc-other@local", "T": "vc-temp@local"}


def gecko(addon_id):
    return {"browser_specific_settings": {"gecko": {"id": addon_id, "strict_min_version": "140.0",
                                                    "data_collection_permissions": {"required": ["browsingActivity"]}}},
            "name": f"VC id scope {addon_id}"}


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "i1"
    out = {"check": "5c-idscope", "tag": tag, "started": time.time()}
    xpis = {k: build_xpi(os.path.join(SPIKE, "ext"), os.path.join(SPIKE, "profiles", "_xpi", f"VC-idscope-{k}-{tag}.xpi"),
                         manifest_overrides=gecko(v)) for k, v in IDS.items()}
    prof = make_profile(f"VC-idscope-{tag}", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = {k: z.install_addon(xpis[k], temporary=(k == "T")) for k in IDS}
        pages = {k: z.open_ext_page(IDS[k])["handle"] for k in IDS}

        def call(k, path, *args):
            return z.ext(pages[k], "api", [path, list(args)])

        tab = call("A", "tabs.create", {"url": "https://example.com/vc5c/shared", "discarded": True, "active": False})["value"]
        tid = tab["id"]
        out["A_set"] = call("A", "sessions.setTabValue", tid, "tidyKey", "from-A")
        out["B_read_before"] = call("B", "sessions.getTabValue", tid, "tidyKey")
        out["T_read_before"] = call("T", "sessions.getTabValue", tid, "tidyKey")
        out["B_set"] = call("B", "sessions.setTabValue", tid, "tidyKey", "from-B")
        out["T_set"] = call("T", "sessions.setTabValue", tid, "tidyKey", "from-T")
        out["A_read_after"] = call("A", "sessions.getTabValue", tid, "tidyKey")
        out["B_read_after"] = call("B", "sessions.getTabValue", tid, "tidyKey")
        out["T_read_after"] = call("T", "sessions.getTabValue", tid, "tidyKey")
        z.restart()
        pages = {k: z.open_ext_page(IDS[k])["handle"] for k in ("A", "B")}
        pages["T_present"] = None
        tabs = z.ext(pages["A"], "api", ["tabs.query", [{"url": "https://example.com/vc5c/shared"}]])["value"]
        tid2 = tabs[0]["id"] if tabs else None
        out["after_restart"] = {
            "tab_found": bool(tabs),
            "A": z.ext(pages["A"], "api", ["sessions.getTabValue", [tid2, "tidyKey"]]),
            "B": z.ext(pages["B"], "api", ["sessions.getTabValue", [tid2, "tidyKey"]]),
        }
    finally:
        z.quit()
    out["finished"] = time.time()
    path = save_result(f"VC-5c-idscope-{tag}", out)
    print(json.dumps({k: v for k, v in out.items() if k not in ("started", "finished")}, indent=1))
    print("saved", path)


if __name__ == "__main__":
    main()
