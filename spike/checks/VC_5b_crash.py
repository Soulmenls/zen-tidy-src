"""Verifier extra for check 5: do tab values survive a HARD KILL (crash-style restart), and how fresh?

Not one of group C's claims; it probes the limit of "tab keys survive a restart" for the spec's
"Zen killed mid-Apply" edge case. Throwaway profile VC-crash-<tag>, Marionette port 2967.
browser.sessionstore.resume_from_crash is set to true here (the shared template sets it false),
because that is the default a real user has.

Keys are written at known times before the kill: t-40 s, t-20 s, t-8 s, t-2 s. Then the Zen process
tree that THIS script launched is killed by PID (taskkill /T /F), Zen is relaunched, and values are read.
Usage: python spike/checks/VC_5b_crash.py [tag=k1]
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

ADDON = "zen-tidy-spike@local"
PORT = 2967
SCHEDULE = [("m40", 40), ("m20", 20), ("m8", 8), ("m2", 2)]  # (key, seconds before kill)


def call(z, h, path, *args):
    return z.ext(h, "api", [path, list(args)])


def must(r, what):
    if not isinstance(r, dict) or "error" in r:
        raise RuntimeError(f"{what} failed: {r}")
    return r["value"]


def mtimes(prof):
    out = {}
    for rel in ("sessionstore.jsonlz4", "zen-sessions.jsonlz4", "sessionstore-backups/recovery.jsonlz4",
                "sessionstore-backups/recovery.baklz4"):
        p = os.path.join(prof, rel)
        out[rel] = round(os.stat(p).st_mtime, 2) if os.path.exists(p) else None
    return out


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "k1"
    out = {"check": "5b-crash", "tag": tag, "started": time.time()}
    xpi = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(SPIKE, "profiles", "_xpi", f"VC-spike-5b-{tag}.xpi"))
    prof = make_profile(f"VC-crash-{tag}", PORT, extra_prefs={"browser.sessionstore.resume_from_crash": True})
    z = ZenSession(prof, PORT, headless=True).launch()
    try:
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        h, spike_url = page["handle"], page["url"]
        out["prefs"] = z.chrome("""
            const done = arguments[arguments.length - 1];
            const g = n => { try { return Services.prefs.getIntPref(n); } catch (e) {
                try { return Services.prefs.getBoolPref(n); } catch (e2) { return null; } } };
            done({interval: g("browser.sessionstore.interval"), resume: g("browser.sessionstore.resume_from_crash"),
                  maxResumed: g("browser.sessionstore.max_resumed_crashes")});
        """)
        # A baseline tab with a key, created well before everything else (and a restart, so it is on disk for sure).
        base = must(call(z, h, "tabs.create", {"url": "https://example.com/vc5b/base", "discarded": True,
                                               "active": False, "title": "base"}), "create base")
        must(call(z, h, "sessions.setTabValue", base["id"], "k", "base"), "set base")
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        tabs = must(call(z, h, "tabs.query", {}), "q")
        out["after_clean_restart"] = [(t["url"], call(z, h, "sessions.getTabValue", t["id"], "k").get("value"))
                                      for t in tabs if t["url"] != spike_url]
        base_id = next(t["id"] for t in tabs if t["url"].endswith("/vc5b/base"))

        # Each scheduled key goes on (a) the base tab under its own name and (b) a NEW tab created at that time.
        t_kill = time.time() + SCHEDULE[0][1] + 1
        written = {}
        for key, before in SCHEDULE:
            while time.time() < t_kill - before:
                time.sleep(0.05)
            t = must(call(z, h, "tabs.create", {"url": f"https://example.com/vc5b/{key}", "discarded": True,
                                                "active": False, "title": key}), "create")
            r1 = call(z, h, "sessions.setTabValue", t["id"], "k", key)
            r2 = call(z, h, "sessions.setTabValue", base_id, key, f"on-base-{key}")
            written[key] = {"at": time.time(), "before_kill_planned_s": before, "new_tab": t["id"],
                            "set_new": r1, "set_base": r2, "mtimes": mtimes(prof)}
        while time.time() < t_kill:
            time.sleep(0.05)
        out["written"] = written
        out["mtimes_before_kill"] = mtimes(prof)
        pid = z.proc.pid
        out["killed_pid"] = pid
        out["t_kill"] = time.time()
        # Only the process tree this script launched.
        out["taskkill"] = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                                         capture_output=True, text=True).returncode
        try:
            z.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            out["wait_timeout"] = True
        try:
            z.m.close()
        except Exception:
            pass
        z.m = None
        z.proc = None
        time.sleep(3)
        out["mtimes_after_kill"] = mtimes(prof)

        z.launch()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        tabs = must(call(z, h, "tabs.query", {}), "q")
        snap = []
        for t in tabs:
            if t["url"] == spike_url:
                continue
            vals = {}
            for k in ["k"] + [s[0] for s in SCHEDULE]:
                v = call(z, h, "sessions.getTabValue", t["id"], k).get("value")
                if v is not None:
                    vals[k] = v
            snap.append({"index": t["index"], "url": t["url"], "discarded": t["discarded"], "values": vals})
        out["after_kill_restart"] = snap
        out["windows_after_kill_restart"] = len(must(call(z, h, "windows.getAll", {}), "w"))
        urls = [s["url"] for s in snap]
        base_vals = next((s["values"] for s in snap if s["url"].endswith("/vc5b/base")), None)
        out["verdict"] = {
            key: {"new_tab_present": f"https://example.com/vc5b/{key}" in urls,
                  "new_tab_key": next((s["values"].get("k") for s in snap if s["url"].endswith(f"/vc5b/{key}")), None),
                  "base_tab_key": (base_vals or {}).get(key)}
            for key, _ in SCHEDULE
        }
        out["verdict"]["base_present_with_k"] = (base_vals or {}).get("k")
    finally:
        z.quit()
    out["finished"] = time.time()
    path = save_result(f"VC-5b-crash-{tag}", out)
    print(json.dumps({"prefs": out.get("prefs"), "after_clean_restart": out.get("after_clean_restart"),
                      "verdict": out.get("verdict"), "taskkill": out.get("taskkill"),
                      "mtimes_before_kill": out.get("mtimes_before_kill"), "t_kill": out.get("t_kill"),
                      "written_at": {k: round(v["at"], 2) for k, v in out.get("written", {}).items()},
                      "windows": out.get("windows_after_kill_restart"),
                      "after_kill_restart": out.get("after_kill_restart")}, indent=1))
    print("saved", path)


if __name__ == "__main__":
    main()
