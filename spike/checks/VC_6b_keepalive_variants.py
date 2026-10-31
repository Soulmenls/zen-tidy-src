"""Verifier refutation runs for group C check 6, using spike/variants/VC-keepalive.

Runs (each starts from a stopped event page, woken by runtime.onMessage from the spike page):
  A ctl-session15 : background storage.session.set every 15 s, 70 s fetch  -> expected to complete (positive control)
  B local10       : background storage.local.set every 10 s, 70 s fetch    -> claim: suspended at ~30 s
  C page10        : no background keepalive; the PAGE calls storage.session.set every 10 s -> claim: suspended at ~30 s
  D pagesync10    : no background keepalive; the PAGE writes storage.sync every 10 s and the background
                    has a storage.sync.onChanged listener -> events delivered to the background (reason "event")
  E session10     : background storage.session.set every 10 s, 45 s fetch  -> completes; measures timer drift at 10 s

Reuses INSTRUMENT / SAMPLER / GET_EVENTS / WAIT_STOPPED / analyse from VC_6_event_page.py.
Usage: python spike/checks/VC_6b_keepalive_variants.py [tag=v1] [marionette_port=2963] [runs=ABCDE]
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402
import VC_6_event_page as base  # noqa: E402

ADDON = "zen-tidy-spike@local"
SERVER_PY = os.path.join(SPIKE, "checks", "VC_slow_server.py")

RUNS = {
    "A": {"name": "ctl-session15", "kind": "session", "interval": 15000, "delay": 70, "page": None},
    "B": {"name": "local10", "kind": "local", "interval": 10000, "delay": 70, "page": None},
    "C": {"name": "page10", "kind": "none", "interval": 0, "delay": 70, "page": "session"},
    "D": {"name": "pagesync10", "kind": "none", "interval": 0, "delay": 70, "page": "sync"},
    "E": {"name": "session10", "kind": "session", "interval": 10000, "delay": 45, "page": None},
}


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "v1"
    port_m = int(sys.argv[2]) if len(sys.argv) > 2 else 2963
    which = sys.argv[3] if len(sys.argv) > 3 else "ABCDE"
    assert port_m in (2963, 2967), port_m
    work = os.path.join(SPIKE, "profiles", f"VC-server-{tag}")
    os.makedirs(work, exist_ok=True)
    log_path = os.path.join(SPIKE, "results", f"VC-6b-server-{tag}.log")
    port_file = os.path.join(work, "port")
    for p in (log_path, port_file):
        open(p, "w").close()

    out = {"check": "6b", "tag": tag, "marionette_port": port_m, "started": time.time(), "server_log": log_path}
    server = subprocess.Popen([sys.executable, "-u", SERVER_PY, "--port", "0", "--delay", "70",
                               "--log", log_path, "--portfile", port_file, "--max-seconds", "1500"])
    out["server_pid"] = server.pid
    z = None
    try:
        for _ in range(100):
            with open(port_file) as f:
                txt = f.read().strip()
            if txt:
                break
            time.sleep(0.1)
        port = int(txt)
        base_url = f"http://127.0.0.1:{port}/slow"
        xpi = build_xpi(os.path.join(SPIKE, "variants", "VC-keepalive"),
                        os.path.join(SPIKE, "profiles", "_xpi", f"VC-keepalive-{tag}.xpi"))
        prof = make_profile(f"VC-keepalive-{tag}", port_m)
        z = ZenSession(prof, port_m, headless=True).launch()
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["env"] = z.chrome(base.INSTRUMENT, [ADDON])

        runs = []
        for key in which:
            cfg = RUNS[key]
            label = f"{tag}-{cfg['name']}"
            rec = {"label": label, "cfg": cfg, "keepalive": cfg["kind"] != "none"}
            rec["wait_stopped_before"] = z.chrome(base.WAIT_STOPPED, [ADDON, 75000])
            if cfg["page"]:
                rec["page_ka_start"] = z.ext(h, "startPageKeepalive", [10000, label, cfg["page"]])
            url = f"{base_url}?delay={cfg['delay']}&label={label}"
            rec["t_send"] = time.time()
            rec["send"] = z.ext(h, "bg", [{"type": "longFetch2", "url": url, "kind": cfg["kind"],
                                           "intervalMs": cfg["interval"], "label": label}])
            rec["sample"] = z.chrome(base.SAMPLER, [ADDON, int(cfg["delay"] * 1000 + 20000), 100, log_path, label, 4000])
            if cfg["page"]:
                rec["page_ticks"] = z.ext(h, "stopPageKeepalive", [])
            rec["chrome_events"] = z.chrome(base.GET_EVENTS, [rec["t_send"] * 1000 - 2000])
            store = z.ext(h, "api", ["storage.local.get", [["spikeLog", "kaLocalTicks"]]])["value"]
            rec["spikeLog"] = [e for e in store.get("spikeLog", []) if e.get("label") == label]
            rec["kaLocalTicks"] = [e for e in store.get("kaLocalTicks", []) if e.get("label") == label]
            rec["server"] = [e for e in base.read_server_log(log_path) if e.get("label") == label]
            rec["analysis"] = base.analyse(rec)
            a = rec["analysis"]
            resets = [(r["at_s"], r.get("reason"), r.get("path") or r.get("eventName")) for r in a["idle_resets"]]
            rec["summary"] = {
                "label": label, "fetch_done": a["fetch_done"], "done_ms": a["fetch_done_ms"],
                "server": [a["server_outcome"], a["server_outcome_after_request_start_s"], a["server_outcome_how"]],
                "bg_stopped_at_s": a["bg_stopped_at_s"], "resets": resets,
                "kaLocalTicks_s": [round(e["since_start_ms"] / 1000, 2) for e in rec["kaLocalTicks"]],
                "page_ticks": [(round((e["t"] / 1000) - rec["t_send"], 2), e.get("ok"), e.get("area"), e.get("error"))
                               for e in (rec.get("page_ticks") or {}).get("value", [])] if cfg["page"] else None,
                "devtools": a["devtools_attached_during_run"],
            }
            runs.append(rec)
            print(json.dumps(rec["summary"]), flush=True)
        out["runs"] = runs
    finally:
        if z:
            z.quit()
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(server.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        out["server_exit_code"] = server.poll()
    out["server_log_all"] = base.read_server_log(log_path)
    out["finished"] = time.time()
    path = save_result(f"VC-6b-keepalive-variants-{tag}", out)
    print("saved", path)


if __name__ == "__main__":
    main()
