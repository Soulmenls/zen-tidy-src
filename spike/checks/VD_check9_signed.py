"""VD (adversarial verifier): independent re-check of the AMO-signed dev build found in spike/profiles/_signed/
(produced by another lane, see results/check9-sign-verify.json). Port 2968, profile VD-signed-<run>.

Signature checks ON (xpinstall.signatures.required=true, as in a real profile). Positive control: the unsigned
production-shape VD build must be refused. Signature verification is offline (embedded root), nothing is fetched.
Usage: python spike/checks/VD_check9_signed.py r1
"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VD_common import PROFILES, SPIKE, ZenSession, build_xpi, make_d_profile, save_result  # noqa: E402

PORT = 2968
RUN = sys.argv[1] if len(sys.argv) > 1 else "r1"
DEV_ID = "zen-tidy-dev@soulaymane"
VD_ID = "zen-tidy-spike-vd@local"

INFO_JS = """
const [ids, done] = arguments;
(async () => {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const out = { sigRequired: Services.prefs.getBoolPref("xpinstall.signatures.required"),
                SIGNEDSTATE_SIGNED: AddonManager.SIGNEDSTATE_SIGNED };
  for (const id of ids) {
    const a = await AddonManager.getAddonByID(id);
    const ext = ExtensionParent.GlobalManager.getExtension(id);
    out[id] = a ? { version: a.version, isActive: a.isActive, signedState: a.signedState, appDisabled: a.appDisabled,
                    warnings: ext ? [...ext.warnings] : null,
                    csp: WebExtensionPolicy.getByID(id)?.extensionPageCSP ?? null } : null;
  }
  done(out);
})();
"""


def main():
    signed = sorted(glob.glob(os.path.join(PROFILES, "_signed", "*.xpi")))[-1]
    unsigned = build_xpi(os.path.join(SPIKE, "variants", "VD-prod"), os.path.join(PROFILES, "_xpi", "VD-prod-unsigned.xpi"))
    out = {"signed_xpi": os.path.basename(signed)}
    prof = make_d_profile("VD-signed-" + RUN, PORT, extra_prefs={"xpinstall.signatures.required": True})
    z = ZenSession(prof, PORT, headless=True)
    try:
        z.launch()
        out["install_signed"] = z.install_addon(signed)
        try:
            out["install_unsigned"] = z.install_addon(unsigned)
        except RuntimeError as e:
            out["install_unsigned_error"] = str(e)[:300]
        out["info"] = z.chrome(INFO_JS, [[DEV_ID, VD_ID]])
        z.restart()
        out["info_after_restart"] = z.chrome(INFO_JS, [[DEV_ID, VD_ID]])
    finally:
        z.quit()
    print(json.dumps(out, indent=1))
    print("saved", save_result("VD-check9-signed-" + RUN, out))


if __name__ == "__main__":
    main()
