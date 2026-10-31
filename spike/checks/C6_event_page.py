"""Group C, check 6: MV3 event-page lifetime during a slow fetch (no devtools toolbox attached).

Starts C_slow_server.py on 127.0.0.1 (own process, stopped by PID at the end), then from the spike page
sends {type:"longFetch"} to the event page, with and without the storage.session keepalive.
While a fetch is in flight nothing calls into the extension: the harness only samples
extension.backgroundState in chrome scope (a plain property read in the parent process) and reads
the server's log file with IOUtils. Afterwards it reads storage.local spikeLog from the spike page.
Finally it restarts Zen and checks that storage.session is empty.

Usage: python spike/checks/C6_event_page.py [tag=r1] [rounds=2] [delay_s=70] [marionette_port=2957|2953]
Throwaway profile C-eventpage-<tag>.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

ADDON = "zen-tidy-spike@local"
PORT = 2957
SERVER_PY = os.path.join(SPIKE, "checks", "C_slow_server.py")

INSTRUMENT = r"""
const [addonId, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const policy = WebExtensionPolicy.getByID(addonId);
  const ext = policy && policy.extension;
  if (!ext) return done({ error: "extension not found" });
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const pref = name => {
    const type = Services.prefs.getPrefType(name);
    let value = null;
    if (type === Services.prefs.PREF_INT) value = Services.prefs.getIntPref(name);
    else if (type === Services.prefs.PREF_BOOL) value = Services.prefs.getBoolPref(name);
    else if (type === Services.prefs.PREF_STRING) value = Services.prefs.getStringPref(name);
    return { exists: type !== Services.prefs.PREF_INVALID, type, value,
             hasUserValue: type !== Services.prefs.PREF_INVALID && Services.prefs.prefHasUserValue(name) };
  };
  let marionetteRunning = null;
  try { marionetteRunning = Cc["@mozilla.org/remote/marionette;1"].getService(Ci.nsIMarionette).running; } catch (e) {}
  const info = {
    prefs: Object.fromEntries([
      "extensions.background.idle.timeout",
      "extensions.background.idle.enabled",
      "extensions.eventPages.enabled",
      "extensions.backgroundServiceWorker.enabled",
      "devtools.debugger.remote-enabled",
      "devtools.chrome.enabled",
    ].map(n => [n, pref(n)])),
    appVersion: Services.appinfo.version,
    manifestVersion: ext.manifestVersion,
    persistentBackground: ext.persistentBackground,
    backgroundState: ext.backgroundState,
    devtoolsAttached: ExtensionParent.DebugUtils.hasDevToolsAttached(addonId),
    isInAutomation: Cu.isInAutomation,
    marionetteRunning,
  };
  if (!win.__c6 || win.__c6.ext !== ext) {
    const store = { ext, events: [] };
    win.__c6 = store;
    const names = [
      "start-background-script", "background-script-event", "background-script-started",
      "background-script-reset-idle", "background-script-idle-waituntil",
      "background-script-suspend", "background-script-suspend-canceled",
      "background-script-suspend-ignored", "shutdown-background-script",
    ];
    for (const name of names) {
      // Must return undefined: EventEmitter.emit awaits returned values.
      ext.on(name, (ev, data) => {
        let d = null;
        try {
          d = data && typeof data === "object"
            ? { reason: data.reason, path: data.path, eventName: data.eventName, pendingListeners: data.pendingListeners }
            : (data === undefined ? null : String(data));
        } catch (e) { d = String(e); }
        store.events.push({ t: Date.now(), ev: name, state: ext.backgroundState, data: d });
      });
    }
    info.instrumented = names;
  }
  done(info);
})();
"""

WAIT_STOPPED = r"""
const [addonId, maxMs, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const ext = WebExtensionPolicy.getByID(addonId).extension;
  const t0 = Date.now();
  while (ext.backgroundState !== "stopped" && Date.now() - t0 < maxMs) {
    await new Promise(r => win.setTimeout(r, 200));
  }
  done({ state: ext.backgroundState, waitedMs: Date.now() - t0 });
})();
"""

# Read-only observer: samples backgroundState and tails the server log. Touches nothing in the extension.
SAMPLER = r"""
const [addonId, maxMs, intervalMs, logPath, label, graceMs, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const ext = WebExtensionPolicy.getByID(addonId).extension;
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const t0 = Date.now();
  const transitions = [];
  let last = null, terminal = null, terminalAt = 0, lastFileCheck = 0, devtoolsEver = false;
  while (Date.now() - t0 < maxMs) {
    const s = ext.backgroundState;
    if (s !== last) { transitions.push({ t: Date.now(), state: s, hasContext: !!ext.backgroundContext }); last = s; }
    if (ExtensionParent.DebugUtils.hasDevToolsAttached(addonId)) devtoolsEver = true;
    if (!terminal && Date.now() - lastFileCheck > 1000) {
      lastFileCheck = Date.now();
      try {
        const text = await IOUtils.readUTF8(logPath);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.label === label && /client_disconnected|responded|write_failed/.test(e.event)) { terminal = e; terminalAt = Date.now(); }
        }
      } catch (e) {}
    }
    if (terminal && Date.now() - terminalAt > graceMs) break;
    await new Promise(r => win.setTimeout(r, intervalMs));
  }
  done({ t0, t1: Date.now(), transitions, terminal, devtoolsEver, finalState: ext.backgroundState });
})();
"""

GET_EVENTS = r"""
const [sinceMs, done] = arguments;
const win = Services.wm.getMostRecentWindow("navigator:browser");
done(((win.__c6 && win.__c6.events) || []).filter(e => e.t >= sinceMs));
"""


def read_server_log(path):
    out = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    out.append(json.loads(line))
    return out


def rel(t_ms, t0_s):
    return round(t_ms / 1000.0 - t0_s, 2)


def analyse(rec):
    t0 = rec["t_send"]
    srv = rec["server"]
    start = next((e for e in srv if e["event"] == "request.start"), None)
    end = next((e for e in srv if e["event"] != "request.start"), None)
    trans = [{"at_s": rel(x["t"], t0), "state": x["state"]} for x in rec["sample"]["transitions"]]
    stopped = next((x["at_s"] for x in trans if x["state"] == "stopped" and x["at_s"] > 0), None)
    suspending = next((x["at_s"] for x in trans if x["state"] == "suspending"), None)
    done = next((e for e in rec["spikeLog"] if e.get("event") == "longFetch.done"), None)
    resets = [{"at_s": rel(e["t"], t0), **(e["data"] or {})} for e in rec["chrome_events"]
              if e["ev"] == "background-script-reset-idle"]
    lifecycle = [{"at_s": rel(e["t"], t0), "ev": e["ev"], "state": e["state"]} for e in rec["chrome_events"]
                 if e["ev"] != "background-script-reset-idle"]
    return {
        "server_request_start_s": round(start["t"] - t0, 2) if start else None,
        "server_outcome": end["event"] if end else None,
        "server_outcome_after_request_start_s": end.get("after_s") if end else None,
        "server_outcome_how": end.get("how") if end else None,
        "bg_transitions": trans,
        "bg_suspending_at_s": suspending,
        "bg_stopped_at_s": stopped,
        "fetch_done": bool(done),
        "fetch_done_ms": done.get("ms") if done else None,
        "fetch_done_status": done.get("status") if done else None,
        "idle_resets": resets,
        "lifecycle_events": lifecycle,
        "devtools_attached_during_run": rec["sample"]["devtoolsEver"],
    }


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "r1"
    rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    delay = float(sys.argv[3]) if len(sys.argv) > 3 else 70.0
    port_m = int(sys.argv[4]) if len(sys.argv) > 4 else PORT  # group C owns 2953 and 2957 only
    assert port_m in (2953, 2957), port_m
    work = os.path.join(SPIKE, "profiles", f"C-server-{tag}")
    os.makedirs(work, exist_ok=True)
    log_path = os.path.join(SPIKE, "results", f"C-6-server-{tag}.log")
    port_file = os.path.join(work, "port")
    for p in (log_path, port_file):
        open(p, "w").close()  # truncate our own files from a previous run

    out = {"check": 6, "tag": tag, "marionette_port": port_m, "rounds": rounds, "delay_s": delay, "started": time.time(),
           "server_log": log_path}
    server = subprocess.Popen([sys.executable, "-u", SERVER_PY, "--port", "0", "--delay", str(delay),
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
        out["server_port"] = port
        base_url = f"http://127.0.0.1:{port}/slow"

        xpi = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(SPIKE, "profiles", "_xpi", f"C-spike-6-{tag}.xpi"))
        prof = make_profile(f"C-eventpage-{tag}", port_m)
        z = ZenSession(prof, port_m, headless=True).launch()
        out["install"] = z.install_addon(xpi)
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["env"] = z.chrome(INSTRUMENT, [ADDON])

        # Positive control: a short fetch through the same path must complete.
        ctl_label = f"{tag}-control"
        t_ctl = time.time()
        out["control_send"] = z.ext(h, "bg", [{"type": "longFetch", "url": f"{base_url}?delay=2&label={ctl_label}",
                                               "keepalive": False, "label": ctl_label}])
        time.sleep(5)
        log = z.ext(h, "api", ["storage.local.get", ["spikeLog"]])["value"].get("spikeLog", [])
        out["control"] = {
            "spikeLog": [e for e in log if e.get("label") == ctl_label],
            "server": [e for e in read_server_log(log_path) if e.get("label") == ctl_label],
            "chrome_events": z.chrome(GET_EVENTS, [t_ctl * 1000 - 2000]),
        }
        out["control"]["fetch_done"] = any(e.get("event") == "longFetch.done" for e in out["control"]["spikeLog"])

        runs = []
        for i in range(1, rounds + 1):
            for keepalive in (False, True):
                label = f"{tag}-{'KA' if keepalive else 'noKA'}-{i}"
                rec = {"label": label, "keepalive": keepalive}
                rec["wait_stopped_before"] = z.chrome(WAIT_STOPPED, [ADDON, 75000])
                url = f"{base_url}?delay={delay:g}&label={label}"
                rec["t_send"] = time.time()
                rec["send"] = z.ext(h, "bg", [{"type": "longFetch", "url": url, "keepalive": keepalive, "label": label}])
                rec["sample"] = z.chrome(SAMPLER, [ADDON, int(delay * 1000 + 20000), 100, log_path, label, 4000])
                rec["chrome_events"] = z.chrome(GET_EVENTS, [rec["t_send"] * 1000 - 2000])
                log = z.ext(h, "api", ["storage.local.get", ["spikeLog"]])["value"].get("spikeLog", [])
                rec["spikeLog"] = [e for e in log if e.get("label") == label or
                                   (e.get("event") == "longFetch.error" and e["t"] >= rec["t_send"] * 1000 - 1000)]
                rec["server"] = [e for e in read_server_log(log_path) if e.get("label") == label]
                rec["analysis"] = analyse(rec)
                runs.append(rec)
                a = rec["analysis"]
                print(json.dumps({"label": label, "fetch_done": a["fetch_done"], "done_ms": a["fetch_done_ms"],
                                  "server": [a["server_outcome"], a["server_outcome_after_request_start_s"],
                                             a["server_outcome_how"]],
                                  "bg_stopped_at_s": a["bg_stopped_at_s"],
                                  "resets": [(r["at_s"], r.get("reason"), r.get("path") or r.get("eventName"))
                                             for r in a["idle_resets"]]}), flush=True)
        out["runs"] = runs

        # storage.session across a restart.
        out["session_before_restart"] = z.ext(h, "api", ["storage.session.get", [None]])
        out["local_log_len_before_restart"] = len(
            z.ext(h, "api", ["storage.local.get", ["spikeLog"]])["value"].get("spikeLog", []))
        z.restart()
        page = z.open_ext_page(ADDON)
        h = page["handle"]
        out["env_after_restart"] = z.chrome(INSTRUMENT, [ADDON])
        out["session_after_restart"] = z.ext(h, "api", ["storage.session.get", [None]])
        out["local_log_len_after_restart"] = len(
            z.ext(h, "api", ["storage.local.get", ["spikeLog"]])["value"].get("spikeLog", []))
        # Positive control: storage.session works after the restart (so the empty read is real).
        out["session_probe_set"] = z.ext(h, "api", ["storage.session.set", [{"probe": 1}]])
        out["session_probe_get"] = z.ext(h, "api", ["storage.session.get", [None]])
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
    out["server_log_all"] = read_server_log(log_path)
    out["finished"] = time.time()
    path = save_result(f"C-6-event-page-{tag}", out)
    print(json.dumps({
        "env": out.get("env"),
        "control_done": out.get("control", {}).get("fetch_done"),
        "session_before_restart": out.get("session_before_restart"),
        "session_after_restart": out.get("session_after_restart"),
        "session_probe_get": out.get("session_probe_get"),
        "local_log_len": [out.get("local_log_len_before_restart"), out.get("local_log_len_after_restart")],
        "server_exit_code": out.get("server_exit_code"),
    }, indent=1))
    print("saved", path)


if __name__ == "__main__":
    main()
