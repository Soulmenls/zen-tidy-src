"""M3 spike: does "reopen closed tabs LIVE, then tabs.discard" keep them in their Space? (go/no-go for undo)

Undo plans to reopen a closed http(s) tab with tabs.create({active: false, url, index}) (live, not discarded), wait
until Zen has set the tab's `zen-workspace-id` attribute, then tabs.discard it. Tabs created with
{discarded: true} get no attribute and move to the active Space at the next restart (M0). This script checks, in
a throwaway profile with two Spaces, on the extension API as the product would use it (spike/variants/M3-reopen),
with chrome scope used only for setup and ground truth:

  1  readiness: a live tab created in Space A (A active) gets zen-workspace-id = A; how long after tabs.create,
     and which extension-observable signal marks it (chrome-side TabOpen / TabBrowserInserted / attribute
     MutationObserver trace, a 5 ms chrome poller, and the extension-side events and timings)
  2  the attribute is still there after tabs.discard
  3  Space B active, restart: the reopened tabs are still in A (attribute, container, session store, A's tabs.query)
  4  control: tabs created with {discarded: true} in A move to the active Space (B) at the restart
  5  index and placement among loose tabs, a tidy group and a split view (groupId checked after creating)
  6  throughput: 20 tabs reopened live with concurrency 3, wait for the signal, then discard: total time and
     main-thread lag (chrome-scope 16 ms setInterval sampler, as zen_live does); a second 20 wait for status
     "complete" instead; every tab must keep Space A across the restart
  7  Space Routing: where its rules live and whether a created tab could be routed elsewhere (read, never set)
  +  extra probes: the Space switched while a batch is being reopened; real pages served from 127.0.0.1 (what the
     extension and the session store hold for a tab discarded at once or after it loaded); clicking a reopened tab
     after the restart

Every reopened tab gets a tab value (sessions.setTabValue "m3name") so it can be told apart in tabs.query after the
restart, as the product's tab keys do. Chrome scope is used for setup, for the zen-workspace-id ground truth and
for the lag sampler only.

Usage: python spike/checks/M3_reopen.py <tag> [--port 2985] [--keep]
Writes spike/results/M3-reopen-<tag>.json and deletes the profile at the end (unless --keep). Only the Zen
process this script started (command line naming its own profile) is ever stopped.
"""
import argparse
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "harness"))
from zen import PROFILES, SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

ADDON = "zen-tidy-spike-m3@local"
PROFILE_NAME = "m3-reopen-spike"
DEFAULT_PORT = 2985
SIG = "⁣⁢"
XPI_DIR = os.path.join(PROFILES, "_xpi")
XPI = os.path.join(XPI_DIR, "M3-reopen.xpi")
VARIANT = os.path.join(SPIKE, "variants", "M3-reopen")

URL_RE = re.compile(r"^https://reopen-([a-z0-9]+)\.example-dev\.test/(.+)$")
LOCAL_RE = re.compile(r"^http://127\.0\.0\.1:\d+/(.+)$")


def url(tag, n):
    return f"https://reopen-{tag}.example-dev.test/page-{n}"


def name_of(u):
    m = URL_RE.match(u or "")
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    m = LOCAL_RE.match(u or "")
    return f"loc/{m.group(1)}" if m else None


# ---------------------------------------------------------------- chrome scope

PRELUDE = r"""
const done = arguments[arguments.length - 1];
const args = Array.from(arguments).slice(0, -1);
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tt = ExtensionParent.apiManager.global.tabTracker;
  const extId = t => { try { return t ? tt.getId(t) : null; } catch (e) { return null; } };
  const byId = id => tt.getTab(id);
  const urlOf = t => { try { return t.linkedBrowser?.currentURI?.spec ?? null; } catch (e) { return null; } };
  try {
"""
END = r"""
  } catch (e) { return { __error: String(e), stack: String(e.stack || "") }; }
})().then(done, e => done({ __error: String(e) }));
"""


def chrome(z, body, *args):
    r = z.chrome(PRELUDE + body + END, list(args))
    if isinstance(r, dict) and "__error" in r:
        raise RuntimeError(f"chrome script failed: {r['__error']} {r.get('stack', '')[:500]}")
    return r


# Trace of what Zen does to new tabs: TabOpen, TabBrowserInserted (capture = before Zen's own listener, bubble =
# after it) and every change of a tab's zen-workspace-id (MutationObserver), plus an optional 5 ms poller.
REC_START = r"""
const [poll] = args;
if (win.__m3rec) { try { win.__m3rec.stop(); } catch (e) {} }
const st = { log: [], stop: null };
const now = () => ({ t: Date.now(), p: win.performance.timeOrigin + win.performance.now() });
const wsOf = tab => tab.getAttribute("zen-workspace-id");
const snap = (type, tab) => st.log.push({ type, ...now(), id: extId(tab), ws: wsOf(tab),
  pending: tab.hasAttribute("pending"), connected: tab.isConnected, hasBrowser: !!tab.linkedBrowser,
  browserConnected: !!tab.linkedBrowser?.isConnected });
const onOpen = e => snap("TabOpen", e.target);
const onInsBefore = e => snap("TabBrowserInserted:before-zen", e.target);
const onInsAfter = e => snap("TabBrowserInserted:after-zen", e.target);
win.addEventListener("TabOpen", onOpen);
win.addEventListener("TabBrowserInserted", onInsBefore, true);
win.addEventListener("TabBrowserInserted", onInsAfter, false);
const mo = new win.MutationObserver(muts => {
  for (const m of muts) {
    if (m.target.localName !== "tab") continue;
    st.log.push({ type: "attr:zen-workspace-id", ...now(), id: extId(m.target), old: m.oldValue, ws: wsOf(m.target) });
  }
});
mo.observe(win.document.documentElement, { attributes: true, subtree: true,
  attributeFilter: ["zen-workspace-id"], attributeOldValue: true });
let timer = 0;
if (poll) {
  const first = new Set(), wsSeen = new Set();
  const known = new Set(win.gBrowser.tabs.map(t => extId(t)));
  timer = win.setInterval(() => {
    for (const t of win.gBrowser.tabs) {
      const id = extId(t);
      if (id === null || known.has(id)) continue;
      if (!first.has(id)) { first.add(id); st.log.push({ type: "poll:first-seen", ...now(), id, ws: wsOf(t) }); }
      if (!wsSeen.has(id) && wsOf(t)) { wsSeen.add(id); st.log.push({ type: "poll:ws-seen", ...now(), id, ws: wsOf(t) }); }
    }
  }, 5);
}
st.stop = () => {
  win.removeEventListener("TabOpen", onOpen);
  win.removeEventListener("TabBrowserInserted", onInsBefore, true);
  win.removeEventListener("TabBrowserInserted", onInsAfter, false);
  mo.disconnect();
  if (timer) win.clearInterval(timer);
};
win.__m3rec = st;
return true;
"""

REC_READ = r"""
const [clear, stop] = args;
const st = win.__m3rec;
if (!st) return null;
const log = st.log.slice();
if (clear) st.log.length = 0;
if (stop) { st.stop(); win.__m3rec = null; }
return log;
"""

# Poll one tab's attribute from chrome scope, every 5 ms.
POLL_ATTR = r"""
const [id, timeoutMs] = args;
const t0 = win.performance.now();
const tab = byId(id);
let attempts = 0, ws = null;
while (win.performance.now() - t0 < timeoutMs) {
  attempts++;
  ws = tab.getAttribute("zen-workspace-id");
  if (ws) break;
  await sleep(5);
}
return { ws, attempts, elapsedMs: Math.round((win.performance.now() - t0) * 100) / 100 };
"""

TAB_TRUTH = r"""
const ids = args[0];
const out = {};
for (const id of ids) {
  let t = null; try { t = byId(id); } catch (e) {}
  if (!t || !t.isConnected) { out[id] = null; continue; }
  const lb = t.linkedBrowser;
  out[id] = { ws: t.getAttribute("zen-workspace-id"), container: t.closest("zen-workspace")?.id ?? null,
    pending: t.hasAttribute("pending"), browserConnected: !!lb?.isConnected, cur: urlOf(t),
    group: t.group?.id ?? null, groupSplit: t.group?.hasAttribute("split-view-group") ?? false,
    groupLabel: t.group?.label ?? null, parentClass: t.parentElement?.className ?? null,
    inSplitData: (win.gZenViewSplitter?._data || []).some(d => d.tabs.includes(t)),
    busy: t.hasAttribute("busy"), selected: t.selected, label: t.label };
}
out._active = win.gZenWorkspaces.activeWorkspace;
return out;
"""

STATE = r"""
const gz = win.gZenWorkspaces;
const re1 = /^https:\/\/reopen-([a-z0-9]+)\.example-dev\.test\/(.+)$/;
const re2 = /^http:\/\/127\.0\.0\.1:\d+\/(.+)$/;
const nameFrom = u => { let m = re1.exec(u || ""); if (m) return m[1] + "/" + m[2]; m = re2.exec(u || ""); return m ? "loc/" + m[1] : null; };
const res = { active: gz.activeWorkspace, spaces: gz.getWorkspaces().map(w => w.uuid), tabs: [], session: [] };
for (const t of gz.allStoredTabs) {
  const lb = t.linkedBrowser;
  let cur = null; try { cur = lb?.currentURI?.spec ?? null; } catch (e) {}
  let ss = null; try { ss = JSON.parse(SessionStore.getTabState(t)); } catch (e) {}
  const entries = ss?.entries || [];
  const ssUrl = entries[(ss?.index ?? 1) - 1]?.url ?? entries[0]?.url ?? null;
  const name = nameFrom(cur) || nameFrom(ssUrl) || nameFrom(ss?.userTypedValue) || nameFrom(lb?.userTypedValue);
  if (!name) continue;
  res.tabs.push({ name, id: extId(t), cur, ssUrl, ssTyped: ss?.userTypedValue ?? null, ssEntries: entries.length,
    ssWs: ss?.zenWorkspace ?? null, ws: t.getAttribute("zen-workspace-id"),
    container: t.closest("zen-workspace")?.id ?? null, pending: t.hasAttribute("pending"),
    group: t.group?.id ?? null, groupLabel: t.group?.label ?? null,
    groupSplit: t.group?.hasAttribute("split-view-group") ?? false, pinned: t.pinned, label: t.label });
}
const state = JSON.parse(SessionStore.getBrowserState());
for (const w of state.windows) for (const t of w.tabs) {
  const e = t.entries?.[t.index - 1] || t.entries?.[0] || {};
  const name = nameFrom(e.url) || nameFrom(t.userTypedValue);
  if (name) res.session.push({ name, zenWorkspace: t.zenWorkspace ?? null, entries: (t.entries || []).length,
    typed: t.userTypedValue ?? null });
}
return res;
"""

SWITCH = r"""
await win.gZenWorkspaces.changeWorkspaceWithID(args[0]);
await sleep(2000);
return win.gZenWorkspaces.activeWorkspace;
"""

LAG_START = r"""
const [intervalMs] = args;
if (win.__m3Lag) { win.__m3Lag.stopped = true; win.clearInterval(win.__m3Lag.timer); win.cancelAnimationFrame(win.__m3Lag.raf); }
const st = { delays: [], frames: [], last: win.performance.now(), lastFrame: null, timer: 0, raf: 0, stopped: false };
st.timer = win.setInterval(() => {
  const now = win.performance.now();
  st.delays.push(now - st.last - intervalMs);
  st.last = now;
}, intervalMs);
const tick = ts => {
  if (st.stopped) return;
  if (st.lastFrame !== null) st.frames.push(ts - st.lastFrame);
  st.lastFrame = ts;
  st.raf = win.requestAnimationFrame(tick);
};
st.raf = win.requestAnimationFrame(tick);
win.__m3Lag = st;
return true;
"""

LAG_STOP = r"""
const st = win.__m3Lag;
if (!st) return null;
st.stopped = true;
win.clearInterval(st.timer);
win.cancelAnimationFrame(st.raf);
win.__m3Lag = null;
const round = d => Math.max(0, Math.round(d * 100) / 100);
return { delays: st.delays.map(round), frames: st.frames.map(round) };
"""

ROUTING = r"""
const m = win.gZenSpaceRoutingManager;
const file = win.PathUtils.join(win.PathUtils.profileDir, "zen-space-routing.jsonlz4");
let routes = null, defExt = null;
try { routes = m.getAllRoutes(); } catch (e) { routes = "error: " + e; }
try { defExt = m.getDefaultExternalRoute(); } catch (e) { defExt = "error: " + e; }
const prefs = Services.prefs.getChildList("zen.").filter(p => /rout/i.test(p));
return { managerPresent: !!m, routes, defaultExternalRoute: defExt, routingPrefs: prefs,
         routingFileExists: await win.IOUtils.exists(file),
         appVersion: Services.appinfo.version, appName: Services.appinfo.name,
         zenVersion: Services.prefs.getStringPref("zen.version", null) };
"""

SPLIT_DATA = r"""
return (win.gZenViewSplitter?._data || []).map(d => ({ groupId: d.groupId,
  tabs: d.tabs.map(t => urlOf(t)) }));
"""


# Select each named tab (Space A active), give it time to load, and read what it became.
SELECT_READ = r"""
const [names] = args;
const re1 = /^https:\/\/reopen-([a-z0-9]+)\.example-dev\.test\/(.+)$/;
const re2 = /^http:\/\/127\.0\.0\.1:\d+\/(.+)$/;
const nameFrom = u => { let m = re1.exec(u || ""); if (m) return m[1] + "/" + m[2]; m = re2.exec(u || ""); return m ? "loc/" + m[1] : null; };
const nameOfTab = t => {
  let ss = null; try { ss = JSON.parse(SessionStore.getTabState(t)); } catch (e) {}
  const entries = ss?.entries || [];
  return nameFrom(urlOf(t)) || nameFrom(entries[(ss?.index ?? 1) - 1]?.url) || nameFrom(ss?.userTypedValue) || nameFrom(t.linkedBrowser?.userTypedValue);
};
const res = {};
for (const name of names) {
  const t = win.gZenWorkspaces.allStoredTabs.find(t => nameOfTab(t) === name);
  if (!t) { res[name] = null; continue; }
  const before = { pending: t.hasAttribute("pending"), cur: urlOf(t), typed: t.linkedBrowser?.userTypedValue ?? null };
  win.gBrowser.selectedTab = t;
  let after = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    after = { pending: t.hasAttribute("pending"), cur: urlOf(t), busy: t.hasAttribute("busy"),
      title: t.linkedBrowser?.contentTitle ?? null, label: t.label,
      doc: t.linkedBrowser?.documentURI?.spec ?? null, typed: t.linkedBrowser?.userTypedValue ?? null };
    if (!after.pending && !after.busy && after.cur !== "about:blank") break;
  }
  res[name] = { before, after, ws: t.getAttribute("zen-workspace-id") };
}
return res;
"""


class LocalServer:
    """127.0.0.1 HTTP server (the PAC lets localhost through): a page with a real title, and a log of requests."""

    def __init__(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        outer = self
        self.requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.requests.append({"t": time.time(), "path": self.path})
                if self.path.startswith("/favicon"):
                    self.send_response(404)
                    self.end_headers()
                    return
                body = f"<!doctype html><title>Local {self.path.strip('/')}</title><p>hello {self.path}</p>".encode()
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}/{path}"

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


# ---------------------------------------------------------------- extension page

class Page:
    """The spike page, an Essential so it stays reachable (and in tabs.query) in both Spaces."""

    def __init__(self, z):
        self.z = z
        self.h = None
        self.open()

    def open(self):
        last = None
        for _ in range(5):
            try:
                opened = self.z.open_ext_page(ADDON, "spike.html", pin=True)
                self.h = opened["handle"]
                self.z.ext(self.h, "sleep", [500])
                chrome(self.z, r"""
                    const [u] = args;
                    const t = win.gBrowser.tabs.find(t => urlOf(t) === u);
                    if (t && !t.hasAttribute("zen-essential")) { win.gZenPinnedTabManager.addToEssentials(t); await sleep(800); }
                    return true;
                """, opened["url"])
                self.z.ext(self.h, "sleep", [200])
                return
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(2)
        raise RuntimeError(f"spike page not reachable: {last}")

    def run(self, command, *args):
        for attempt in range(3):
            try:
                r = self.z.ext(self.h, command, list(args))
                break
            except RuntimeError as e:
                if "no such window" not in str(e) or attempt == 2:
                    raise
                self.open()
        if not isinstance(r, dict) or "value" not in r:
            raise RuntimeError(f"{command} failed: {json.dumps(r)[:600]}")
        return r["value"]

    def api(self, path, *args):
        return self.run("api", path, list(args))

    def api_raw(self, path, *args):
        """Like api, but returns {"error": ...} instead of raising."""
        try:
            return {"value": self.api(path, *args)}
        except RuntimeError as e:
            return {"error": str(e)[:300]}

    def query(self):
        return self.api("tabs.query", {"currentWindow": True})

    def query_names(self):
        return [name_of(t["url"]) or t["url"] for t in self.query()]


# ---------------------------------------------------------------- helpers

def percentile(values, q):
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 2)


def lag_summary(delays):
    if not delays:
        return {"samples": 0}
    return {"samples": len(delays), "maxMs": round(max(delays), 1), "p95Ms": percentile(delays, 0.95),
            "p50Ms": percentile(delays, 0.5), "over50Ms": sum(1 for d in delays if d > 50),
            "over150Ms": sum(1 for d in delays if d > 150)}


def frame_summary(gaps):
    if not gaps:
        return {"samples": 0}
    return {"samples": len(gaps), "maxGapMs": round(max(gaps), 1), "p95GapMs": percentile(gaps, 0.95),
            "p50GapMs": percentile(gaps, 0.5)}


def port_in_use(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def kill_profile_processes(profile):
    """Backstop after quit: stop zen.exe processes whose command line names OUR throwaway profile, and no others."""
    needle = os.path.abspath(profile).replace("'", "''")
    script = ("Get-CimInstance Win32_Process -Filter \"Name='zen.exe'\" | "
              f"Where-Object {{ $_.CommandLine -and $_.CommandLine.Contains('{needle}') }} | "
              "ForEach-Object { $_.ProcessId }")
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                       capture_output=True, text=True, timeout=60)
    pids = [int(p) for p in r.stdout.split() if p.strip().isdigit()]
    for pid in pids:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return pids


def remove_dir(path):
    for _ in range(10):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return True
        time.sleep(1)
    return False


def ev_by_id(events, tab_id):
    return [e for e in events if e.get("id") == tab_id]


def rel(t, t0):
    return None if t is None else t - t0



# ---------------------------------------------------------------- the checks

def derive_trace(rec, r, ext, truth):
    """One reopened tab: what Zen did (chrome trace), what the extension saw, relative to the tabs.create call."""
    tid = r["id"]
    tr = sorted(ev_by_id(rec, tid), key=lambda e: e["p"])

    def first(type_):
        return next((e for e in tr if e["type"] == type_), None)

    known = next((e for e in tr if e.get("ws")), None)
    on_created = next((e for e in ext if e["type"] == "onCreated"), None)
    loading = next((e for e in ext if e["type"] == "onUpdated" and e["ci"].get("status") == "loading"), None)
    complete = next((e for e in ext if e["type"] == "onUpdated" and e["ci"].get("status") == "complete"), None)
    pf, pw = first("poll:first-seen"), first("poll:ws-seen")
    return {
        "name": name_of(r["url"]),
        "chrome_sequence": [[e["type"], e.get("ws"), round(e["t"] - r["t0"], 1)] for e in tr],
        "ws_first_known_at": known and known["type"],
        "ws_first_known_after_call_ms": known and round(known["t"] - r["t0"], 1),
        "ws_null_before": [e["type"] for e in tr if not e.get("ws") and e["type"] != "attr:zen-workspace-id"],
        "create_resolved_after_call_ms": r["t1"] - r["t0"],
        "ws_known_before_resolve_ms": known and r["t1"] - known["t"],
        "onCreated_after_call_ms": on_created and on_created["t"] - r["t0"],
        "status_loading_after_call_ms": loading and loading["t"] - r["t0"],
        "status_complete_after_call_ms": complete and complete["t"] - r["t0"],
        "poll_first_seen_after_call_ms": pf and round(pf["t"] - r["t0"], 1),
        "poll_ws_seen_after_call_ms": pw and round(pw["t"] - r["t0"], 1),
        "created_tab": r["created"],
        "inQuery_at_resolve": r.get("inQuery"),
        "ws_final": truth and truth["ws"],
        "pending_final": truth and truth["pending"],
        "ext_events": [[e["type"], e.get("ci"), e["t"] - r["t0"]] for e in ext],
    }


def check1_2(z, pg, space_a, out):
    """Items 1 and 2: six live tabs in Space A. Tabs 1-3: wait 1.5 s (the load is still running), tab key set before
    the discard, then discard. Tabs 4-6: discard as soon as tabs.create has resolved, tab key set after."""
    chrome(z, REC_START, True)
    rows = []
    for n in range(1, 7):
        late = n <= 3
        u = url("a", n)
        mark = pg.run("mark")
        r = pg.run("reopen", {"url": u, "key": f"a/page-{n}", "keyBefore": late}, "none" if late else "resolve",
                   {"verifyQuery": True, "after": False})
        tid = r["id"]
        poll = chrome(z, POLL_ATTR, tid, 3000)  # first chrome poll after the extension call returned
        truth_create = chrome(z, TAB_TRUTH, [tid])[str(tid)]
        late_info = None
        if late:
            time.sleep(1.5)
            late_truth = chrome(z, TAB_TRUTH, [tid])[str(tid)]
            late_get = pg.api("tabs.get", tid)
            td = time.time()
            pg.api("tabs.discard", tid)
            late_info = {"truth_before_discard": late_truth,
                         "ext_before_discard": {k: late_get.get(k) for k in ("status", "discarded", "url", "title", "index", "groupId")},
                         "discard_call_ms": round((time.time() - td) * 1000)}
        time.sleep(0.4)
        truth_after = chrome(z, TAB_TRUTH, [tid])[str(tid)]
        got = pg.api("tabs.get", tid)
        events = pg.run("events", mark, [tid])
        rows.append({"name": f"a/page-{n}", "id": tid, "late_discard": late, "reopen": r, "poll_after_create": poll,
                     "truth_after_create": truth_create, "late": late_info, "truth_after_discard": truth_after,
                     "ext_after_discard": {k: got.get(k) for k in ("status", "discarded", "url", "title", "index", "groupId")},
                     "ext_events": events})
    rec = chrome(z, REC_READ, True, True)
    out["item1_rows"] = rows
    derived = []
    for row in rows:
        d = derive_trace(rec, row["reopen"], row["ext_events"], row["truth_after_create"])
        d.update({"late_discard": row["late_discard"], "chrome_poll_after_create": row["poll_after_create"],
                  "ws_after_discard": row["truth_after_discard"]["ws"],
                  "pending_after_discard": row["truth_after_discard"]["pending"],
                  "browserConnected_after_discard": row["truth_after_discard"]["browserConnected"],
                  "ext_discarded_after": row["ext_after_discard"]["discarded"],
                  "ext_url_after_discard": row["ext_after_discard"]["url"],
                  "ext_title_after_discard": row["ext_after_discard"]["title"],
                  "ws_before_late_discard": row["late"] and row["late"]["truth_before_discard"]["ws"],
                  "ext_before_late_discard": row["late"] and row["late"]["ext_before_discard"]})
        derived.append(d)
    out["item1_derived"] = derived


def check1b(z, pg, space_a, out):
    """The same trace under concurrency 3 (9 tabs, discard as soon as tabs.create resolves)."""
    chrome(z, REC_START, False)
    mark = pg.run("mark")
    items = [{"url": url("c", i), "key": f"c/page-{i}"} for i in range(1, 10)]
    res = pg.run("pool", items, 3, "resolve", {"verifyQuery": True})
    time.sleep(0.8)
    rec = chrome(z, REC_READ, True, True)
    ext = pg.run("events", mark)
    ids = [r["id"] for r in res["results"] if r.get("id")]
    truth = chrome(z, TAB_TRUTH, ids)
    out["item1b_concurrency"] = {
        "total_ms": res["totalMs"],
        "rows": [dict(derive_trace(rec, r, ev_by_id(ext, r["id"]), truth[str(r["id"])]),
                      ws_after_discard=truth[str(r["id"])]["ws"], pending_after_discard=truth[str(r["id"])]["pending"],
                      worker=r["worker"]) for r in res["results"]],
    }


def check4_controls(z, pg, out):
    """Item 4 setup: three tabs created discarded in Space A (A active), tab key set."""
    rows = []
    for n in range(1, 4):
        r = pg.run("reopen", {"url": url("ctl", n), "discarded": True, "title": f"control {n}", "key": f"ctl/page-{n}"},
                   "none", {"after": False})
        truth = chrome(z, TAB_TRUTH, [r["id"]])[str(r["id"])]
        rows.append({"name": f"ctl/page-{n}", "id": r["id"], "created": r["created"], "truth": truth})
    out["item4_controls_created"] = rows


def check_local(z, pg, srv, space_a, out):
    """Extra: real pages (served from 127.0.0.1, which the PAC allows). 4 tabs discarded as soon as tabs.create resolves,
    4 tabs discarded after status complete. What does the extension see, what did the server get, what is saved?"""
    rows = {"now": [], "done": []}
    for mode, wait in (("now", "resolve"), ("done", "complete")):
        for n in range(1, 5):
            path = f"{mode}-{n}"
            rows[mode].append(pg.run("reopen", {"url": srv.url(path), "key": f"loc/{path}"}, wait, {"verifyQuery": True}))
    time.sleep(2.0)
    snap = {s["key"]: s for s in pg.run("snapshot") if s["key"]}
    ids = [r["id"] for m in rows.values() for r in m]
    truth = chrome(z, TAB_TRUTH, ids)
    st = {t["name"]: t for t in chrome(z, STATE)["tabs"] if t["name"].startswith("loc/")}
    reqs = {}
    for q in srv.requests:
        reqs.setdefault(q["path"], 0)
        reqs[q["path"]] += 1
    out["local_probe"] = {
        "port": srv.port,
        "rows": [{"name": name_of(r["url"]), "mode": mode, "id": r["id"], "create_ms": r["t1"] - r["t0"],
                  "resolve_to_discard_ms": r["t3"] - r["t1"], "waited": r.get("waited"),
                  "created": r["created"], "after_discard": r.get("after"),
                  "ws_is_A": truth[str(r["id"])]["ws"] == space_a, "pending": truth[str(r["id"])]["pending"],
                  "ext_view_2s_later": {k: snap.get(name_of(r["url"]), {}).get(k) for k in ("url", "title", "hasTitle", "status", "discarded")},
                  "saved": {k: st.get(name_of(r["url"]), {}).get(k) for k in ("cur", "ssUrl", "ssTyped", "ssEntries", "label")}}
                 for mode, m in rows.items() for r in m],
        "server_requests": reqs,
    }


def sample_lag(z, seconds):
    chrome(z, LAG_START, 16)
    time.sleep(seconds)
    s = chrome(z, LAG_STOP)
    return {"lag": lag_summary(s["delays"]), "frames": frame_summary(s["frames"])}


def check6(z, pg, space_a, tag, label, wait, n_tabs, concurrency, loose_start, out):
    """Reopen n_tabs live with the given concurrency, wait for `wait`, then discard. Lag sampled throughout."""
    items = [{"url": url(tag, i), "index": loose_start, "key": f"{tag}/page-{i}", "keyBefore": wait != "resolve"}
             for i in range(1, n_tabs + 1)]
    baseline = sample_lag(z, 3)
    chrome(z, LAG_START, 16)
    t_py = time.time()
    res = pg.run("pool", items, concurrency, wait, {"verifyQuery": True})
    wall = round((time.time() - t_py) * 1000)
    s = chrome(z, LAG_STOP)
    ids = [r["id"] for r in res["results"] if r.get("id")]
    truth = chrome(z, TAB_TRUTH, ids)
    time.sleep(0.5)
    q = pg.query()
    qmap = {t["id"]: t for t in q}
    errors = [r for r in res["results"] if r.get("error") or r.get("discardError") or r.get("keyError")]
    spans = [(r["t0"], r.get("t3") or r["t2"]) for r in res["results"] if r.get("id")]
    max_in_flight = max((sum(1 for (c, d) in spans if c <= a < d) for (a, _b) in spans), default=0)
    out[label] = {
        "wait": wait, "n": n_tabs, "concurrency": concurrency,
        "total_ms_in_page": res["totalMs"], "total_ms_wall_python": wall,
        "per_tab_ms": {"create_call_to_resolve": [r["t1"] - r["t0"] for r in res["results"] if r.get("id")],
                       "resolve_to_discarded": [r["t3"] - r["t1"] for r in res["results"] if r.get("t3")]},
        "lag": lag_summary(s["delays"]), "frames": frame_summary(s["frames"]), "baseline": baseline,
        "max_in_flight": max_in_flight, "errors": errors,
        "ws_all_A": all(truth[str(i)] and truth[str(i)]["ws"] == space_a for i in ids),
        "ws_values": sorted({str(truth[str(i)] and truth[str(i)]["ws"]) for i in ids}),
        "all_discarded_pending": all(truth[str(i)] and truth[str(i)]["pending"] for i in ids),
        "all_in_query": all(i in qmap for i in ids),
        "all_loose": all(qmap[i]["groupId"] == -1 for i in ids if i in qmap),
        "inQuery_flags": sum(1 for r in res["results"] if r.get("inQuery")),
        "ext_discarded": sum(1 for i in ids if i in qmap and qmap[i]["discarded"]),
        "waited_via": sorted({(r.get("waited") or {}).get("via", "n/a") for r in res["results"]}),
        "ids": ids,
    }


def case_layout(pg, names_by_id):
    return [(names_by_id.get(t["id"]) or name_of(t["url"]) or t["url"][:24], t["index"], t["groupId"],
             "P" if t["pinned"] else "") for t in pg.query()]


def check5(z, pg, space_a, out):
    """Item 5: placement among loose tabs, a tidy group and a split view, with live create + discard."""
    names = ["A", "B", "G1", "G2", "C", "S1", "S2", "D", "E"]
    ids = {}
    for nme in names:
        r = pg.run("reopen", {"url": url("lay", nme), "key": f"lay/page-{nme}"}, "resolve", {"after": False})
        ids[nme] = r["id"]
    for nme in names:
        pg.api("tabs.move", ids[nme], {"index": -1})
    gid = pg.api("tabs.group", {"tabIds": [ids["G1"], ids["G2"]]})
    pg.api("tabGroups.update", gid, {"title": SIG + "Tidy G"})
    made = chrome(z, r"""
        const d = win.gZenViewSplitter.splitTabs([byId(args[0]), byId(args[1])], "grid", -1);
        await sleep(1200);
        return { ok: !!d, groupId: d?.groupId ?? null };
    """, ids["S1"], ids["S2"])
    pg.run("sleep", 800)
    by_id_name = {v: k for k, v in ids.items()}
    layout_named = lambda: case_layout(pg, by_id_name)  # noqa: E731
    lay_only = lambda L: [x for x in L if x[0] in names or x[3] == "P"]  # noqa: E731
    out["item5_setup"] = {"ids": ids, "tidy_group": gid, "split": made, "layout": lay_only(layout_named()),
                          "split_data": chrome(z, SPLIT_DATA)}

    def idx(nme, delta=0):
        return next(t["index"] for t in pg.query() if t["id"] == ids[nme]) + delta

    def loose_start_():
        return min(t["index"] for t in pg.query() if not t["pinned"])

    def end_index():
        return max(t["index"] for t in pg.query()) + 1

    def nm(t):
        return by_id_name.get(t["id"]) or name_of(t["url"]) or t["url"][:24]

    cases = [
        ("c01_loose_start", loose_start_),
        ("c02_between_A_B", lambda: idx("B")),
        ("c03_group_first_index", lambda: idx("G1")),
        ("c04_strictly_inside_group", lambda: idx("G2")),
        ("c05_group_last_plus_1", lambda: idx("G2", 1)),
        ("c06_split_first_index", lambda: idx("S1")),
        ("c08_split_last_plus_1", lambda: idx("S2", 1)),
        ("c09_end", end_index),
        ("c10_huge_9999", lambda: 9999),
        ("c11_no_index", lambda: None),
        ("c07_strictly_inside_split", lambda: idx("S2")),  # last: this one can corrupt the split
    ]
    results = {}
    for cname, fn in cases:
        requested = fn()
        item = {"url": url("plc", cname.split("_")[0])}
        if requested is not None:
            item["index"] = requested
        r = pg.run("reopen", item, "resolve", {"after": True, "verifyQuery": True})
        rec = {"requested_index": requested,
               "create_returned": {k: r["created"].get(k) for k in ("index", "groupId", "status")} if r.get("created") else r,
               "after_discard": r.get("after") and {k: r["after"].get(k) for k in ("index", "groupId", "discarded")}}
        if r.get("id"):
            time.sleep(0.3)
            tabs = pg.query()
            pos = next((i for i, t in enumerate(tabs) if t["id"] == r["id"]), None)
            if pos is not None:
                rec["tabs_query"] = {"index": tabs[pos]["index"], "groupId": tabs[pos]["groupId"], "discarded": tabs[pos]["discarded"]}
                rec["prev"] = [nm(tabs[pos - 1]), tabs[pos - 1]["groupId"]] if pos else None
                rec["next"] = [nm(tabs[pos + 1]), tabs[pos + 1]["groupId"]] if pos + 1 < len(tabs) else None
            else:
                rec["tabs_query"] = None
            rec["chrome"] = chrome(z, TAB_TRUTH, [r["id"]])[str(r["id"])]
            rec["split_data"] = chrome(z, SPLIT_DATA)
            pg.api("tabs.remove", r["id"])
            time.sleep(0.4)
        results[cname] = rec
    out["item5_cases"] = results
    out["item5_layout_after_cases"] = lay_only(layout_named())
    out["item5_split_after_cases"] = chrome(z, SPLIT_DATA)
    out["item5_gid"] = gid


def check_switch_probe(z, pg, space_a, space_b, anchor_id, out):
    """Extra: switch to Space B while a batch is being reopened (concurrency 1, 350 ms between create and discard).
    anchor_id is a tab of Space A: once A is no longer the active Space it drops out of tabs.query."""
    items = [{"url": url("sw", i), "key": f"sw/page-{i}"} for i in range(1, 7)]
    chrome(z, r"""
        const [b, delay] = args;
        win.setTimeout(() => { win.gZenWorkspaces.changeWorkspaceWithID(b); }, delay);
        return true;
    """, space_b, 900)
    res = pg.run("pool", items, 1, "delay:350", {"verifyQuery": True, "after": False, "anchorId": anchor_id})
    time.sleep(2.5)
    ids = [r["id"] for r in res["results"] if r.get("id")]
    truth = chrome(z, TAB_TRUTH, ids)
    rows = []
    for r in res["results"]:
        tr = truth.get(str(r["id"]))
        rows.append({"name": name_of(r["url"]), "id": r["id"], "inQuery": r.get("inQuery"),
                     "anchorInQuery": r.get("anchorInQuery"),
                     "ws_is": "A" if tr and tr["ws"] == space_a else ("B" if tr and tr["ws"] == space_b else tr and tr["ws"]),
                     "pending": tr and tr["pending"]})
    out["probe_switch"] = {"rows": rows, "active_after": truth["_active"]}


# ---------------------------------------------------------------- verdicts

def stats(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    return {"n": len(v), "min": v[0], "median": v[len(v) // 2], "max": v[-1]}


def expected_url(name, port):
    tag, path = name.split("/", 1)
    return f"http://127.0.0.1:{port}/{path}" if tag == "loc" else f"https://reopen-{tag}.example-dev.test/{path}"


def build_verdict(out):
    A, B = out["spaces"]["A"], out["spaces"]["B"]
    sh = lambda s: "A" if s == A else ("B" if s == B else s)  # noqa: E731
    v = {}

    # 1
    rows = out["item1_derived"] + out["item1b_concurrency"]["rows"]
    known_before = [r["ws_known_before_resolve_ms"] for r in rows]
    ok1 = all(r["ws_final"] == A for r in rows) and all(x is not None and x >= 0 for x in known_before)
    v["1"] = {"verdict": "PASS" if ok1 else "FAIL", "tabs": len(rows),
              "all_ws_equal_A": all(r["ws_final"] == A for r in rows),
              "attr_first_known_at": sorted({r["ws_first_known_at"] for r in rows}),
              "ws_null_events_before_zen_listener": sorted({tuple(r["ws_null_before"]) for r in rows}),
              "ms_from_tabs_create_call_to_attr_set": stats([r["ws_first_known_after_call_ms"] for r in rows]),
              "ms_from_tabs_create_call_to_promise_resolved": stats([r["create_resolved_after_call_ms"] for r in rows]),
              "ms_attr_known_BEFORE_promise_resolved": stats(known_before),
              "ms_onCreated": stats([r["onCreated_after_call_ms"] for r in rows]),
              "ms_status_loading_event": stats([r["status_loading_after_call_ms"] for r in rows]),
              "status_complete_seen_within_1.5s": sum(1 for r in out["item1_derived"] if r["status_complete_after_call_ms"] is not None),
              "chrome_poll_attempts_needed": sorted({(r["chrome_poll_after_create"]["attempts"]) for r in out["item1_derived"]}),
              "chrome_5ms_poller_first_seen_ms": stats([r["poll_first_seen_after_call_ms"] for r in out["item1_derived"]]),
              "chrome_5ms_poller_attr_seen_ms": stats([r["poll_ws_seen_after_call_ms"] for r in out["item1_derived"]]),
              "tabs_create_result_status": sorted({r["created_tab"]["status"] for r in rows}),
              "tabs_create_result_url": sorted({r["created_tab"]["url"] for r in rows}),
              "tabs_create_result_discarded": sorted({str(r["created_tab"]["discarded"]) for r in rows}),
              "in_tabs_query_at_resolve": sum(1 for r in rows if r["inQuery_at_resolve"])}

    # 2
    d2 = out["item1_derived"]
    pools = [out[k] for k in ("item6a_wait_resolve", "item6b_wait_complete")]
    ok2 = all(r["ws_after_discard"] == A and r["pending_after_discard"] and not r["browserConnected_after_discard"]
              and r["ext_discarded_after"] for r in d2) and \
        all(r["ws_after_discard"] == A and r["pending_after_discard"] for r in out["item1b_concurrency"]["rows"]) and \
        all(p["ws_all_A"] and p["all_discarded_pending"] and p["ext_discarded"] == p["n"] for p in pools)
    v["2"] = {"verdict": "PASS" if ok2 else "FAIL",
              "single_tabs": f"{sum(1 for r in d2 if r['ws_after_discard'] == A)}/{len(d2)} keep A "
                             f"(late discard {sum(1 for r in d2 if r['late_discard'] and r['ws_after_discard'] == A)}/3, "
                             f"immediate {sum(1 for r in d2 if not r['late_discard'] and r['ws_after_discard'] == A)}/3)",
              "concurrency_9": f"{sum(1 for r in out['item1b_concurrency']['rows'] if r['ws_after_discard'] == A)}/9",
              "pool_20_resolve_all_A": out["item6a_wait_resolve"]["ws_all_A"],
              "pool_20_complete_all_A": out["item6b_wait_complete"]["ws_all_A"],
              "dom_after_discard": "pending attr set, browser no longer connected, extension discarded:true for all (single tabs)"}

    # 3 / 4 / restart
    before = {t["name"]: t for t in out["state_before_quit"]["tabs"]}
    after_rows = {}
    for t in out["state_after_restart"]["tabs"]:
        after_rows.setdefault(t["name"], []).append(t)
    names_A = sorted(n for n, t in before.items() if t["ws"] == A)
    names_ctl = sorted(n for n in before if n.startswith("ctl/"))
    keysA = {s["key"] for s in out["snapshot_A"] if s["key"]}
    keysB = {s["key"] for s in out["snapshot_B"] if s["key"]}

    def kept(n, expect):
        rs = after_rows.get(n, [])
        return len(rs) == 1 and rs[0]["ws"] == expect and rs[0]["container"] == expect and rs[0]["ssWs"] == expect

    bad_chrome = [n for n in names_A if not kept(n, A)]
    bad_ext_A = [n for n in names_A if n not in keysA]
    stray_in_B = [n for n in names_A if n in keysB]
    ok3 = not bad_chrome and not bad_ext_A and not stray_in_B and out["active_after_restart"] == B
    per_group = {}
    for n in names_A:
        g = per_group.setdefault(n.split("/")[0], [0, 0])
        g[1] += 1
        if n not in bad_chrome and n in keysA and n not in keysB:
            g[0] += 1
    v["3"] = {"verdict": "PASS" if ok3 else "FAIL",
              "active_space_at_quit": sh(out["active_before_quit"]), "active_space_after_restart": sh(out["active_after_restart"]),
              "tabs_created_live_in_A": len(names_A),
              "kept_A_by_group_(ok,total)": per_group,
              "wrong_in_chrome": bad_chrome, "missing_from_A_tabs_query": bad_ext_A, "found_in_B_tabs_query": stray_in_B,
              "attribute_container_and_session_zenWorkspace_all_A": not bad_chrome,
              "identity_in_tabs_query_via": "sessions.getTabValue m3name (set at reopen) matched in A's tabs.query"}
    ok4 = all(kept(n, B) for n in names_ctl) and all(n in keysB for n in names_ctl) and not any(n in keysA for n in names_ctl) \
        and all(before[n]["ws"] is None for n in names_ctl) and len(names_ctl) == 3
    v["4"] = {"verdict": "PASS" if ok4 else "FAIL", "control_tabs": names_ctl,
              "attribute_before_quit": {n: sh(before[n]["ws"]) for n in names_ctl},
              "after_restart": {n: {"ws": sh(after_rows[n][0]["ws"]), "container": sh(after_rows[n][0]["container"]),
                                    "ssWs": sh(after_rows[n][0]["ssWs"])} for n in names_ctl if n in after_rows},
              "in_B_tabs_query": [n for n in names_ctl if n in keysB], "in_A_tabs_query": [n for n in names_ctl if n in keysA]}

    # 5
    cs = out["item5_cases"]
    exp = {
        "c01_loose_start": lambda c: c["tabs_query"]["groupId"] == -1 and c["tabs_query"]["index"] == c["requested_index"],
        "c02_between_A_B": lambda c: c["prev"][0] == "A" and c["next"][0] == "B" and c["tabs_query"]["groupId"] == -1,
        "c03_group_first_index": lambda c: c["tabs_query"]["groupId"] == -1 and c["prev"][0] == "B" and c["next"][0] == "G1",
        "c04_strictly_inside_group": lambda c: c["tabs_query"]["groupId"] == out["item5_gid"] and c["prev"][0] == "G1" and c["next"][0] == "G2",
        "c05_group_last_plus_1": lambda c: c["tabs_query"]["groupId"] == -1 and c["prev"][0] == "G2" and c["next"][0] == "C",
        "c06_split_first_index": lambda c: c["tabs_query"]["groupId"] == -1 and c["chrome"]["group"] is None and c["prev"][0] == "C" and c["next"][0] == "S1",
        "c08_split_last_plus_1": lambda c: c["tabs_query"]["groupId"] == -1 and c["chrome"]["group"] is None and c["prev"][0] == "S2" and c["next"][0] == "D",
        "c09_end": lambda c: c["tabs_query"]["groupId"] == -1 and c["prev"][0] == "E" and c["next"] is None,
        "c10_huge_9999": lambda c: c["tabs_query"]["groupId"] == -1 and c["prev"][0] == "E" and c["next"] is None,
        "c11_no_index": lambda c: c["tabs_query"]["groupId"] == -1,
    }
    case_res = {}
    for k, f in exp.items():
        try:
            case_res[k] = bool(f(cs[k]))
        except Exception as e:  # noqa: BLE001
            case_res[k] = f"error {e!r}"
    c07 = cs["c07_strictly_inside_split"]
    v["5"] = {"verdict": "PASS" if all(x is True for x in case_res.values()) else "FAIL", "cases_as_expected": case_res,
              "returned_index_equals_final_index": all(
                  c.get("tabs_query") and c["create_returned"]["index"] == c["tabs_query"]["index"] for c in cs.values()),
              "no_index_lands_at": cs["c11_no_index"]["tabs_query"] and cs["c11_no_index"]["tabs_query"]["index"],
              "huge_index_clamped_to": cs["c10_huge_9999"]["tabs_query"] and cs["c10_huge_9999"]["tabs_query"]["index"],
              "strictly_inside_split_(danger)": {"groupId_is_split_group": c07["tabs_query"]["groupId"] != -1,
                                                  "chrome_group_is_split": c07["chrome"]["groupSplit"],
                                                  "in_Zen_split_data": c07["chrome"]["inSplitData"]},
              "split_intact_after_removing_it": len(out["item5_split_after_cases"]) == 1 and len(out["item5_split_after_cases"][0]["tabs"]) == 2}

    # 6
    def six(k):
        p = out[k]
        return {"tabs": p["n"], "concurrency": p["concurrency"], "max_in_flight": p["max_in_flight"], "wait": p["wait"],
                "total_ms": p["total_ms_in_page"], "ws_all_A": p["ws_all_A"], "all_discarded": p["all_discarded_pending"],
                "all_in_tabs_query": p["all_in_query"], "all_loose": p["all_loose"], "errors": len(p["errors"]),
                "create_call_to_resolve_ms": stats(p["per_tab_ms"]["create_call_to_resolve"]),
                "resolve_to_discarded_ms": stats(p["per_tab_ms"]["resolve_to_discarded"]),
                "main_thread_lag": p["lag"], "idle_baseline_lag": p["baseline"]["lag"], "frame_gaps": p["frames"]}
    thr_names = [n for n in names_A if n.startswith(("thr/", "thc/"))]
    ok6 = out["item6a_wait_resolve"]["ws_all_A"] and out["item6b_wait_complete"]["ws_all_A"] and \
        not out["item6a_wait_resolve"]["errors"] and not out["item6b_wait_complete"]["errors"] and \
        all(kept(n, A) for n in thr_names) and len(thr_names) == 40 and all(n in keysA for n in thr_names)
    v["6"] = {"verdict": "PASS" if ok6 else "FAIL", "wait_for_tabs_create_to_resolve": six("item6a_wait_resolve"),
              "wait_for_status_complete": six("item6b_wait_complete"),
              "after_restart_kept_A": f"{sum(1 for n in thr_names if kept(n, A))}/{len(thr_names)}"}

    # 7
    env = out["env"]
    v["7"] = {"verdict": "INFO", "zen": env.get("appVersion"), "routes_in_default_profile": env.get("routes"),
              "defaultExternalRoute": env.get("defaultExternalRoute"), "zen_rout_prefs": env.get("routingPrefs"),
              "routing_file_exists": env.get("routingFileExists"),
              "note": "Rules live in profile file zen-space-routing.jsonlz4 (no prefs); none by default"}

    # extra probes
    pr = out["probe_switch"]["rows"]
    v["probe_space_switch_mid_batch"] = {"rows": [(r["name"], r["ws_is"], "anchor_in_query=" + str(r["anchorInQuery"]),
                                                   "in_query=" + str(r["inQuery"])) for r in pr]}
    lp = out["local_probe"]
    v["probe_real_pages"] = {"server_requests": lp["server_requests"],
                             "rows": [(r["name"], r["mode"], r["created"]["url"], r["ext_view_2s_later"], r["saved"]) for r in lp["rows"]]}
    v["probe_click_after_restart"] = out.get("select_check")
    ext_view = {}
    for label, snap in (("A", out["snapshot_A"]), ("B", out["snapshot_B"])):
        keyed = [s for s in snap if s["key"]]
        ext_view[label] = {"keyed_tabs": len(keyed), "url_about_blank": sum(1 for s in keyed if s["url"] == "about:blank"),
                           "url_real": sum(1 for s in keyed if s["url"] not in ("about:blank", None)),
                           "has_title": sum(1 for s in keyed if s["hasTitle"])}
    v["ext_view_after_restart"] = ext_view
    return v


def print_verdict(v):
    print("=" * 78)
    for k in ("1", "2", "3", "4", "5", "6", "7"):
        print(f"ITEM {k}: {v[k]['verdict']}")
        print(json.dumps(v[k], indent=1, ensure_ascii=False, default=str))
    for k in v:
        if k.startswith(("probe", "ext_view")):
            print(f"-- {k}")
            print(json.dumps(v[k], indent=1, ensure_ascii=False, default=str))


# ---------------------------------------------------------------- run

def run_once(tag, port, keep):
    out = {"tag": tag, "port": port, "started": time.strftime("%Y-%m-%d %H:%M:%S")}
    os.makedirs(XPI_DIR, exist_ok=True)
    build_xpi(VARIANT, XPI)
    prof = make_profile(PROFILE_NAME, port)
    out["profile"] = os.path.relpath(prof, SPIKE)
    z = ZenSession(prof, port, headless=True)
    srv = LocalServer()
    out["local_port"] = srv.port
    t_start = time.time()
    try:
        z.launch()
        out["install"] = z.install_addon(XPI)
        pg = Page(z)
        out["env"] = chrome(z, ROUTING)
        spaces = chrome(z, r"""
            const ws = await win.gZenWorkspaces.createAndSaveWorkspace("Space B"); await sleep(2000);
            return { b: ws.uuid, activeAfterCreate: win.gZenWorkspaces.activeWorkspace,
                     all: win.gZenWorkspaces.getWorkspaces().map(w => w.uuid) };
        """)
        space_b = spaces["b"]
        space_a = next(s for s in spaces["all"] if s != space_b)
        chrome(z, SWITCH, space_a)
        out["spaces"] = {"A": space_a, "B": space_b, "create": spaces}
        out["active_before_tests"] = chrome(z, TAB_TRUTH, [])["_active"]

        check1_2(z, pg, space_a, out)
        check1b(z, pg, space_a, out)
        check4_controls(z, pg, out)
        check_local(z, pg, srv, space_a, out)
        # Items 6a/6b: where the tabs go. Index = the first loose index, so they never land in a group.
        loose_start = min(t["index"] for t in pg.query() if not t["pinned"])
        out["loose_start_for_throughput"] = loose_start
        check6(z, pg, space_a, "thr", "item6a_wait_resolve", "resolve", 20, 3, loose_start, out)
        check6(z, pg, space_a, "thc", "item6b_wait_complete", "complete", 20, 3, loose_start, out)
        check5(z, pg, space_a, out)
        check_switch_probe(z, pg, space_a, space_b, out["item1_rows"][0]["id"], out)

        # Final state before the quit: Space B active.
        out["active_before_quit"] = chrome(z, TAB_TRUTH, [])["_active"]
        if out["active_before_quit"] != space_b:
            chrome(z, SWITCH, space_b)
            out["active_before_quit"] = chrome(z, TAB_TRUTH, [])["_active"]
        out["state_before_quit"] = chrome(z, STATE)

        z.restart()
        pg = Page(z)
        out["active_after_restart"] = chrome(z, TAB_TRUTH, [])["_active"]
        out["state_after_restart"] = chrome(z, STATE)
        out["snapshot_B"] = pg.run("snapshot")
        out["switch_to_A"] = chrome(z, SWITCH, space_a)
        out["snapshot_A"] = pg.run("snapshot")
        out["state_after_restart_in_A"] = chrome(z, STATE)
        out["post_split_data"] = chrome(z, SPLIT_DATA)
        names = ["a/page-1", "a/page-5", "thr/page-3", "thc/page-3", "lay/page-A", "loc/now-1", "loc/done-1"]
        sel = chrome(z, SELECT_READ, names)
        out["select_check"] = {n: sel[n] and {"expected_url": expected_url(n, srv.port), **sel[n]} for n in names}
        out["verdict"] = build_verdict(out)
        out["elapsed_s"] = round(time.time() - t_start)
        print_verdict(out["verdict"])
    except Exception as e:  # noqa: BLE001
        out["error"] = repr(e)
        import traceback
        out["traceback"] = traceback.format_exc()
        print(out["traceback"], file=sys.stderr)
        raise
    finally:
        try:
            z.quit()
        finally:
            srv.stop()
            out["leftover_killed"] = kill_profile_processes(prof)
            if not keep:
                out["profile_removed"] = remove_dir(prof)
                if os.path.exists(XPI):
                    os.remove(XPI)
                print("profile removed:", out["profile_removed"], flush=True)
            path = save_result(f"M3-reopen-{tag}", out)
            print("saved", path, flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tag")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    if port_in_use(args.port):
        print(f"Marionette port {args.port} is already in use; not starting.", file=sys.stderr)
        return 2
    run_once(args.tag, args.port, args.keep)
    return 0


if __name__ == "__main__":
    sys.exit(main())
