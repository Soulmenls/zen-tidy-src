"""VD copy of D_check9_lint.py (adversarial verifier). Runs the CACHED web-ext 10.8.0 offline (no npx network),
adds a variant with strict_min_version 142.0 as the implementation notes require.

Original: Check 9 (part 1): web-ext lint on the base spike extension and on the production-shape variant.

Real AMO signing needs the user's AMO API credentials, so it is not attempted here (BLOCKED).
Usage: python spike/checks/D_check9_lint.py
"""
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from VD_common import PROFILES, SPIKE, save_result  # noqa: E402

WEB_EXT = "web-ext@10.8.0"
WEB_EXT_JS = os.path.join(os.environ["LOCALAPPDATA"], "npm-cache", "_npx", "9b9ff43d0381ab42", "node_modules", "web-ext",
                          "bin", "web-ext.js")
ENV = dict(os.environ, NO_UPDATE_NOTIFIER="1", npm_config_offline="true")


def lint(src, *extra):
    cmd = ["node", WEB_EXT_JS, "lint", "--source-dir", src, "--output", "json", "--no-config-discovery", *extra]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=ENV)
    try:
        data = json.loads(p.stdout)
    except ValueError:
        return {"exit": p.returncode, "raw": p.stdout[-2000:], "stderr": p.stderr[-2000:]}
    items = [{"type": x["_type"], "code": x["code"], "message": x["message"], "description": x.get("description"),
              "file": x.get("file")} for k in ("errors", "warnings", "notices") for x in data[k]]
    return {"exit": p.returncode, "summary": data["summary"], "items": items,
            "metadata": {k: data["metadata"].get(k) for k in ("id", "manifestVersion", "firefoxMinVersion")}}


def variant_copy(name, mutate):
    dst = os.path.join(PROFILES, "_VD-lint", name)
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(os.path.join(SPIKE, "variants", "D-prod"), dst)
    mp = os.path.join(dst, "manifest.json")
    with open(mp, encoding="utf-8") as f:
        m = json.load(f)
    mutate(m)
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2)
    return dst


def main():
    out = {"web_ext": WEB_EXT}
    out["web_ext_version"] = subprocess.run(["node", WEB_EXT_JS, "--version"], capture_output=True, env=ENV,
                                            text=True, timeout=300).stdout.strip()
    import json as _j
    out["addons_linter_version"] = _j.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(WEB_EXT_JS))),
                                                    "addons-linter", "package.json"), encoding="utf-8"))["version"]
    base = os.path.join(SPIKE, "ext")
    prod = os.path.join(SPIKE, "variants", "D-prod")
    with open(os.path.join(prod, "manifest.json"), encoding="utf-8") as f:
        pm = json.load(f)
    out["prod_manifest_forbidden_keys"] = [k for k in ("web_accessible_resources", "content_scripts",
                                                      "externally_connectable") if k in pm]
    out["base"] = lint(base)
    out["base_self_hosted"] = lint(base, "--self-hosted")
    out["prod"] = lint(prod)
    out["prod_self_hosted"] = lint(prod, "--self-hosted")

    def add_android(m):
        m["browser_specific_settings"]["gecko_android"] = {"strict_min_version": "142.0"}
    out["prod_plus_gecko_android_142_self_hosted"] = lint(variant_copy("prod-android142", add_android), "--self-hosted")

    def min142(m):
        m["browser_specific_settings"]["gecko"]["strict_min_version"] = "142.0"
    out["VD_prod_min142_self_hosted"] = lint(variant_copy("prod-min142", min142), "--self-hosted")
    out["VD_prod_min142_listed"] = lint(variant_copy("prod-min142b", min142))

    def min142_no_update_url(m):
        m["browser_specific_settings"]["gecko"]["strict_min_version"] = "142.0"
        del m["browser_specific_settings"]["gecko"]["update_url"]
    out["VD_prod_min142_no_update_url_listed"] = lint(variant_copy("prod-min142-noupd", min142_no_update_url))

    def add_ext_connectable(m):
        m["externally_connectable"] = {"matches": ["https://example.com/*"]}
    out["VD_control_prod_with_externally_connectable_self_hosted"] = lint(
        variant_copy("prod-extconn", add_ext_connectable), "--self-hosted")
    out["VD_sign_dev_self_hosted"] = lint(os.path.join(SPIKE, "variants", "sign-dev"), "--self-hosted")

    def add_website_content(m):
        m["browser_specific_settings"]["gecko"]["data_collection_permissions"]["required"].append("websiteContent")
    out["prod_plus_websiteContent_self_hosted"] = lint(variant_copy("prod-websiteContent", add_website_content),
                                                       "--self-hosted")

    def no_dcp(m):
        del m["browser_specific_settings"]["gecko"]["data_collection_permissions"]
    out["control_prod_without_data_collection_self_hosted"] = lint(variant_copy("prod-no-dcp", no_dcp), "--self-hosted")

    def add_forbidden(m):
        m["web_accessible_resources"] = [{"resources": ["spike.html"], "matches": ["<all_urls>"]}]
        m["content_scripts"] = [{"matches": ["<all_urls>"], "js": ["spike.js"]}]
    out["control_prod_with_war_and_content_scripts_self_hosted"] = lint(variant_copy("prod-forbidden", add_forbidden),
                                                                         "--self-hosted")
    path = save_result("VD-check9-lint", out)
    for k, v in out.items():
        if isinstance(v, dict) and "summary" in v:
            print(k, v["exit"], v["summary"], [(i["type"], i["code"]) for i in v["items"]])
    print("saved", path)


if __name__ == "__main__":
    main()
