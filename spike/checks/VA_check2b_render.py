"""Group A, check 2 phase 1b: rendering probe for invisible characters.

The phase-1 screenshot showed a visible circle for the 'all candidates' label although every single char measured
0 px. This probe measures, inside a real tab-group label element (same font/style), the text width delta of:
  - singles in several positions, every ordered pair, and every triple-free subsequence of the 'all' title,
  - every SIG + 3-char ICON code (125) followed by several scripts (Latin, Arabic, CJK, digit, Cyrillic, Hebrew,
    Devanagari, Mongolian), for candidate SIG/ICON sets.
Text is set on the label element only for measurement; survival through the API is tested in phase 1.
"""
import itertools
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VA_common import (ADDON, SPIKE, ZenSession, api, build_xpi, create_tabs, make_profile, save_result,  # noqa: E402
                      screenshot, val)

PORT = 2965
CANDS = [0x200B, 0x200C, 0x200D, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x180E]

MEASURE_JS = r"""
const [cases, style, done] = arguments;
const win = Services.wm.getMostRecentWindow("navigator:browser");
const doc = win.document;
const g = win.gBrowser.tabGroups[0];
const labelEl = g.querySelector(":scope > .tab-group-label-container > .tab-group-label");
const saved = labelEl.textContent;
const savedStyle = labelEl.getAttribute("style");
if (style) labelEl.setAttribute("style", style);
const width = s => {
  labelEl.textContent = s;
  const r = doc.createRange(); r.selectNodeContents(labelEl);
  return r.getBoundingClientRect().width;
};
const out = cases.map(([test, ref]) => [width(test), width(ref)]);
labelEl.textContent = saved;
if (savedStyle == null) labelEl.removeAttribute("style"); else labelEl.setAttribute("style", savedStyle);
done({out, font: win.getComputedStyle(labelEl).fontFamily, size: win.getComputedStyle(labelEl).fontSize});
"""


def measure(z, cases, style=None):
    res = z.chrome(MEASURE_JS, [cases, style])
    return res


def main():
    out = {}
    xpi = build_xpi(os.path.join(SPIKE, "variants", "VA-events"), os.path.join(SPIKE, "profiles", "_xpi", "VA-c2b.xpi"))
    prof = make_profile("VA-c2b", PORT)
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        z.install_addon(xpi)
        h = z.open_ext_page(ADDON)["handle"]
        ids = create_tabs(z, h, "c2b", 2)
        gid = val(api(z, h, "tabs.group", {"tabIds": [ids[0]]}))
        api(z, h, "tabGroups.update", gid, {"title": "Probe"})

        # singles in positions
        cases, labels = [], []
        for c in CANDS:
            ch = chr(c)
            for pos, (t, r) in {"mid": ("N" + ch + "N", "NN"), "lead": (ch + "N", "N"), "trail": ("N" + ch, "N"),
                                "lead_arabic": (ch + "عرب", "عرب"),
                                "after_arabic": ("ع" + ch + "ر", "عر")}.items():
                cases.append([t, r]); labels.append(("single", f"U+{c:04X}", pos))
        # ordered pairs
        for a, b in itertools.product(CANDS, CANDS):
            cases.append(["N" + chr(a) + chr(b) + "N", "NN"]); labels.append(("pair", f"U+{a:04X}", f"U+{b:04X}"))
            cases.append([chr(a) + chr(b) + "N", "N"]); labels.append(("pairlead", f"U+{a:04X}", f"U+{b:04X}"))
        # the 'all' title and its prefixes
        allstr = "".join(chr(c) for c in CANDS)
        for i in range(1, len(CANDS) + 1):
            cases.append([allstr[:i] + "All", "All"]); labels.append(("allprefix", i, f"U+{CANDS[i-1]:04X}"))
        r = measure(z, cases)
        out["font"] = (r["font"], r["size"])
        rows = []
        for lab, (w_t, w_r) in zip(labels, r["out"]):
            rows.append({"case": lab, "delta": round(w_t - w_r, 3)})
        out["matrix"] = rows
        out["nonzero"] = [x for x in rows if abs(x["delta"]) > 0.01]

        # Candidate SIG/ICON sets: every code followed by several scripts.
        followers = {"latin": "Work", "arabic": "عمل", "cjk": "工作", "digit": "2024",
                     "cyrillic": "Раб", "hebrew": "עבו", "devanagari": "काम",
                     "mongolian": "ᠪᠠ", "space": " x", "emoji": "⭐x"}
        sets = {
            "A": {"sig": [0x2063, 0x2062], "icon": [0x2060, 0x2061, 0x2064, 0x200B, 0x180E]},
            "B": {"sig": [0x2063, 0x2062], "icon": [0x2060, 0x2061, 0x2064, 0x200B, 0xFEFF]},
            "C": {"sig": [0x2063, 0x2062], "icon": [0x2060, 0x2061, 0x2064, 0x200B, 0x200C]},
        }
        out["sets"] = {}
        for name, s in sets.items():
            sig = "".join(chr(c) for c in s["sig"])
            cases, labels = [], []
            for code in itertools.product(range(5), repeat=3):
                icon = "".join(chr(s["icon"][d]) for d in code)
                for fk, fv in followers.items():
                    cases.append([sig + icon + fv, fv]); labels.append(("".join(map(str, code)), fk))
            r = measure(z, cases)
            bad = [{"code": lab[0], "follower": lab[1], "delta": round(w_t - w_r, 3)}
                   for lab, (w_t, w_r) in zip(labels, r["out"]) if abs(w_t - w_r) > 0.01]
            out["sets"][name] = {"sig": [f"U+{c:04X}" for c in s["sig"]], "icon": [f"U+{c:04X}" for c in s["icon"]],
                                 "cases": len(cases), "nonzero": bad[:60], "nonzero_count": len(bad)}

        # VA extension: more scripts / tricky starts for the chosen set A, at normal and bold weight
        xfollowers = {"thai": "งาน", "khmer": "ការងារ", "myanmar": "အလုပ်", "tamil": "வேலை", "bengali": "কাজ",
                      "korean": "작업", "kana": "しごと", "greek": "Εργα", "armenian": "Աշխ", "georgian": "სამ",
                      "ethiopic": "ሥራ", "tibetan": "ལས་", "sinhala": "වැඩ", "persian_zwnj": "می‌خواهم",
                      "combining_start": "́ab", "emoji_zwj": "👩‍💻x", "flag": "🇫🇷x",
                      "keycap": "1️⃣x", "vs16": "❤️x", "rtl_mark": "‏ab", "latin": "Work",
                      "mongolian_fvs": "ᠪ᠋ᠠ", "nbsp": " x", "digits": "2024"}
        xfollowers = {k: v.encode("utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8") if "\\" in v else v
                      for k, v in xfollowers.items()}
        out["va_ext"] = {}
        sA = sets["A"]
        sigA = "".join(chr(c) for c in sA["sig"])
        for style_name, style in (("normal", None), ("bold", "font-weight: 700"), ("big", "font-size: 20px")):
            cases, labels = [], []
            for code in itertools.product(range(5), repeat=3):
                icon = "".join(chr(sA["icon"][d]) for d in code)
                for fk, fv in xfollowers.items():
                    cases.append([sigA + icon + fv, fv]); labels.append(("".join(map(str, code)), fk))
            r = measure(z, cases, style)
            bad = [{"code": lab[0], "follower": lab[1], "delta": round(w_t - w_r, 3)}
                   for lab, (w_t, w_r) in zip(labels, r["out"]) if abs(w_t - w_r) > 0.01]
            by_f = {}
            for b in bad:
                by_f.setdefault(b["follower"], []).append(b["delta"])
            out["va_ext"][style_name] = {"cases": len(cases), "nonzero_count": len(bad),
                                         "by_follower": {k: [len(v), min(v), max(v)] for k, v in by_f.items()},
                                         "sample": bad[:20]}
        # VA: positive control for the width method: a visible char must register
        r = measure(z, [["N◌N", "NN"], ["Nx" + "N", "NN"]])
        out["va_positive_control"] = [round(a - b, 3) for a, b in r["out"]]
        # VA: non-adjacent U+200C ... U+180E, and ICON(444 = 180E x3) followed by a name that contains ZWNJ/ZWJ later
        g444 = sigA + chr(0x180E) * 3
        nonadj = [["N" + chr(0x200C) + chr(0x2060) + chr(0x180E) + "N", "NN"],
                  ["N" + chr(0x180E) + chr(0x2061) + chr(0x2064) + chr(0x200C) + "N", "NN"],
                  [g444 + "ab" + chr(0x200C) + "cd", "ab" + chr(0x200C) + "cd"],
                  [g444 + "ab" + chr(0x200D) + "cd", "ab" + chr(0x200D) + "cd"],
                  [g444 + "Work" + chr(0x180E), "Work" + chr(0x180E)]]
        r = measure(z, nonadj)
        out["va_nonadjacent"] = [round(a - b, 3) for a, b in r["out"]]

        # visual evidence: labels for the 'all' string and suspicious chars
        demo = val(api(z, h, "tabs.group", {"tabIds": [ids[1]]}))
        api(z, h, "tabGroups.update", demo, {"title": "﻿᠎All"})
        try:
            out["screenshot"] = screenshot(z, "#tabbrowser-tabs", os.path.join(SPIKE, "results", "VA-check2b-render.png"))
        except Exception as e:
            out["screenshot"] = f"error: {e}"
    finally:
        z.quit()
    print(json.dumps({"font": out["font"], "nonzero": out["nonzero"],
                      "sets": {k: {kk: v[kk] for kk in ("sig", "icon", "cases", "nonzero_count")} | {"sample": v["nonzero"][:12]}
                               for k, v in out["sets"].items()}}, indent=1, ensure_ascii=True))
    print(json.dumps({"va_ext": {k: {kk: v[kk] for kk in ("cases", "nonzero_count", "by_follower")} for k, v in out.get("va_ext", {}).items()},
                      "va_positive_control": out.get("va_positive_control"), "va_nonadjacent": out.get("va_nonadjacent")},
                     indent=1, ensure_ascii=True))
    print("saved", save_result("VA-check2b-render", out))


if __name__ == "__main__":
    main()
