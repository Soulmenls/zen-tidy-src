"""Group A, check 2 phase 2: userChrome.css matches SIG+ICON labels, icons render, non-SIG groups don't match.
Verified with getComputedStyle(container, '::before'), the label's layout offset, and ink pixels drawn left of the
label (drawWindow). Repeated after a restart."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from A_common import (ADDON, ICON_ALPHABET, ICON_DIR, ICON_PROBE_JS, SIG, SPIKE, ZenSession, api, build_css,  # noqa: E402
                      build_xpi, create_tabs, dom_to_api_id, icon_str, make_profile, save_result, screenshot,
                      sig_str, val)

PORT = 2955
ICONS = {"000": "folder", "001": "code", "012": "book", "432": "star", "444": "globe"}

GROUPS = [
    # key, title, expected icon (None = no ::before box)
    ("I_folder", sig_str() + icon_str("000") + "Work", "folder"),
    ("I_code", sig_str() + icon_str("001") + "Dev", "code"),
    ("I_book", sig_str() + icon_str("012") + "Reading", "book"),
    ("I_star", sig_str() + icon_str("432") + "Faves", "star"),
    ("I_globe", sig_str() + icon_str("444") + "Web", "globe"),
    ("S_sig_no_code", sig_str() + "Misc", "folder"),             # generic SIG rule -> default icon
    ("S_sig_unmapped_code", sig_str() + icon_str("333") + "Unmapped", "folder"),  # no rule for 333 -> default
    ("N_icon_no_sig", icon_str("001") + "Dev", None),
    ("N_plain", "Dev", None),
    ("N_reversed_sig", "".join(chr(c) for c in reversed(SIG)) + icon_str("001") + "Rev", None),
    ("N_sig_half", chr(SIG[0]) + icon_str("001") + "Half", None),
    ("N_empty", "", None),
]


def evaluate(probe, gids):
    by_api = {dom_to_api_id(p["id"]): p for p in probe}
    rows, ok = {}, True
    for key, title, expect in GROUPS:
        p = by_api.get(gids[key])
        if not p:
            rows[key] = {"error": "not found"}
            ok = False
            continue
        bi = p["before"]["backgroundImage"]
        has_box = p["before"]["content"] not in ("none", "normal") and p["before"]["display"] != "none"
        if expect:
            good = has_box and bi == f'url("{ICON_DIR}{expect}.svg")' and p["labelOffsetX"] >= 16 and p["inView"] and isinstance(p["ink"], int) and p["ink"] > 0
        else:
            good = (not has_box) and bi == "none" and p["labelOffsetX"] < 1  # no box: label starts at the container edge
        ok &= good
        rows[key] = {"expect": expect, "pass": good, "content": p["before"]["content"], "display": p["before"]["display"],
                     "size": (p["before"]["width"], p["before"]["height"]), "bg": bi,
                     "ctxProps": p["before"]["ctxProps"], "fill": p["before"]["fill"],
                     "labelOffsetX": round(p["labelOffsetX"], 2), "labelTextWidth": round(p["labelTextWidth"], 3),
                     "ink": p["ink"], "inkHash": p["inkHash"], "inkAvgRGB": p["inkAvgRGB"], "bgRGB": p["bgRGB"], "labelColor": p["labelColor"], "inView": p["inView"], "flexDir": p["containerFlexDirection"]}
    hashes = {rows[k]["inkHash"] for k in ("I_folder", "I_code", "I_book", "I_star", "I_globe") if "inkHash" in rows[k]}
    return {"all_pass": ok, "distinct_icon_ink_patterns": len(hashes), "rows": rows}


def main():
    css = build_css(ICONS, collapse_fix=True)
    out = {"css": css, "sig": [f"U+{c:04X}" for c in SIG], "icon_alphabet": [f"U+{c:04X}" for c in ICON_ALPHABET],
           "icons": ICONS}
    xpi = build_xpi(os.path.join(SPIKE, "variants", "A-events"), os.path.join(SPIKE, "profiles", "_xpi", "A-c2c.xpi"))
    prof = make_profile("A-c2c", PORT, user_chrome_css=css)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        ids = create_tabs(z, h, "c2c", len(GROUPS))
        gids = {}
        for (key, title, _), tid in zip(GROUPS, ids):
            gid = val(api(z, h, "tabs.group", {"tabIds": [tid]}))
            api(z, h, "tabGroups.update", gid, {"title": title})
            gids[key] = gid
        out["gids"] = gids
        z.ext(h, "sleep", [500])
        out["probe_before"] = z.chrome(ICON_PROBE_JS)
        out["eval_before"] = evaluate(out["probe_before"], gids)
        out["shot_before"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", "A-check2c-before.png"))
        z.restart()
        h = z.open_ext_page(ADDON)["handle"]
        z.ext(h, "sleep", [500])
        out["titles_after"] = {k: val(api(z, h, "tabGroups.get", g))["title"] == t
                               for (k, t, _), g in zip(GROUPS, [gids[k] for k, _, _ in GROUPS])}
        out["probe_after"] = z.chrome(ICON_PROBE_JS)
        out["eval_after"] = evaluate(out["probe_after"], gids)
        out["shot_after"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", "A-check2c-after.png"))
    finally:
        z.quit()
    for phase in ("eval_before", "eval_after"):
        e = out[phase]
        print(phase, "all_pass", e["all_pass"], "distinct_icon_ink_patterns", e["distinct_icon_ink_patterns"])
        for k, r in e["rows"].items():
            print("  ", k, json.dumps(r, ensure_ascii=True))
    print("titles_after", out["titles_after"])
    print("saved", save_result("A-check2c-css", out))


if __name__ == "__main__":
    main()
