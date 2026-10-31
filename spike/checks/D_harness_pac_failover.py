"""Side check (found while doing check 10): does the harness PAC really block, or does Firefox fail over to
DIRECT when the PAC's dead proxy (127.0.0.1:9) refuses the connection?

A made-up host name is mapped to 127.0.0.1 with network.dns.localDomains, so even a DIRECT failover only ever
reaches the local recording server. The host name is not a loopback literal, so the PAC is consulted.
  A: no proxy at all            -> request must reach the server (proves the name mapping works)
  B: harness PAC, default prefs -> a hit here means the PAC fails over to DIRECT
  C: harness PAC + network.proxy.failover_direct=false -> no hit expected
Usage: python spike/checks/D_harness_pac_failover.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from D_common import LocalServer, ZenSession, make_profile, save_result  # noqa: E402

PORT = 2954
HOST = "failover-probe.example"

FETCH_JS = """
const [url, done] = arguments;
(async () => {
  let fetchResult;
  try { const r = await fetch(url, {cache: "no-store"}); fetchResult = {ok: true, status: r.status, body: (await r.text()).slice(0, 40)}; }
  catch (e) { fetchResult = {ok: false, error: String(e)}; }
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const tab = win.gBrowser.addTab(url + "-tab", {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
  await new Promise(r => win.setTimeout(r, 3000));
  const tabURI = tab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec;
  win.gBrowser.removeTab(tab);
  done({fetch: fetchResult, tabDocumentURI: String(tabURI).slice(0, 120),
        proxyType: Services.prefs.getIntPref("network.proxy.type"),
        failoverDirect: Services.prefs.getBoolPref("network.proxy.failover_direct"),
        failoverDirectHasUserValue: Services.prefs.prefHasUserValue("network.proxy.failover_direct")});
})();
"""


def main():
    srv = LocalServer()
    out = {"server_port": srv.port, "cases": {}}
    cases = {
        "A_no_proxy_mapping_control": {"network.proxy.type": 0, "network.dns.localDomains": HOST},
        "B_harness_pac_default": {"network.dns.localDomains": HOST},
        "C_harness_pac_failover_direct_false": {"network.dns.localDomains": HOST, "network.proxy.failover_direct": False},
    }
    try:
        for name, prefs in cases.items():
            prof = make_profile("D-pac-" + name.split("_")[0], PORT, extra_prefs=prefs)
            z = ZenSession(prof, PORT, headless=True)
            srv.rec.clear()
            try:
                z.launch()
                r = z.chrome(FETCH_JS, [f"http://{HOST}:{srv.port}/{name}"])
                time.sleep(1)
            finally:
                z.quit()
            hits = [h["first_line"] for h in srv.rec.snapshot()]
            out["cases"][name] = {"prefs": prefs, "result": r, "server_hits": hits}
            print(name, json.dumps(r), "hits:", hits)
    finally:
        srv.stop()
    print("saved", save_result("D-harness-pac-failover", out))


if __name__ == "__main__":
    main()
