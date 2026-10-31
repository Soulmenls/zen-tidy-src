"""Debug: how does Marionette name content tabs (incl. extension pages)?"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile  # noqa: E402

PORT = 2942
xpi = build_xpi(os.path.join(SPIKE, "ext"), os.path.join(SPIKE, "profiles", "_xpi", "spike-dbg.xpi"))
prof = make_profile("dbg", PORT)
z = ZenSession(prof, PORT).launch()
try:
    z.install_addon(xpi)
    print("page", z.open_ext_page("zen-tidy-spike@local"))
    print(json.dumps(z.chrome("""
      const done = arguments[arguments.length - 1];
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const out = {};
      try {
        const { TabManager } = ChromeUtils.importESModule("chrome://remote/content/shared/TabManager.sys.mjs");
        out.tabs = win.gBrowser.tabs.map(t => ({
          url: t.linkedBrowser.currentURI.spec,
          id: TabManager.getIdForBrowser(t.linkedBrowser),
          bid: t.linkedBrowser.browsingContext?.browserId,
          remoteType: t.linkedBrowser.remoteType,
        }));
      } catch (e) { out.err = String(e); }
      done(out);
    """), indent=1))
    z.m.send("Marionette:SetContext", {"value": "content"})
    print("content handles", z.m.send("WebDriver:GetWindowHandles"))
finally:
    z.quit()
