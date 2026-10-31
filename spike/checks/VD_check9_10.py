"""VD copy of D_check9_10.py (adversarial verifier, port 2964, profiles VD-c910-<run>). Additions: a
strict_min_version 142.0 install, CSP redirect-hop probes, api.anthropic.com port/scheme probes.
Usage: python spike/checks/VD_check9_10.py r1

Original: Check 9 (part 2: install + manifest warnings in Zen) and check 10 (CSP) for group D.

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
from VD_common import (PROFILES, SPIKE, LocalServer, SinkProxy, ZenSession, build_xpi, console_messages,  # noqa: E402
                      make_d_profile, save_result)

PORT = 2964
RUN = sys.argv[1] if len(sys.argv) > 1 else "r1"
D_MIN142 = "zen-tidy-spike-d-min142@local"
D_REDIR = "zen-tidy-spike-d-redir@local"
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
    srv_b = LocalServer()
    sink = SinkProxy()
    out["local_server_port"] = srv.port
    out["sink_proxy_port"] = sink.port
    out["local_server_b_port"] = srv_b.port
    xdir = os.path.join(PROFILES, "_xpi")
    prod_dir = os.path.join(SPIKE, "variants", "D-prod")
    with open(os.path.join(prod_dir, "manifest.json"), encoding="utf-8") as f:
        pm = json.load(f)
    assert pm["content_security_policy"]["extension_pages"] == PROD_CSP

    def bss(addon_id):
        b = copy.deepcopy(pm["browser_specific_settings"])
        b["gecko"]["id"] = addon_id
        return b

    x_prod = build_xpi(prod_dir, os.path.join(xdir, "VD-prod.xpi"))
    x_ctl = build_xpi(prod_dir, os.path.join(xdir, "VD-ctl.xpi"), {
        "name": "Zen Tidy Spike D control", "browser_specific_settings": bss(D_CTL),
        "content_security_policy": {"extension_pages": CTL_CSP}})
    x_warn = build_xpi(prod_dir, os.path.join(xdir, "VD-warn.xpi"), {
        "name": "Zen Tidy Spike D warn control", "browser_specific_settings": bss(D_WARN),
        "zz_bogus_key": True, "permissions": pm["permissions"] + ["notARealPermission"]})
    x_base = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(xdir, "VD-base.xpi"))
    b142 = bss(D_MIN142)
    b142["gecko"]["strict_min_version"] = "142.0"
    x_min142 = build_xpi(prod_dir, os.path.join(xdir, "VD-min142.xpi"), {
        "name": "Zen Tidy Spike D min142", "browser_specific_settings": b142})
    REDIR_CSP = PROD_CSP.replace("connect-src https://api.anthropic.com", f"connect-src http://127.0.0.1:{srv.port}")
    out["redir_csp"] = REDIR_CSP
    x_redir = build_xpi(prod_dir, os.path.join(xdir, "VD-redir.xpi"), {
        "name": "Zen Tidy Spike D redirect", "browser_specific_settings": bss(D_REDIR),
        "content_security_policy": {"extension_pages": REDIR_CSP}})

    prof = make_d_profile("VD-c910-" + RUN, PORT, sink_port=sink.port,
                          extra_prefs={"network.dns.localDomains": "api.anthropic.com,example.com"})
    z = ZenSession(prof, PORT, headless=True)
    try:
        z.launch()
        # ---------------- check 9: install + manifest warnings ----------------
        installs = {}
        for name, x in (("D-prod", x_prod), ("D-ctl", x_ctl), ("D-warn", x_warn), ("base", x_base),
                        ("D-min142", x_min142), ("D-redir", x_redir)):
            try:
                installs[name] = {"result": z.install_addon(x)}
            except Exception as e:  # noqa: BLE001
                installs[name] = {"error": str(e)[:1500]}
        time.sleep(2)
        out["check9"]["installs"] = installs
        out["check9"]["addon_info"] = z.chrome(ADDON_INFO_JS, [[D_PROD, D_CTL, D_WARN, BASE, D_MIN142, D_REDIR]])
        out["check9"]["console_reading_manifest"] = console_messages(z, ["Reading manifest"])
        out["check9"]["console_mentions_d_prod"] = console_messages(z, [D_PROD])

        # ---------------- check 10: CSP ----------------
        L = f"http://127.0.0.1:{srv.port}"
        ANTH = "https://api.anthropic.com/v1/models"
        results = []

        def run(label, fn):
            srv.rec.clear()
            srv_b.rec.clear()
            sink.rec.clear()
            try:
                r = fn()
            except Exception as e:  # noqa: BLE001
                r = {"harness_error": str(e)[:800]}
            time.sleep(1.0)
            entry = {"label": label, "result": r, "local_server_hits": srv.rec.snapshot(),
                     "local_server_b_hits": srv_b.rec.snapshot(), "proxy_hits": sink.hosts()}
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

        # VD: scheme/port variants of the allowlisted host.
        run("prod/page/fetch api.anthropic.com:8443", lambda: z.ext(hp, "probe", ["fetch", "https://api.anthropic.com:8443/v1/models"]))
        run("prod/bg/fetch api.anthropic.com:8443",
            lambda: z.ext(hp, "bg", [{"type": "probe", "kind": "fetch", "url": "https://api.anthropic.com:8443/v1/models"}]))
        run("prod/page/fetch http://api.anthropic.com", lambda: z.ext(hp, "probe", ["fetch", "http://api.anthropic.com/v1/models"]))
        run("prod/page/fetch api.anthropic.com.example.com",
            lambda: z.ext(hp, "probe", ["fetch", "https://api.anthropic.com.example.com/"]))

        # VD: redirect hops. CSP allows only 127.0.0.1:<srv.port>; server A redirects.
        LB = f"http://127.0.0.1:{srv_b.port}"
        rd = z.open_ext_page(D_REDIR, "spike.html")
        hr = rd["handle"]
        run("redir/page/fetch A->A (allowed->allowed, control)",
            lambda: z.ext(hr, "probe", ["fetch", f"{L}/redir?to={L}/redir-page-AA-target"]))
        run("redir/page/fetch A->B (allowed->blocked)",
            lambda: z.ext(hr, "probe", ["fetch", f"{L}/redir?to={LB}/redir-page-AB-target"]))
        run("redir/page/fetch B direct (blocked, control)",
            lambda: z.ext(hr, "probe", ["fetch", f"{LB}/redir-page-B-direct"]))
        run("redir/page/xhr A->B (allowed->blocked)",
            lambda: z.ext(hr, "probe", ["xhr", f"{L}/redir?to={LB}/redir-page-xhr-AB-target"]))
        run("redir/bg/fetch A->A (allowed->allowed, control)",
            lambda: z.ext(hr, "bg", [{"type": "probe", "kind": "fetch", "url": f"{L}/redir?to={L}/redir-bg-AA-target"}]))
        run("redir/bg/fetch A->B (allowed->blocked)",
            lambda: z.ext(hr, "bg", [{"type": "probe", "kind": "fetch", "url": f"{L}/redir?to={LB}/redir-bg-AB-target"}]))
        run("redir/page/fetch A->example.com (allowed->blocked, via sink)",
            lambda: z.ext(hr, "probe", ["fetch", f"{L}/redir?to=https://example.com/redir-target"]))

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
        srv_b.stop()
        sink.stop()
    path = save_result("VD-check9-10-" + RUN, out)
    print(json.dumps(out["check9"]["addon_info"], indent=1)[:6000])
    print("reading-manifest console:", json.dumps(out["check9"]["console_reading_manifest"], indent=1)[:3000])
    print("saved", path)


if __name__ == "__main__":
    main()
