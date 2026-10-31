"""Check 9: the AMO-signed dev build installs with signature checks ON; an unsigned build is refused."""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402

PORT = 2949
DEV_ID = "zen-tidy-dev@soulaymane"

ADDON_INFO = """
  const [id, done] = arguments;
  (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const a = await AddonManager.getAddonByID(id);
    done(a ? {id: a.id, version: a.version, isActive: a.isActive, signedState: a.signedState,
              SIGNEDSTATE_SIGNED: AddonManager.SIGNEDSTATE_SIGNED, appDisabled: a.appDisabled,
              temporarilyInstalled: a.temporarilyInstalled,
              sigRequired: Services.prefs.getBoolPref("xpinstall.signatures.required")} : null);
  })();
"""


def main():
    signed = sorted(glob.glob(os.path.join(SPIKE, "profiles", "_signed", "*.xpi")))[-1]
    unsigned = build_xpi(os.path.join(SPIKE, "variants", "sign-dev"),
                         os.path.join(SPIKE, "profiles", "_xpi", "sign-dev-unsigned.xpi"),
                         manifest_overrides={"version": "0.0.2"})
    out = {"signed_xpi": os.path.basename(signed)}
    # Signature checks ON, as in a real profile (overrides the template's throwaway setting).
    prof = make_profile("sign-verify", PORT, extra_prefs={"xpinstall.signatures.required": True})
    z = ZenSession(prof, PORT).launch()
    try:
        out["install_signed"] = z.install_addon(signed)
        out["info_after_install"] = z.chrome(ADDON_INFO, [DEV_ID])
        z.restart()
        out["info_after_restart"] = z.chrome(ADDON_INFO, [DEV_ID])
        # Positive control: an unsigned build (newer version) must be refused.
        try:
            out["install_unsigned"] = z.install_addon(unsigned)
        except RuntimeError as e:
            out["install_unsigned_error"] = str(e)[:400]
        out["info_after_unsigned_attempt"] = z.chrome(ADDON_INFO, [DEV_ID])
    finally:
        z.quit()
    save_result("check9-sign-verify", out)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
