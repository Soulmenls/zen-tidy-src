"""Group A, check 2 phase 1: which invisible characters survive
tabGroups.update({title}) -> tabGroups.get().title -> DOM label attribute -> restart.
Also measures label text width with vs without each character (glyph/box detection)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VA_common import (ADDON, SPIKE, ZenSession, api, build_xpi, cps, create_tabs, group_dom,  # noqa: E402
                      inspect, log_entries, make_profile, save_result, screenshot, val)

PORT = 2965
CANDIDATES = [0x200B, 0x200C, 0x200D, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x180E]


def title_for(c):
    ch = chr(c)
    # leading x2, middle, trailing: catches trimming, collapsing and stripping
    return ch + ch + "Na" + ch + "me" + ch


def main():
    out = {"candidates": [f"U+{c:04X}" for c in CANDIDATES], "per_char": {}}
    xpi = build_xpi(os.path.join(SPIKE, "variants", "VA-events"), os.path.join(SPIKE, "profiles", "_xpi", "VA-c2a.xpi"))
    prof = make_profile("VA-c2a", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        n = len(CANDIDATES) + 4
        ids = create_tabs(z, h, "c2a", n)
        gids = {}
        # one group per candidate
        for c, tid in zip(CANDIDATES, ids):
            gid = val(api(z, h, "tabs.group", {"tabIds": [tid]}))
            t = title_for(c)
            upd = api(z, h, "tabGroups.update", gid, {"title": t})
            got = val(api(z, h, "tabGroups.get", gid))
            gids[f"U+{c:04X}"] = gid
            out["per_char"][f"U+{c:04X}"] = {"gid": gid, "sent": cps(t), "update_title": cps(val(upd)["title"]),
                                             "get_title": cps(got["title"]), "get_equal": got["title"] == t}
        extra = ids[len(CANDIDATES):]
        # control: same visible name, no invisible chars
        g_ctrl = val(api(z, h, "tabs.group", {"tabIds": [extra[0]]}))
        api(z, h, "tabGroups.update", g_ctrl, {"title": "Name"})
        # only-invisible title (would a pure-invisible title be treated as empty?)
        g_inv = val(api(z, h, "tabs.group", {"tabIds": [extra[1]]}))
        inv_title = "⁣⁢⁡⁤"
        api(z, h, "tabGroups.update", g_inv, {"title": inv_title})
        # empty title -> what does Zen put in the label?
        g_empty = val(api(z, h, "tabs.group", {"tabIds": [extra[2]]}))
        api(z, h, "tabGroups.update", g_empty, {"title": ""})
        # all candidates concatenated
        g_all = val(api(z, h, "tabs.group", {"tabIds": [extra[3]]}))
        all_title = "".join(chr(c) for c in CANDIDATES) + "All"
        api(z, h, "tabGroups.update", g_all, {"title": all_title})
        specials = {"control": (g_ctrl, "Name"), "only_invisible": (g_inv, inv_title), "empty": (g_empty, ""),
                    "all": (g_all, all_title)}

        insp = inspect(z)
        out["dom_before"] = insp
        ctrl_dom = group_dom(insp, g_ctrl)
        out["control_width"] = ctrl_dom["labelTextWidth"] if ctrl_dom else None
        for key, info in out["per_char"].items():
            d = group_dom(insp, info["gid"])
            sent = "".join(chr(int(x[2:], 16)) for x in info["sent"])
            info["dom_label"] = d["labelHex"] if d else None
            info["dom_equal"] = bool(d) and d["label"] == sent
            info["dom_text"] = d["labelTextHex"] if d else None
            info["label_text_width"] = d["labelTextWidth"] if d else None
            info["width_delta_vs_control"] = (d["labelTextWidth"] - out["control_width"]) if d and out["control_width"] else None
        out["specials_before"] = {}
        for k, (gid, t) in specials.items():
            d = group_dom(insp, gid)
            got = val(api(z, h, "tabGroups.get", gid))
            out["specials_before"][k] = {"sent": cps(t), "get": cps(got["title"]), "dom": d["labelHex"] if d else None,
                                         "domText": d["labelTextHex"] if d else None,
                                         "width": d["labelTextWidth"] if d else None}
        try:
            out["screenshot_before"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", "VA-check2a-before.png"))
        except Exception as e:
            out["screenshot_before"] = f"error: {e}"

        z.restart()
        h = z.open_ext_page(ADDON)["handle"]
        insp2 = inspect(z)
        out["dom_after"] = insp2
        for key, info in out["per_char"].items():
            sent = "".join(chr(int(x[2:], 16)) for x in info["sent"])
            got = api(z, h, "tabGroups.get", info["gid"])
            d = group_dom(insp2, info["gid"])
            info["after_get_title"] = cps(got["value"]["title"]) if "value" in got else got
            info["after_get_equal"] = "value" in got and got["value"]["title"] == sent
            info["after_dom_equal"] = bool(d) and d["label"] == sent
            info["after_label_text_width"] = d["labelTextWidth"] if d else None
            info["survives"] = all([info["get_equal"], info["dom_equal"], info["after_get_equal"], info["after_dom_equal"]])
        out["specials_after"] = {}
        for k, (gid, t) in specials.items():
            d = group_dom(insp2, gid)
            got = api(z, h, "tabGroups.get", gid)
            out["specials_after"][k] = {"get": cps(got["value"]["title"]) if "value" in got else got,
                                        "dom": d["labelHex"] if d else None}
        try:
            out["screenshot_after"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", "VA-check2a-after.png"))
        except Exception as e:
            out["screenshot_after"] = f"error: {e}"
        z.ext(h, "bg", [{"type": "flush"}])
        out["log"] = log_entries(z, h)
    finally:
        z.quit()

    out["surviving"] = [k for k, v in out["per_char"].items() if v.get("survives")]
    summary = {k: {kk: v.get(kk) for kk in ("get_equal", "dom_equal", "after_get_equal", "after_dom_equal",
                                             "label_text_width", "width_delta_vs_control")}
               for k, v in out["per_char"].items()}
    print(json.dumps({"control_width": out["control_width"], "per_char": summary, "surviving": out["surviving"],
                      "specials_before": out["specials_before"], "specials_after": out["specials_after"]}, indent=1))
    print("saved", save_result("VA-check2a-chars", out))


if __name__ == "__main__":
    main()
