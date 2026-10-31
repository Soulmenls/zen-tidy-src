"""Group A: consolidate key evidence from the saved result files into results/A-summary.json."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from A_common import ICON_ALPHABET, SIG, SPIKE, save_result  # noqa: E402

R = os.path.join(SPIKE, "results")


def load(name):
    with open(os.path.join(R, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def main():
    s = {}
    c1 = load("A-check1-groups")
    steps = {x["step"]: x for x in c1["steps"]}
    s["check1"] = {
        "verdict": c1["verdict"],
        "g1": {"tabIds_titles": steps["group_g1"]["titles"], "normalOrder": steps["group_g1"]["dom"]["normalOrder"]},
        "g2": {"tabIds_titles": steps["group_g2"]["titles"], "normalOrder": steps["group_g2"]["dom"]["normalOrder"]},
        "after_moves_normalOrder": steps["move_g1_top"]["dom"]["normalOrder"],
        "dom_groups": steps["move_g1_top"]["dom"]["groups"],
        "collapsed_dom": {k: steps["update_g1_collapsed"]["dom_group"][k] for k in ("collapsedAttr", "collapsedProp")},
        "collapsed_tabs_display_without_fix": [(t["display"], t["height"]) for t in steps["update_g1_collapsed"]["dom_group"]["tabs"]],
        "move_index0": steps["probe_move_index0"]["move"],
        "shutdown_onRemoved": [e for e in load("A-check1-groups-run3")["log"] if e["event"] == "tabGroups.onRemoved"],
    }
    c2a = load("A-check2a-chars")
    c2b = load("A-check2b-render")
    c2c = load("A-check2c-css")
    s["check2"] = {
        "surviving": c2a["surviving"],
        "width_delta_vs_control": {k: v["width_delta_vs_control"] for k, v in c2a["per_char"].items()},
        "specials": {"before": c2a["specials_before"], "after": c2a["specials_after"]},
        "render_nonzero_cases": c2b["nonzero"],
        "candidate_sets": {k: {"sig": v["sig"], "icon": v["icon"], "nonzero_count": v["nonzero_count"],
                               "nonzero_followers": sorted({x["follower"] for x in v["nonzero"]})} for k, v in c2b["sets"].items()},
        "chosen": {"SIG": [f"U+{c:04X}" for c in SIG], "ICON_ALPHABET": [f"U+{c:04X}" for c in ICON_ALPHABET]},
        "css_eval_before": c2c["eval_before"],
        "css_eval_after_restart": c2c["eval_after"],
        "titles_after_restart_exact": c2c["titles_after"],
    }
    c3 = [load("A-check3-collapse-run1"), load("A-check3-collapse-run2")]
    s["check3"] = []
    for run in c3:
        st = {x["step"]: x for x in run["steps"]}
        def g(step, k):
            d = st[step]["dom"].get(k)
            return None if not d else {"collapsedAttr": d["collapsedAttr"], "visible": d["visible_tabs"], "hidden": d["hidden_tabs"]}
        names = {v: k for k, v in run["G"].items()}
        s["check3"].append({
            "A1_collapsed": {k: g("A1_collapsed", k) for k in run["G"]},
            "A2_selected_tab_in_collapsed_beta": st["A2_selected_in_collapsed_beta"]["dom"]["beta"]["tabs"],
            "A4_session_before_restart": st["A4_before_restart"]["session"],
            "A5_after_restart_mode_off": {k: g("A5_after_restart_mode_off", k) for k in run["G"]},
            "A5_session_after_restart": st["A5_after_restart_mode_off"]["session"],
            "B2_early": {k: g("B2_after_restart_early", k) for k in run["G"]},
            "B3_settled": {k: g("B3_after_restart_settled", k) for k in run["G"]},
            "C1_retidy_recollapse": {"mid": st["C1_retidy_alpha_with_recollapse"]["result"]["value"]["mid"]["collapsed"],
                                      "after": st["C1_retidy_alpha_with_recollapse"]["result"]["value"]["after"]["collapsed"],
                                      "dom": g("C1_retidy_alpha_with_recollapse", "alpha")},
            "C2_retidy_no_recollapse": {"mid": st["C2_retidy_beta_no_recollapse"]["result"]["value"]["mid"]["collapsed"],
                                         "dom": g("C2_retidy_beta_no_recollapse", "beta")},
            "events": [{**{k: v for k, v in e.items() if k not in ("title", "groups", "before", "mid", "after", "g")},
                        **({"id": names.get(e["id"], e["id"])} if "id" in e else {})}
                       for e in run["log"] if e["event"] in ("bgLoaded", "onStartup", "onInstalled", "tabGroups.onUpdated",
                                                            "apply", "mark", "retidy.afterGroup", "retidy.recollapsed",
                                                            "tabGroups.onRemoved")],
        })
    print(save_result("A-summary", s))


if __name__ == "__main__":
    main()
