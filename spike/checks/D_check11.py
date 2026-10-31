"""Check 11: saving the key triggers no password-manager prompt.

D-prod's key.html builds the key field exactly per the implementation notes. Marionette types a fake key
into it in the content context (FindElement + ElementSendKeys + ElementClick). Chrome scope then checks the
"password" doorhanger, every PopupNotifications.show() call, LoginManagerParent's test listener, password
manager observer topics, the parent actor's possibleValues and Services.logins.

Positive control: a naive <form> with text+password+submit (D-pwctl build, CSP without form-action 'none').
Also: page closed / navigated / field removed while the field is still filled, and two mitigations.
Usage: python spike/checks/D_check11.py [--headed]
"""
import copy
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from D_common import (PROFILES, SPIKE, ZenSession, back_to_chrome, build_xpi, click,  # noqa: E402
                      console_messages, content_js, ext_url, find, make_profile, open_tab, save_result, send_keys,
                      to_content)

PORT = 2958
D_PROD = "zen-tidy-spike-d@local"
D_PW = "zen-tidy-spike-d-pw@local"
KEY = "sk-ant-test-0000"
PW_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
          "connect-src https://api.anthropic.com; object-src 'none'; base-uri 'none'; upgrade-insecure-requests")

INSTRUMENT_JS = """
const [KEY, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const { LoginManagerParent } = ChromeUtils.importESModule("resource://gre/modules/LoginManagerParent.sys.mjs");
  const D = win.__D = { events: [] };
  const push = e => D.events.push({ t: Date.now(), ...e });
  D.push = push;
  // Inspection only: records what the password manager does, then calls through unchanged.
  LoginManagerParent.setListenerForTests((msg, data) => {
    const d = data?.data;
    push({ kind: "LoginManagerParent", msg, origin: data?.origin ?? null,
           pwLen: d?.newPasswordField ? d.newPasswordField.value.length : null,
           pwIsKey: d?.newPasswordField ? d.newPasswordField.value === KEY : null,
           hasUsername: !!d?.usernameField?.value, dismissedPrompt: d?.dismissedPrompt ?? null });
  });
  const obs = (subject, topic, data) => {
    let extra = {};
    try {
      if (subject instanceof Ci.nsILoginInfo) extra = { loginOrigin: subject.origin, pwIsKey: subject.password === KEY };
    } catch (e) {}
    push({ kind: "observer", topic, data: typeof data === "string" ? data.slice(0, 160) : null, ...extra });
  };
  for (const t of ["passwordmgr-form-submission-detected", "passwordmgr-storage-changed",
                   "passwordmgr-prompt-save", "passwordmgr-prompt-change"]) Services.obs.addObserver(obs, t);
  D.obs = obs;
  const PN = win.PopupNotifications;
  const origShow = PN.show;
  PN.show = function (browser, id, message, anchorID, mainAction, secondaryActions, options) {
    push({ kind: "PopupNotifications.show", id, anchorID, dismissed: !!options?.dismissed,
           url: String(browser?.currentURI?.spec || "").slice(0, 140) });
    return origShow.apply(this, arguments);
  };
  const pref = (n) => { try {
    const t = Services.prefs.getPrefType(n);
    return t === 128 ? Services.prefs.getBoolPref(n) : t === 64 ? Services.prefs.getIntPref(n)
         : t === 32 ? Services.prefs.getStringPref(n) : "(unset)";
  } catch (e) { return String(e); } };
  done({ instrumented: true,
         prefs: Object.fromEntries(["signon.rememberSignons", "signon.formlessCapture.enabled",
           "signon.formRemovalCapture.enabled", "signon.capture.inputChanges.enabled",
           "signon.storeWhenAutocompleteOff", "signon.userInputRequiredToCapture.enabled",
           "signon.passwordEditCapture.enabled", "network.proxy.failover_direct", "network.proxy.type"]
           .map(n => [n, pref(n)])),
         loginSavingEnabledForExtensions: null,
         headless: Services.env.get("MOZ_HEADLESS") || (Cc["@mozilla.org/gfx/info;1"]?.getService(Ci.nsIGfxInfo)?.isHeadless ?? null) });
})();
"""

SNAPSHOT_JS = """
const [handle, KEY, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const browser = handle ? NavigableManager.getBrowserById(handle) : null;
  const out = { browserAlive: !!browser && !!browser.browsingContext };
  if (browser) {
    out.url = String(browser.currentURI?.spec || "").slice(0, 160);
    const n = win.PopupNotifications.getNotification("password", browser);
    out.passwordNotification = n ? { id: n.id, dismissed: n.dismissed, anchorID: n.anchorID,
      message: String(n.message || "").slice(0, 160), isPrivate: !!n.options?.isPrivate } : null;
    try {
      const all = browser.popupNotifications || win.PopupNotifications._currentNotifications || [];
      out.allNotificationsForBrowser = [...all].map(x => ({ id: x.id, dismissed: x.dismissed }));
    } catch (e) { out.allNotificationsForBrowser = String(e); }
    out.panelState = win.PopupNotifications.panel?.state ?? null;
    const icon = win.document.getElementById("password-notification-icon");
    out.anchorIcon = icon ? { hiddenAttr: icon.hidden, visible: icon.checkVisibility ? icon.checkVisibility() : null,
                              width: Math.round(icon.getBoundingClientRect().width) } : null;
    out.selected = win.gBrowser.selectedBrowser === browser;
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getExistingActor("LoginManager");
      const pv = actor?.possibleValues;
      out.lmParentPossibleValues = actor ? { passwords: pv ? pv.passwords.size ?? [...pv.passwords].length : null,
        containsKey: pv ? [...pv.passwords].includes(KEY) : null,
        usernames: pv ? [...pv.usernames].length : null } : "no LoginManager actor on current window global";
    } catch (e) { out.lmParentPossibleValues = String(e); }
  }
  const logins = await Services.logins.getAllLogins();
  out.logins = logins.map(l => ({ origin: l.origin, formActionOrigin: l.formActionOrigin,
                                  hasUsername: !!l.username, pwIsKey: l.password === KEY }));
  out.events = win.__D.events.splice(0);
  done(out);
})();
"""

CLOSE_TAB_JS = """
const [handle, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const browser = NavigableManager.getBrowserById(handle);
  const tab = browser && win.gBrowser.getTabForBrowser(browser);
  if (tab) win.gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
  await new Promise(r => win.setTimeout(r, 300));
  done(!!tab);
})();
"""

USER_NAV_JS = """
const [handle, url, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const browser = NavigableManager.getBrowserById(handle);
  // Like the user typing a URL: system-principal triggered load.
  browser.fixupAndLoadURIString(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  await new Promise(r => win.setTimeout(r, 1500));
  done(String(browser.currentURI.spec));
})();
"""

ACCEPT_SAVE_JS = """
const [handle, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const browser = NavigableManager.getBrowserById(handle);
  const n = win.PopupNotifications.getNotification("password", browser);
  if (!n) return done({ accepted: false, reason: "no notification" });
  await n.mainAction.callback({ source: "button" });
  await new Promise(r => win.setTimeout(r, 1000));
  done({ accepted: true });
})();
"""


REMOVE_LOGINS_FOR_ORIGIN_JS = """
const [origin, done] = arguments;
(async () => {
  let n = 0;
  for (const l of await Services.logins.getAllLogins()) if (l.origin === origin) { Services.logins.removeLogin(l); n++; }
  done(n);
})();
"""

# Faithful version of "the user clicks the key icon in the address bar, then Save": re-open the dismissed
# doorhanger panel (this fills its username/password fields from the captured login), read what the panel's
# password field holds, then click the panel's main button.
REOPEN_AND_SAVE_JS = """
const [handle, KEY, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const browser = NavigableManager.getBrowserById(handle);
  const PN = win.PopupNotifications;
  const n = PN.getNotification("password", browser);
  if (!n) return done({ reopened: false, reason: "no notification" });
  const wasDismissed = n.dismissed;
  const shown = new Promise(r => PN.panel.addEventListener("popupshown", () => r(true), { once: true }));
  n.reshow();
  const opened = await Promise.race([shown, new Promise(r => win.setTimeout(() => r(false), 4000))]);
  await new Promise(r => win.setTimeout(r, 300));
  const pw = win.document.getElementById("password-notification-password");
  const user = win.document.getElementById("password-notification-username");
  const panelHasKey = pw ? pw.value === KEY : null;
  const el = [...PN.panel.children].find(c => c.notification === n) || PN.panel.firstElementChild;
  const keySaved = async () => (await Services.logins.getAllLogins()).some(l => l.password === KEY);
  let clicked = false, savedBy = null;
  if (el?.button) { el.button.click(); clicked = true; }
  await new Promise(r => win.setTimeout(r, 1000));
  if (await keySaved()) savedBy = "panel main button";
  else if (PN.getNotification("password", browser)) {
    // The synthetic click does not always land; the main action reads the same (now filled) panel fields.
    await n.mainAction.callback({ source: "button" });
    await new Promise(r => win.setTimeout(r, 1000));
    if (await keySaved()) savedBy = "mainAction.callback after panel opened";
  }
  done({ reopened: true, wasDismissed, panelOpened: opened, panelPasswordFieldHasFullKey: panelHasKey,
         panelPasswordFieldLength: pw ? pw.value.length : null, panelUsernameLength: user ? user.value.length : null,
         clickedMainButton: clicked, savedBy, panelStateAfter: PN.panel.state });
})();
"""


SESSION_JS = """
const [handle, KEY, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
  const browser = NavigableManager.getBrowserById(handle);
  const tab = win.gBrowser.getTabForBrowser(browser);
  await TabStateFlusher.flush(browser);
  await new Promise(r => win.setTimeout(r, 300));
  const st = win.SessionStore.getTabState(tab);
  const i = st.indexOf('"formdata"');
  done({ tabStateContainsKey: st.includes(KEY),
         formdataExcerpt: i < 0 ? null : st.slice(i, i + 220).split(KEY).join("<KEY>") });
})();
"""

FORMHISTORY_JS = """
const [KEY, done] = arguments;
(async () => {
  const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
  const rows = await FormHistory.search(["fieldname", "value"], {});
  done({ count: rows.length, fieldnames: [...new Set(rows.map(r => r.fieldname))],
         anyValueIsKey: rows.some(r => r.value === KEY),
         controlUserSaved: rows.some(r => r.value === "spike-user" || r.value === "spike-user2") });
})();
"""


def state(z, handle):
    to_content(z, handle)
    s = content_js(z, "return (window.wrappedJSObject || window).keyPage ? "
                      "(window.wrappedJSObject || window).keyPage.state() : JSON.stringify({noKeyPage: true, "
                      "url: location.href, visibility: document.visibilityState})")
    back_to_chrome(z)
    return json.loads(s)


def snap(z, handle, settle=2.0):
    time.sleep(settle)
    back_to_chrome(z)
    return z.chrome(SNAPSHOT_JS, [handle, KEY])


def close_tab(z, handle):
    back_to_chrome(z)
    return z.chrome(CLOSE_TAB_JS, [handle])


def main():
    headed = "--headed" in sys.argv
    out = {"headed": headed, "scenarios": {}}
    xdir = os.path.join(PROFILES, "_xpi")
    prod_dir = os.path.join(SPIKE, "variants", "D-prod")
    with open(os.path.join(prod_dir, "manifest.json"), encoding="utf-8") as f:
        pm = json.load(f)
    bss = copy.deepcopy(pm["browser_specific_settings"])
    bss["gecko"]["id"] = D_PW
    x_prod = build_xpi(prod_dir, os.path.join(xdir, "D-prod-c11.xpi"))
    x_pw = build_xpi(prod_dir, os.path.join(xdir, "D-pwctl.xpi"), {
        "name": "Zen Tidy Spike D password control", "browser_specific_settings": bss,
        "content_security_policy": {"extension_pages": PW_CSP}})

    prof = make_profile("D-c11" + ("-headed" if headed else ""), PORT,
                        extra_prefs={"signon.rememberSignons": True, "signon.debug": True})
    z = ZenSession(prof, PORT, headless=not headed)
    try:
        z.launch()
        out["install"] = {"prod": z.install_addon(x_prod), "pwctl": z.install_addon(x_pw)}
        time.sleep(1.5)
        out["instrument"] = z.chrome(INSTRUMENT_JS, [KEY])

        key_url = ext_url(z, D_PROD, "key.html")
        keytext_url = ext_url(z, D_PROD, "keytext.html")
        next_url = ext_url(z, D_PROD, "next.html")
        naive_pw_url = ext_url(z, D_PW, "naive.html")
        naive_prod_url = ext_url(z, D_PROD, "naive.html")
        prod_origin = key_url.split("/key.html")[0]
        sc = out["scenarios"]
        z.chrome(SNAPSHOT_JS, [None, KEY])  # drain start-up events

        def fresh(url):
            """Open a fresh, selected tab; guard against autofill from a login saved for the D-prod origin."""
            removed = z.chrome(REMOVE_LOGINS_FOR_ORIGIN_JS, [prod_origin])
            t = open_tab(z, url)
            t["removed_prod_logins_before"] = removed
            t["initial_state"] = state(z, t["handle"])
            return t

        def type_key(handle):
            to_content(z, handle)
            send_keys(z, find(z, "#key"), KEY)

        def click_on(handle, css):
            to_content(z, handle)
            click(z, find(z, css))

        # ---- P1: positive control, naive form, CSP without form-action ----
        t = open_tab(z, naive_pw_url)
        to_content(z, t["handle"])
        send_keys(z, find(z, "#user"), "spike-user")
        send_keys(z, find(z, "#pass"), "fake-pass-1234")
        click(z, find(z, "#submit"))
        r = {"tab": t, "after": snap(z, t["handle"], 3)}
        if r["after"].get("passwordNotification"):
            r["accept"] = z.chrome(ACCEPT_SAVE_JS, [t["handle"]])
            r["after_accept"] = snap(z, t["handle"], 1)
        sc["P1_naive_form_positive_control"] = r
        close_tab(z, t["handle"])

        # ---- P2: naive form under the production CSP (form-action 'none') ----
        t = fresh(naive_prod_url)
        to_content(z, t["handle"])
        send_keys(z, find(z, "#user"), "spike-user2")
        send_keys(z, find(z, "#pass"), "fake-pass-5678")
        click(z, find(z, "#submit"))
        sc["P2_naive_form_under_prod_csp"] = {"tab": t, "after": snap(z, t["handle"], 3)}
        close_tab(z, t["handle"])

        # ---- S1: spec key field: type, click Save; then a page-triggered navigation with the empty field ----
        t = fresh(key_url)
        type_key(t["handle"])
        s1 = {"tab": t, "state_before_click": state(z, t["handle"])}
        click_on(t["handle"], "#save")
        time.sleep(0.5)
        s1["state_after_save"] = state(z, t["handle"])
        s1["after"] = snap(z, t["handle"])
        click_on(t["handle"], "#nav")
        s1["after_nav_with_empty_field"] = snap(z, t["handle"])
        sc["S1_spec_type_then_save"] = s1
        close_tab(z, t["handle"])
        sp = z.open_ext_page(D_PROD, "spike.html")
        stored = z.ext(sp["handle"], "api", ["storage.local.get", ["apiKey"]])
        s1["storage_has_key"] = (stored.get("value") or {}).get("apiKey") == KEY
        z.ext(sp["handle"], "api", ["storage.local.remove", ["apiKey"]])

        # ---- S2: field still filled, tab closed ----
        t = fresh(key_url)
        type_key(t["handle"])
        s2 = {"tab": t, "state": state(z, t["handle"])}
        s2["closed"] = close_tab(z, t["handle"])
        s2["after"] = snap(z, t["handle"])
        sc["S2_filled_then_tab_closed"] = s2

        # ---- S3: field still filled, page-triggered navigation (link in the page) ----
        t = fresh(key_url)
        type_key(t["handle"])
        s3 = {"tab": t, "state": state(z, t["handle"])}
        click_on(t["handle"], "#nav")
        s3["after"] = snap(z, t["handle"])
        sc["S3_filled_then_page_navigation"] = s3
        close_tab(z, t["handle"])

        # ---- S4: field still filled, field removed from the DOM ----
        t = fresh(key_url)
        type_key(t["handle"])
        click_on(t["handle"], "#rm")
        sc["S4_filled_then_field_removed"] = {"tab": t, "state": state(z, t["handle"]), "after": snap(z, t["handle"])}
        close_tab(z, t["handle"])

        # ---- S5: field still filled, user navigation (system-principal load, like typing a URL) ----
        t = fresh(key_url)
        type_key(t["handle"])
        s5 = {"tab": t, "state": state(z, t["handle"])}
        s5["navigated_to"] = z.chrome(USER_NAV_JS, [t["handle"], next_url])
        s5["after"] = snap(z, t["handle"])
        sc["S5_filled_then_user_navigation"] = s5
        close_tab(z, t["handle"])

        # ---- M: mitigations that keep type=password ----
        for mode in ("change", "mousedown"):
            t = fresh(key_url + "?m=" + mode)
            type_key(t["handle"])
            click_on(t["handle"], "#save")
            time.sleep(0.5)
            m = {"tab": t, "state_after_save": state(z, t["handle"]), "after_save": snap(z, t["handle"])}
            close_tab(z, t["handle"])
            t = fresh(key_url + "?m=" + mode)
            type_key(t["handle"])
            click_on(t["handle"], "#nav")
            m["after_filled_then_page_navigation"] = snap(z, t["handle"])
            close_tab(z, t["handle"])
            sc[f"M_{mode}"] = m

        # ---- T1: never type=password: type=text masked with -webkit-text-security ----
        t = fresh(keytext_url)
        type_key(t["handle"])
        t1 = {"tab": t, "state_before_click": state(z, t["handle"])}
        click_on(t["handle"], "#save")
        time.sleep(0.5)
        t1["state_after_save"] = state(z, t["handle"])
        t1["after_save"] = snap(z, t["handle"])
        close_tab(z, t["handle"])
        t = fresh(keytext_url)
        type_key(t["handle"])
        click_on(t["handle"], "#nav")
        t1["after_filled_then_page_navigation"] = snap(z, t["handle"])
        close_tab(z, t["handle"])
        t = fresh(keytext_url)
        type_key(t["handle"])
        t1["closed"] = close_tab(z, t["handle"])
        t1["after_filled_then_tab_closed"] = snap(z, t["handle"])
        t = fresh(keytext_url)
        type_key(t["handle"])
        click_on(t["handle"], "#rm")
        t1["after_filled_then_field_removed"] = snap(z, t["handle"])
        close_tab(z, t["handle"])
        sc["T1_text_field_css_masked"] = t1

        # ---- T2: session store. Does the typed key end up in Zen's saved tab state (sessionstore files)?
        # plain.html is the positive control (plain text field). ----
        plain_url = ext_url(z, D_PROD, "plain.html")
        t2 = {}
        for label, url in (("password_spec", key_url), ("text_masked_autocomplete_off", keytext_url),
                           ("plain_text_control", plain_url)):
            t = fresh(url)
            type_key(t["handle"])
            time.sleep(1)
            r = {"filled": z.chrome(SESSION_JS, [t["handle"], KEY])}
            click_on(t["handle"], "#save")
            time.sleep(1)
            r["state_after_save"] = state(z, t["handle"])
            r["after_save_and_clear"] = z.chrome(SESSION_JS, [t["handle"], KEY])
            close_tab(z, t["handle"])
            t2[label] = r
        sc["T2_session_store"] = t2

        # ---- S1b (last, because it saves a login for the D-prod origin): type, Save, then the user opens the
        # leftover dismissed doorhanger from the address-bar key icon and clicks its main button. ----
        t = fresh(key_url)
        type_key(t["handle"])
        click_on(t["handle"], "#save")
        time.sleep(0.5)
        s1b = {"tab": t, "state_after_save": state(z, t["handle"]), "after_save": snap(z, t["handle"])}
        s1b["reopen_and_save"] = z.chrome(REOPEN_AND_SAVE_JS, [t["handle"], KEY])
        s1b["after"] = snap(z, t["handle"], 1)
        close_tab(z, t["handle"])
        # Side effect worth knowing: a login saved for the extension origin is autofilled into the key field,
        # despite autocomplete=off (signon.autofillForms.autocompleteOff=true).
        t = open_tab(z, key_url)
        time.sleep(1)
        s1b["reopened_key_page_initial_state"] = state(z, t["handle"])
        close_tab(z, t["handle"])
        sc["S1b_spec_save_then_open_leftover_doorhanger_and_save"] = s1b

        out["final_logins"] = z.chrome(SNAPSHOT_JS, [None, KEY]).get("logins")
        out["form_history"] = z.chrome(FORMHISTORY_JS, [KEY])
        out["console_passwordmgr"] = console_messages(z, ["LoginManager", "PasswordManager", "Login"])[-80:]
    finally:
        z.quit()
    path = save_result("D-check11" + ("-headed" if headed else ""), out)
    print("saved", path)


if __name__ == "__main__":
    main()
