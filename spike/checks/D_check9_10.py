"""Check 9 (part 2: install + manifest warnings in Zen) and check 10 (CSP) for group D.

- Builds: D-prod (production manifest + CSP), D-ctl (identical code, CSP that also allows 127.0.0.1),
  D-warn (positive control for manifest warnings), and the unmodified base spike extension.
- Runs a recording local HTTP server and a local sink proxy (never forwards; answers 403), and points the
  profile's PAC at the sink, so a request that reaches the network layer is visible as a proxy hit.
Usage: python spike/checks/D_check9_10.py
"""
import copy
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from D_common import (PROFILES, SPIKE, LocalServer, SinkProxy, ZenSession, build_xpi, console_messages,  # noqa: E402
                      make_d_profile, save_result)

PORT = 2954
D_PROD = "zen-tidy-spike-d@local"
D_CTL = "zen-tidy-spike-d-ctl@local"
D_WARN = "zen-tidy-spike-d-warn@local"
BASE = "zen-tidy-spike@local"
PROD_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
            "connect-src https://api.anthropic.com; object-src 'none'; base-uri 'none'; "
            "form-action 'none'; upgrade-insecure-requests")
CTL_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' http://127.0.0.1:*; "
           "connect-src https://api.anthropic.com http://127.0.0.1:* ws://127.0.0.1:*; object-src 'none'; "
           "base-uri 'none'; upgrade-insecure-requests")

ADDON_INFO_JS = """
const [ids, done] = arguments;
(async () => {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const out = {};
  for (const id of ids) {
    const r = {};
    try {
      const a = await AddonManager.getAddonByID(id);
      Object.assign(r, {found: !!a, isActive: a?.isActive, appDisabled: a?.appDisabled, userDisabled: a?.userDisabled,
        signedState: a?.signedState, temporarilyInstalled: a?.temporarilyInstalled, version: a?.version,
        permissionsGranted: a?.userPermissions});
    } catch (e) { r.addonError = String(e); }
    try {
      const ext = ExtensionParent.GlobalManager.getExtension(id);
      r.extensionWarnings = ext ? [...ext.warnings] : null;
      r.extensionErrors = ext ? [...ext.errors] : null;
      r.manifestVersion = ext?.manifestVersion;
      r.gecko = ext?.manifest?.browser_specific_settings?.gecko ?? null;
      r.manifestKeys = ext ? Object.keys(ext.manifest).filter(k => ext.manifest[k] !== null && ext.manifest[k] !== undefined) : null;
    } catch (e) { r.extError = String(e); }
    try {
      const pol = WebExtensionPolicy.getByID(id);
      r.extensionPageCSP = pol?.extensionPageCSP;
      r.baseCSP = pol?.baseCSP;
      r.policyPermissions = pol?.permissions;
      r.allowedOrigins = pol?.allowedOrigins?.patterns?.map(p => p.pattern);
    } catch (e) { r.policyError = String(e); }
    out[id] = r;
  }
  done(out);
})();
"""


def main():
    out = {"check9": {}, "check10": {}}
    srv = LocalServer()
    sink = SinkProxy()
    out["local_server_port"] = srv.port
    out["sink_proxy_port"] = sink.port
    xdir = os.path.join(PROFILES, "_xpi")
    prod_dir = os.path.join(SPIKE, "variants", "D-prod")
    with open(os.path.join(prod_dir, "manifest.json"), encoding="utf-8") as f:
        pm = json.load(f)
    assert pm["content_security_policy"]["extension_pages"] == PROD_CSP

    def bss(addon_id):
        b = copy.deepcopy(pm["browser_specific_settings"])
        b["gecko"]["id"] = addon_id
        return b

    x_prod = build_xpi(prod_dir, os.path.join(xdir, "D-prod.xpi"))
    x_ctl = build_xpi(prod_dir, os.path.join(xdir, "D-ctl.xpi"), {
        "name": "Zen Tidy Spike D control", "browser_specific_settings": bss(D_CTL),
        "content_security_policy": {"extension_pages": CTL_CSP}})
    x_warn = build_xpi(prod_dir, os.path.join(xdir, "D-warn.xpi"), {
        "name": "Zen Tidy Spike D warn control", "browser_specific_settings": bss(D_WARN),
        "zz_bogus_key": True, "permissions": pm["permissions"] + ["notARealPermission"]})
    x_base = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(xdir, "D-base.xpi"))

    prof = make_d_profile("D-c910", PORT, sink_port=sink.port,
                          extra_prefs={"network.dns.localDomains": "api.anthropic.com,example.com"})
    z = ZenSession(prof, PORT, headless=True)
    try:
        z.launch()
        # ---------------- check 9: install + manifest warnings ----------------
        installs = {}
        for name, x in (("D-prod", x_prod), ("D-ctl", x_ctl), ("D-warn", x_warn), ("base", x_base)):
            try:
                installs[name] = {"result": z.install_addon(x)}
            except Exception as e:  # noqa: BLE001
                installs[name] = {"error": str(e)[:1500]}
        time.sleep(2)
        out["check9"]["installs"] = installs
        out["check9"]["addon_info"] = z.chrome(ADDON_INFO_JS, [[D_PROD, D_CTL, D_WARN, BASE]])
        out["check9"]["console_reading_manifest"] = console_messages(z, ["Reading manifest"])
        out["check9"]["console_mentions_d_prod"] = console_messages(z, [D_PROD])

        # ---------------- check 10: CSP ----------------
        L = f"http://127.0.0.1:{srv.port}"
        ANTH = "https://api.anthropic.com/v1/models"
        results = []

        def run(label, fn):
            srv.rec.clear()
            sink.rec.clear()
            try:
                r = fn()
            except Exception as e:  # noqa: BLE001
                r = {"harness_error": str(e)[:800]}
            time.sleep(1.0)
            entry = {"label": label, "result": r, "local_server_hits": srv.rec.snapshot(), "proxy_hits": sink.hosts()}
            results.append(entry)
            print(label, json.dumps(r)[:300], "| server:", [h["first_line"] for h in entry["local_server_hits"]],
                  "| proxy:", entry["proxy_hits"])
            return entry

        # Background-page context sanity.
        prod = z.open_ext_page(D_PROD, "spike.html")
        hp = prod["handle"]
        out["check10"]["prod_bg_env"] = z.ext(hp, "bg", [{"type": "env"}])

        for ctx_name, h, addon in (("prod", hp, D_PROD),):
            # Page context.
            run(f"{ctx_name}/page/fetch example.com", lambda: z.ext(h, "probe", ["fetch", "https://example.com/"]))
            run(f"{ctx_name}/page/fetch 127.0.0.1", lambda: z.ext(h, "probe", ["fetch", f"{L}/{ctx_name}-page-fetch"]))
            run(f"{ctx_name}/page/fetch api.anthropic.com", lambda: z.ext(h, "probe", ["fetch", ANTH]))
            run(f"{ctx_name}/page/xhr 127.0.0.1", lambda: z.ext(h, "probe", ["xhr", f"{L}/{ctx_name}-page-xhr"]))
            run(f"{ctx_name}/page/ws 127.0.0.1",
                lambda: z.ext(h, "probe", ["ws", f"ws://127.0.0.1:{srv.port}/{ctx_name}-page-ws"]))
            run(f"{ctx_name}/page/beacon 127.0.0.1", lambda: z.ext(h, "probe", ["beacon", f"{L}/{ctx_name}-page-beacon"]))
            run(f"{ctx_name}/page/img 127.0.0.1", lambda: z.ext(h, "probe", ["img", f"{L}/img.png?{ctx_name}-page-img"]))
            # Background event page context.
            run(f"{ctx_name}/bg/fetch example.com",
                lambda: z.ext(h, "bg", [{"type": "probe", "kind": "fetch", "url": "https://example.com/"}]))
            run(f"{ctx_name}/bg/fetch 127.0.0.1",
                lambda: z.ext(h, "bg", [{"type": "probe", "kind": "fetch", "url": f"{L}/{ctx_name}-bg-fetch"}]))
            run(f"{ctx_name}/bg/fetch api.anthropic.com",
                lambda: z.ext(h, "bg", [{"type": "probe", "kind": "fetch", "url": ANTH}]))
            run(f"{ctx_name}/bg/xhr 127.0.0.1",
                lambda: z.ext(h, "bg", [{"type": "probe", "kind": "xhr", "url": f"{L}/{ctx_name}-bg-xhr"}]))

        # Positive control A: same probe code, CSP that also allows 127.0.0.1.
        ctl = z.open_ext_page(D_CTL, "spike.html")
        hc = ctl["handle"]
        run("ctl/page/fetch 127.0.0.1", lambda: z.ext(hc, "probe", ["fetch", f"{L}/ctl-page-fetch"]))
        run("ctl/page/xhr 127.0.0.1", lambda: z.ext(hc, "probe", ["xhr", f"{L}/ctl-page-xhr"]))
        run("ctl/page/ws 127.0.0.1", lambda: z.ext(hc, "probe", ["ws", f"ws://127.0.0.1:{srv.port}/ctl-page-ws"]))
        run("ctl/page/beacon 127.0.0.1", lambda: z.ext(hc, "probe", ["beacon", f"{L}/ctl-page-beacon"]))
        run("ctl/page/img 127.0.0.1", lambda: z.ext(hc, "probe", ["img", f"{L}/img.png?ctl-page-img"]))
        run("ctl/page/fetch example.com", lambda: z.ext(hc, "probe", ["fetch", "https://example.com/"]))
        run("ctl/bg/fetch 127.0.0.1",
            lambda: z.ext(hc, "bg", [{"type": "probe", "kind": "fetch", "url": f"{L}/ctl-bg-fetch"}]))
        run("ctl/bg/xhr 127.0.0.1",
            lambda: z.ext(hc, "bg", [{"type": "probe", "kind": "xhr", "url": f"{L}/ctl-bg-xhr"}]))
        run("ctl/bg/fetch api.anthropic.com",
            lambda: z.ext(hc, "bg", [{"type": "probe", "kind": "fetch", "url": ANTH}]))

        # Positive control B: the unmodified base extension (connect-src http://127.0.0.1:*).
        base = z.open_ext_page(BASE, "spike.html")
        hb = base["handle"]
        run("base/page/tryFetch 127.0.0.1", lambda: z.ext(hb, "tryFetch", [f"{L}/base-page-fetch"]))

        def base_bg():
            started = z.ext(hb, "bg", [{"type": "longFetch", "url": f"{L}/base-bg-fetch", "label": "D-base-bg"}])
            time.sleep(2)
            log = z.ext(hb, "api", ["storage.local.get", ["spikeLog"]])
            entries = [e for e in (log.get("value") or {}).get("spikeLog", []) if e.get("label") == "D-base-bg"
                       or e.get("event") == "longFetch.error"]
            return {"started": started, "log": entries}
        run("base/bg/longFetch 127.0.0.1", base_bg)

        out["check10"]["probes"] = results
        out["check10"]["console_csp"] = console_messages(z, ["Content-Security-Policy", "Content Security Policy"])
    finally:
        z.quit()
        srv.stop()
        sink.stop()
    path = save_result("D-check9-10", out)
    print(json.dumps(out["check9"]["addon_info"], indent=1)[:6000])
    print("reading-manifest console:", json.dumps(out["check9"]["console_reading_manifest"], indent=1)[:3000])
    print("saved", path)


if __name__ == "__main__":
    main()
