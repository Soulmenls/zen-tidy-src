"""VD (adversarial verifier for group D) copy of D_common.py. Changes: redirect endpoint in LocalServer,
Mozilla service hosts pinned to 127.0.0.1 so a DIRECT failover cannot leave the machine.

Original docstring: Group D shared helpers: local recording HTTP server, local sink proxy, profile with a sink PAC,
Marionette content-context helpers and chrome-scope inspectors.

Throwaway experiment code for M0 checks 9, 10, 11. Everything binds to 127.0.0.1 only.
"""
import base64
import hashlib
import json
import os
import socket
import socketserver
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import PROFILES, SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402,F401

PNG_1x1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


class _Recorder:
    def __init__(self):
        self.lock = threading.Lock()
        self.events = []

    def add(self, ev):
        with self.lock:
            ev["t"] = round(time.time(), 3)
            self.events.append(ev)

    def snapshot(self):
        with self.lock:
            return list(self.events)

    def clear(self):
        with self.lock:
            self.events.clear()


def _read_head(sock, limit=65536, timeout=5):
    sock.settimeout(timeout)
    data = b""
    try:
        while b"\r\n\r\n" not in data and len(data) < limit:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    except OSError:
        pass
    return data


class LocalServer:
    """Records every TCP connection (even non-HTTP bytes such as a TLS ClientHello).
    Answers HTTP with 200 + CORS, WebSocket upgrades with a valid handshake, /img.png with a PNG."""

    def __init__(self, host="127.0.0.1"):
        rec = self.rec = _Recorder()

        class H(socketserver.BaseRequestHandler):
            def handle(self):
                head = _read_head(self.request)
                first = head.split(b"\r\n", 1)[0]
                headers = {}
                for line in head.split(b"\r\n")[1:]:
                    if b":" in line:
                        k, v = line.split(b":", 1)
                        headers[k.decode("latin1").strip().lower()] = v.decode("latin1").strip()
                printable = first.decode("latin1") if first[:1].isalpha() else "<non-http bytes %s>" % first[:8].hex()
                rec.add({"peer": self.client_address[1], "first_line": printable,
                         "origin": headers.get("origin"), "upgrade": headers.get("upgrade"),
                         "ua_has_firefox": "Firefox" in headers.get("user-agent", "")})
                try:
                    if headers.get("upgrade", "").lower() == "websocket":
                        key = headers.get("sec-websocket-key", "")
                        acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                        self.request.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                                              "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % acc).encode())
                        time.sleep(1.5)
                        return
                    if b" /redir?to=" in first:
                        import urllib.parse
                        target = urllib.parse.unquote(first.split(b" ")[1].split(b"?to=", 1)[1].decode("latin1"))
                        self.request.sendall(("HTTP/1.1 302 Found\r\nLocation: %s\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n" % target).encode())
                        return
                    if b" /img.png" in first:
                        body, ctype = PNG_1x1, "image/png"
                    else:
                        body, ctype = b"hello-from-local-server", "text/plain"
                    self.request.sendall(("HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
                                          "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n"
                                          "Connection: close\r\n\r\n" % (ctype, len(body))).encode() + body)
                except OSError:
                    pass

        class S(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        assert host.startswith("127."), "loopback only"
        self.srv = S((host, 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()


class SinkProxy:
    """A local HTTP proxy that never forwards anything. It records the request line (e.g.
    'CONNECT api.anthropic.com:443') and answers 403. Lets us tell 'blocked by CSP before the
    network' (no proxy hit) from 'reached the network layer' (proxy hit)."""

    def __init__(self):
        rec = self.rec = _Recorder()

        class H(socketserver.BaseRequestHandler):
            def handle(self):
                head = _read_head(self.request)
                first = head.split(b"\r\n", 1)[0].decode("latin1", "replace")
                rec.add({"first_line": first})
                try:
                    self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                except OSError:
                    pass

        class S(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.srv = S(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def hosts(self):
        return [e["first_line"] for e in self.rec.snapshot()]

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()


def make_d_profile(name, port, sink_port=None, extra_prefs=None):
    """make_profile, then (optionally) point the PAC at the local sink proxy instead of the dead port 9.
    Still only 127.0.0.1/localhost go DIRECT; nothing is ever forwarded off the machine."""
    prefs = {"network.proxy.failover_direct": False}
    prefs.update(extra_prefs or {})
    prefs["network.dns.localDomains"] = ",".join(filter(None, [prefs.get("network.dns.localDomains"), MOZ_HOSTS]))
    prof = make_profile(name, port, extra_prefs=prefs)
    if sink_port:
        pac = os.path.join(prof, "sink.pac")
        with open(pac, "w", encoding="utf-8") as f:
            f.write('function FindProxyForURL(url, host) {\n'
                    '  if (host == "127.0.0.1" || host == "localhost") return "DIRECT";\n'
                    f'  return "PROXY 127.0.0.1:{sink_port}";\n}}\n')
        with open(os.path.join(prof, "user.js"), "a", encoding="utf-8") as f:
            f.write(f'user_pref("network.proxy.autoconfig_url", "file:///{pac.replace(os.sep, "/")}");\n')
    return prof


# Hosts the throwaway profiles were seen contacting (and a few more). Pinned to 127.0.0.1 so neither DNS nor a
# DIRECT failover of a conservative request can reach them.
MOZ_HOSTS = ",".join([
    "firefox.settings.services.mozilla.com", "firefox-settings-attachments.cdn.mozilla.net", "aus5.mozilla.org",
    "content-signature-2.cdn.mozilla.net", "push.services.mozilla.com", "location.services.mozilla.com",
    "incoming.telemetry.mozilla.org", "detectportal.firefox.com", "normandy.cdn.mozilla.net",
    "shavar.services.mozilla.com", "tracking-protection.cdn.mozilla.net", "services.addons.mozilla.org",
    "versioncheck.addons.mozilla.org", "addons.mozilla.org", "updates.zen-browser.app", "zen-browser.app",
    "classify-client.services.mozilla.com", "safebrowsing.googleapis.com", "spocs.getpocket.com",
    "update.googleapis.com", "ciscobinary.openh264.org", "edgedl.me.gvt1.com", "www.google.com",
    "redirector.gvt1.com", "dl.google.com", "contile.services.mozilla.com", "merino.services.mozilla.com",
])


# ---------- chrome-scope helpers ----------

OPEN_TAB_JS = """
const [url, done] = arguments;
(async () => {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const tab = win.gBrowser.addTab(url, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  win.gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  for (let i = 0; i < 100 && (browser.browsingContext?.currentWindowGlobal?.documentURI?.spec !== url
       || browser.webProgress?.isLoadingDocument); i++) {
    await new Promise(r => win.setTimeout(r, 100));
  }
  await new Promise(r => win.setTimeout(r, 500));
  const { NavigableManager } = ChromeUtils.importESModule(
    "chrome://remote/content/shared/NavigableManager.sys.mjs");
  done({handle: NavigableManager.getIdForBrowser(browser), url,
        docURI: browser.browsingContext?.currentWindowGlobal?.documentURI?.spec});
})();
"""

CONSOLE_JS = """
const [needles, done] = arguments;
const out = [];
for (const m of Services.console.getMessageArray() || []) {
  let text, extra = {};
  if (m instanceof Ci.nsIScriptError) {
    text = m.errorMessage;
    extra = {category: m.category, flags: m.flags, source: m.sourceName, inner: m.innerWindowID};
  } else {
    text = m.message;
  }
  if (!needles.length || needles.some(n => String(text).includes(n))) out.push({text: String(text).slice(0, 600), ...extra});
}
done(out);
"""


def open_tab(z, url):
    return z.chrome(OPEN_TAB_JS, [url])


def console_messages(z, needles):
    return z.chrome(CONSOLE_JS, [needles])


def ext_url(z, addon_id, page):
    return z.chrome("""
        const [id, page, done] = arguments;
        const p = WebExtensionPolicy.getByID(id);
        done(p ? p.getURL(page) : null);
    """, [addon_id, page])


# ---------- content-context helpers (Marionette WebDriver commands) ----------

def to_content(z, handle):
    z.m.send("Marionette:SetContext", {"value": "content"})
    z.m.send("WebDriver:SwitchToWindow", {"handle": handle, "focus": True})


def find(z, css):
    r = z.m.send("WebDriver:FindElement", {"using": "css selector", "value": css})
    ref = r.get("value", r)
    return list(ref.values())[0]


def send_keys(z, el, text):
    z.m.send("WebDriver:ElementSendKeys", {"id": el, "text": text})


def click(z, el):
    z.m.send("WebDriver:ElementClick", {"id": el})


def content_js(z, js, args=None):
    r = z.m.send("WebDriver:ExecuteScript", {"script": js, "args": args or []})
    return r.get("value") if isinstance(r, dict) else r


def back_to_chrome(z):
    z.m.send("Marionette:SetContext", {"value": "chrome"})


def dump(obj):
    return json.dumps(obj, indent=1, ensure_ascii=False)
