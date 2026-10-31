"""VD (adversarial verifier) version of D_harness_pac_failover.py. Port 2964, profiles VD-pac-*.

Question: with the SHARED harness PAC (everything but loopback -> PROXY 127.0.0.1:9, a dead port), can a request
fall back to DIRECT?

Source reading (nsHttpChannel::ProxyFailover, Firefox 158): when the proxy is refused and there is no other proxy,
Firefox goes DIRECT only if network.proxy.failover_direct is true AND the request is "beConservative". Ordinary
fetches and page loads are not conservative, so group D's probe (chrome fetch + tab load) could not have exercised
that path. Firefox's own service requests (ServiceRequest: remote settings, updates, GMP downloads) ARE conservative.

Safety: the probe host is mapped to 127.0.0.1 (network.dns.localDomains), so a DIRECT failover only ever reaches the
local recording server. Known Mozilla/Google service hosts are pinned to 127.0.0.1 too (VD_common.MOZ_HOSTS), the
profile starts with failover_direct=false, and the default (true) is switched on at runtime only around the probes.
No case runs with network.proxy.type=0 (group D's case A did, which leaves the whole profile unproxied).

Cases:
  CTRL: custom PAC that returns DIRECT for the probe host -> every probe must reach the server (mapping works,
        conservative channel + ServiceRequest code work, TLS bytes are recorded).
  HARNESS: exact harness PAC (make_profile). Probes with failover_direct=true (the default) and false.
Usage: python spike/checks/VD_harness_pac_failover.py r1
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VD_common import MOZ_HOSTS, LocalServer, ZenSession, make_profile, save_result  # noqa: E402

PORT = 2964
RUN = sys.argv[1] if len(sys.argv) > 1 else "r1"
HOST = "failover-probe.example"
GUARD_PREFS = {
    "network.dns.localDomains": HOST + "," + MOZ_HOSTS,
    "network.proxy.failover_direct": False,
    "media.gmp-manager.updateEnabled": False,
    "media.gmp-gmpopenh264.autoupdate": False,
    "media.gmp-widevinecdm.autoupdate": False,
    "dom.push.connection.enabled": False,
}

PROBE_JS = """
const [base, failover, label, done] = arguments;
(async () => {
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const { ServiceRequest } = ChromeUtils.importESModule("resource://gre/modules/ServiceRequest.sys.mjs");
  const before = Services.prefs.getBoolPref("network.proxy.failover_direct");
  if (failover !== null) Services.prefs.setBoolPref("network.proxy.failover_direct", failover);
  const at = Services.prefs.getBoolPref("network.proxy.failover_direct");
  const out = { failoverDirectAtProbe: at, failoverDirectBefore: before,
                proxyType: Services.prefs.getIntPref("network.proxy.type") };
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const timeout = (p, ms) => Promise.race([p, new Promise(r => win.setTimeout(() => r({ timeout: true }), ms))]);
  const chan = (url, conservative) => timeout(new Promise(resolve => {
    const ch = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true });
    ch.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING | Ci.nsIRequest.LOAD_ANONYMOUS;
    const internal = ch.QueryInterface(Ci.nsIHttpChannelInternal);
    internal.beConservative = conservative;
    ch.asyncOpen({
      onStartRequest() {},
      onDataAvailable(r, s, o, c) { NetUtil.readInputStreamToString(s, c); },
      onStopRequest(r, status) {
        let http = null;
        try { http = ch.QueryInterface(Ci.nsIHttpChannel).responseStatus; } catch (e) {}
        resolve({ status: "0x" + (status >>> 0).toString(16), http, beConservative: internal.beConservative });
      },
    });
  }), 15000);
  const sreq = (url) => timeout(new Promise(resolve => {
    const r = new ServiceRequest();
    r.open("GET", url);
    r.onload = () => resolve({ ok: true, status: r.status });
    r.onerror = () => resolve({ ok: false, status: r.status });
    r.send();
  }), 15000);
  const fetchIt = (url) => timeout(fetch(url, { cache: "no-store" }).then(
    r => ({ ok: true, status: r.status }), e => ({ ok: false, error: String(e) })), 15000);
  out.plain_fetch_http = await fetchIt(`http://${base}/${label}-plain-fetch-http`);
  out.chan_plain_http = await chan(`http://${base}/${label}-chan-plain-http`, false);
  out.chan_conservative_http = await chan(`http://${base}/${label}-chan-conservative-http`, true);
  out.chan_conservative_http_2 = await chan(`http://${base}/${label}-chan-conservative-http-2`, true);
  out.chan_conservative_https = await chan(`https://${base}/${label}-chan-conservative-https`, true);
  out.service_request_http = await sreq(`http://${base}/${label}-service-request-http`);
  if (failover !== null) Services.prefs.setBoolPref("network.proxy.failover_direct", before);
  out.failoverDirectAfter = Services.prefs.getBoolPref("network.proxy.failover_direct");
  done(out);
})();
"""


def main():
    srv = LocalServer()
    base = f"{HOST}:{srv.port}"
    out = {"run": RUN, "server_port": srv.port, "cases": {}}
    try:
        # ---- CTRL: custom PAC, DIRECT for the probe host ----
        prof = make_profile(f"VD-pac-ctrl-{RUN}", PORT, extra_prefs=GUARD_PREFS)
        pac = os.path.join(prof, "ctrl.pac")
        with open(pac, "w", encoding="utf-8") as f:
            f.write('function FindProxyForURL(url, host) {\n'
                    f'  if (host == "127.0.0.1" || host == "localhost" || host == "{HOST}") return "DIRECT";\n'
                    '  return "PROXY 127.0.0.1:9";\n}\n')
        with open(os.path.join(prof, "user.js"), "a", encoding="utf-8") as f:
            f.write(f'user_pref("network.proxy.autoconfig_url", "file:///{pac.replace(os.sep, "/")}");\n')
        z = ZenSession(prof, PORT, headless=True)
        try:
            z.launch()
            srv.rec.clear()
            r = z.chrome(PROBE_JS, [base, None, "CTRL"])
            time.sleep(1)
            out["cases"]["CTRL_direct_pac"] = {"result": r, "server_hits": [h["first_line"] for h in srv.rec.snapshot()]}
        finally:
            z.quit()

        # ---- HARNESS: the exact shared PAC ----
        prof = make_profile(f"VD-pac-harness-{RUN}", PORT, extra_prefs=GUARD_PREFS)
        with open(os.path.join(prof, "block.pac"), encoding="utf-8") as f:
            out["harness_pac_text"] = f.read()
        z = ZenSession(prof, PORT, headless=True)
        try:
            z.launch()
            for label, fo in (("H_failover_false", False), ("H_failover_true_default", True),
                              ("H_failover_false_again", False)):
                srv.rec.clear()
                r = z.chrome(PROBE_JS, [base, fo, label])
                time.sleep(1)
                out["cases"][label] = {"result": r, "server_hits": [h["first_line"] for h in srv.rec.snapshot()]}
        finally:
            z.quit()
    finally:
        srv.stop()
    for k, v in out["cases"].items():
        print(k, json.dumps(v["result"])[:900], "\n   hits:", v["server_hits"])
    print("saved", save_result("VD-harness-pac-failover-" + RUN, out))


if __name__ == "__main__":
    main()
