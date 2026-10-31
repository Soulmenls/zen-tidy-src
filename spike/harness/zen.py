"""M0 spike harness: drive the installed Zen through Marionette with a throwaway profile.

Stdlib only. Never touches the user's real profile; every profile lives under spike/profiles/.
Each session needs its own Marionette port so several can run side by side.

On Windows every Zen this starts runs inside a job object (ZenJob): a hard cap on the committed memory of Zen's whole
process tree (ZEN_MEMORY_MB, 10 GB: what Zen uses with 20+ tabs open, the user's guidance, as for node in
scripts/run-capped.ps1), and the tree is killed when the harness lets go of it, so a crashed harness leaves no Zen
behind. Zen starts suspended and is put in the job before its first instruction, so its launcher and every process
it starts (the browser, content, GPU and utility processes) are in it.

No session starts on a profile inside Zen's own profile folders (refuse_real_profile), a profile is only ever made (and
wiped) strictly inside spike/profiles/ (throwaway_profile), and only such a profile gets an add-on installed for good,
the auto-update prefs (make_update_profile) or the release checks' prefs (make_signed_profile: signature checks on, as
Zen's default). LocalFileServer serves a folder's files on 127.0.0.1 for the local auto-update test (M7) and the release
checks' rehearsal (M8).
"""
import ctypes
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import zipfile

ZEN = r"C:\Program Files\Zen Browser\zen.exe"
SPIKE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILES = os.path.join(SPIKE, "profiles")
TEMPLATE_PREFS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user.js")
# The memory cap for Zen's process tree, in MB (None: no cap).
ZEN_MEMORY_MB = 10240


class ZenJob:
    """A Windows job object for one Zen: JOB_OBJECT_LIMIT_JOB_MEMORY (Windows refuses commits past the cap for the whole
    tree) and KILL_ON_JOB_CLOSE (closing the handle, or the harness dying, ends every process in it)."""

    _JOB_MEMORY = 0x200
    _KILL_ON_CLOSE = 0x2000

    class _Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", ctypes.c_uint32), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_uint32),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_uint32), ("SchedulingClass", ctypes.c_uint32)]

    class _Extended(ctypes.Structure):
        pass

    class _Accounting(ctypes.Structure):
        _fields_ = [("TotalUserTime", ctypes.c_int64), ("TotalKernelTime", ctypes.c_int64),
                    ("ThisPeriodTotalUserTime", ctypes.c_int64), ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                    ("TotalPageFaultCount", ctypes.c_uint32), ("TotalProcesses", ctypes.c_uint32),
                    ("ActiveProcesses", ctypes.c_uint32), ("TotalTerminatedProcesses", ctypes.c_uint32)]

    _Extended._fields_ = [("BasicLimitInformation", _Basic), ("IoInfo", ctypes.c_uint64 * 6),
                          ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                          ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    def __init__(self, memory_mb):
        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k32.CreateJobObjectW.restype = ctypes.c_void_p
        self.handle = self.k32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(f"CreateJobObject failed: {ctypes.get_last_error()}")
        info = self._Extended()
        info.BasicLimitInformation.LimitFlags = self._JOB_MEMORY | self._KILL_ON_CLOSE
        info.JobMemoryLimit = memory_mb * 1024 * 1024
        if not self.k32.SetInformationJobObject(ctypes.c_void_p(self.handle), 9, ctypes.byref(info), ctypes.sizeof(info)):
            error = ctypes.get_last_error()
            self.close()
            raise OSError(f"SetInformationJobObject failed: {error}")
        self.memory_mb = memory_mb

    def start(self, args, env):
        """Popen(args) suspended, put in the job, then resumed: nothing it starts can run outside the job."""
        create_suspended = 0x4
        proc = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                creationflags=create_suspended)
        handle = ctypes.c_void_p(int(proc._handle))
        if not self.k32.AssignProcessToJobObject(ctypes.c_void_p(self.handle), handle):
            error = ctypes.get_last_error()
            proc.kill()
            raise OSError(f"AssignProcessToJobObject failed: {error}")
        if ctypes.WinDLL("ntdll").NtResumeProcess(handle) != 0:
            proc.kill()
            raise OSError("NtResumeProcess failed")
        return proc

    def _query(self, info_class, struct):
        value = struct()
        if not self.k32.QueryInformationJobObject(ctypes.c_void_p(self.handle), info_class, ctypes.byref(value),
                                                  ctypes.sizeof(value), None):
            raise OSError(f"QueryInformationJobObject failed: {ctypes.get_last_error()}")
        return value

    def active(self):
        """How many processes in the job are still running."""
        return self._query(1, self._Accounting).ActiveProcesses

    def total(self):
        """How many processes have ever been in the job (Zen's launcher, browser and child processes)."""
        return self._query(1, self._Accounting).TotalProcesses

    def peak_mb(self):
        """The most memory the whole tree had committed at once, in MB."""
        return self._query(9, self._Extended).PeakJobMemoryUsed / (1024 * 1024)

    def wait_empty(self, timeout):
        """Until no process of the job runs (True), or `timeout` seconds pass (False)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.active() == 0:
                return True
            time.sleep(0.25)
        return self.active() == 0

    def close(self):
        """Closes the job, which ends anything still running in it (KILL_ON_JOB_CLOSE)."""
        if self.handle:
            self.k32.CloseHandle(ctypes.c_void_p(self.handle))
            self.handle = None


class Marionette:
    def __init__(self, port, timeout=600):
        deadline = time.time() + 90
        last = None
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
                break
            except OSError as e:
                last = e
                time.sleep(0.5)
        else:
            raise RuntimeError(f"could not connect to marionette on {port}: {last}")
        self.buf = b""
        self.msgid = 0
        self.hello = self._recv()

    def _recv(self):
        while b":" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("marionette socket closed")
            self.buf += chunk
        n, rest = self.buf.split(b":", 1)
        n = int(n)
        while len(rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("marionette socket closed")
            rest += chunk
        data, self.buf = rest[:n], rest[n:]
        return json.loads(data)

    def send(self, name, params=None):
        self.msgid += 1
        msg = json.dumps([0, self.msgid, name, params or {}]).encode()
        self.sock.sendall(str(len(msg)).encode() + b":" + msg)
        while True:
            resp = self._recv()
            if resp[0] == 1 and resp[1] == self.msgid:
                if resp[2]:
                    raise RuntimeError(json.dumps(resp[2])[:4000])
                return resp[3]

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def real_profile_roots(env=None):
    """Zen's own profile folders on Windows: the profiles under %APPDATA%\\zen and their caches under %LOCALAPPDATA%\\zen
    (env: the environment to read, os.environ by default). With neither variable set, the default %APPDATA% under the
    home folder stands in, so the list is never empty."""
    env = os.environ if env is None else env
    roots = [os.path.join(env[name], "zen") for name in ("APPDATA", "LOCALAPPDATA") if env.get(name)]
    return roots or [os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "zen")]


def _same_folder(a, b):
    """True when `a` and `b` both exist and are the same file (volume and file id), however each is spelled."""
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def _within(path, root, strict=False):
    """True when `path` is `root` or inside it (strict: inside only), compared as real, case-folded paths, so a ..
    segment, / for \\ or another case can't slip past, nor a sibling folder whose name starts the same. realpath keeps
    some spellings as they are (\\\\?\\C:\\..., \\\\localhost\\C$\\...), which that comparison takes for another drive; so
    when `root` exists, `path` is also inside it if `path` or one of its existing parent folders is `root` itself
    (_same_folder), which a folder not made yet below a real profile can't escape either."""
    real_path, real_root = os.path.normcase(os.path.realpath(path)), os.path.normcase(os.path.realpath(root))
    try:
        inside = os.path.commonpath([real_root, real_path]) == real_root
    except ValueError:  # another drive, or a spelling realpath keeps
        inside = False
    is_root = real_path == real_root
    if os.path.isdir(root):
        is_root = is_root or _same_folder(path, root)
        folder = os.path.abspath(path)
        while not inside:
            inside = _same_folder(folder, root)
            parent = os.path.dirname(folder)
            if parent == folder:
                break
            folder = parent
    return inside and not (strict and is_root)


def refuse_real_profile(path, env=None):
    """`path`, unless it is inside one of Zen's own profile folders (real_profile_roots): then a ValueError. The
    harness never starts Zen on, writes to or installs into a profile of the person's."""
    for root in real_profile_roots(env):
        if _within(path, root):
            raise ValueError(f"refusing {path}: it is inside Zen's own profile folder {root}")
    return path


def throwaway_profile(path):
    """`path`, if it is a folder strictly inside spike/profiles/ (PROFILES, read at the call) and none of Zen's own
    (refuse_real_profile); else a ValueError. Only such a profile is made or wiped, gets an add-on installed for good
    (signature checks off) or the auto-update prefs."""
    refuse_real_profile(path)
    if not _within(path, PROFILES, strict=True):
        raise ValueError(f"refusing {path}: a throwaway profile is a folder inside {PROFILES}")
    return path


LOCAL_HOSTS = ("127.0.0.1", "localhost")
_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")


def pac_source(allow_hosts=None, local=True):
    """PAC text: localhost plus the exact hosts in allow_hosts go DIRECT, everything else to a dead proxy. local=False
    leaves localhost out (the release's update check lets through only GitHub's hosts); with no host at all, everything
    goes to the dead proxy.

    Hosts are matched exactly (no subdomains). Each must be a plain lower-case DNS name, so nothing can
    break out of the generated string literal."""
    hosts = list(LOCAL_HOSTS) if local else []
    for host in allow_hosts or ():
        if not isinstance(host, str) or not _HOST_RE.match(host):
            raise ValueError(f"not a plain host name: {host!r}")
        if host not in hosts:
            hosts.append(host)
    cond = " || ".join(f'host == "{h}"' for h in hosts)
    direct = f'  if ({cond}) return "DIRECT";\n' if hosts else ""
    return ('function FindProxyForURL(url, host) {\n'
            f'{direct}'
            '  return "PROXY 127.0.0.1:9";\n}\n')


_PREF_LINE_RE = re.compile(r'^\s*user_pref\(\s*"([^"]+)"')


def template_prefs(omit=()):
    """The template prefs' text without the lines that set the prefs named in `omit`. A name the template doesn't set is
    an error, so a typo can't leave a pref on unnoticed."""
    with open(TEMPLATE_PREFS, encoding="utf-8") as f:
        lines = f.read().splitlines(keepends=True)
    names = [m.group(1) if m else None for m in (_PREF_LINE_RE.match(line) for line in lines)]
    unknown = sorted(set(omit) - set(names))
    if unknown:
        raise ValueError(f"the template prefs set no {', '.join(unknown)}")
    return "".join(line for line, name in zip(lines, names) if name not in omit)


def make_profile(name, port, extra_prefs=None, user_chrome_css=None, fresh=True, allow_hosts=None):
    """Create spike/profiles/<name> from the template prefs. Returns the profile path.

    allow_hosts: extra exact host names the PAC lets through (default: localhost only)."""
    return make_profile_without((), name, port, extra_prefs, user_chrome_css, fresh, allow_hosts)


def make_profile_without(omit_prefs, name, port, extra_prefs=None, user_chrome_css=None, fresh=True, allow_hosts=None,
                         local_hosts=True):
    """make_profile, with the template prefs named in omit_prefs left at Zen's default (template_prefs). The profile must
    land strictly inside spike/profiles/ (throwaway_profile), checked before anything is wiped or written. local_hosts:
    False leaves localhost out of the PAC (pac_source's local)."""
    prof = throwaway_profile(os.path.join(PROFILES, name))
    if fresh and os.path.exists(prof):
        shutil.rmtree(prof)
    os.makedirs(prof, exist_ok=True)
    pac = os.path.join(prof, "block.pac")
    with open(pac, "w", encoding="utf-8") as f:
        # Only localhost (and allow_hosts) is reachable; everything else goes to a dead proxy.
        f.write(pac_source(allow_hosts, local=local_hosts))
    prefs = template_prefs(omit_prefs)
    prefs += f'user_pref("marionette.port", {port});\n'
    prefs += 'user_pref("network.proxy.type", 2);\n'
    prefs += f'user_pref("network.proxy.autoconfig_url", "file:///{pac.replace(os.sep, "/")}");\n'
    for key, value in (extra_prefs or {}).items():
        prefs += f"user_pref({json.dumps(key)}, {json.dumps(value)});\n"
    with open(os.path.join(prof, "user.js"), "w", encoding="utf-8") as f:
        f.write(prefs)
    if user_chrome_css is not None:
        os.makedirs(os.path.join(prof, "chrome"), exist_ok=True)
        with open(os.path.join(prof, "chrome", "userChrome.css"), "w", encoding="utf-8") as f:
            f.write(user_chrome_css)
    return prof


# The local auto-update test's prefs (notes/m7-contracts.md, "Local auto-update test"; the M7 spike on Zen 1.24b). Throwaway
# profile only: make_update_profile writes them nowhere else. The template turns add-on update checks off, so that line
# is left out (UPDATE_TEST_OMIT). An http:// update_url needs extensions.checkUpdateSecurity off: at Zen's default (on)
# such an add-on installs disabled and stays so. The daily add-on timer's last run is pinned to the profile's creation:
# unset, it counts as 0 and a fresh profile checks on its own about 30 s after the first start, racing the test's own
# trigger. Signature checks stay off as in the template, so the unsigned build installs for good. update_hash is checked
# whatever these say; extensions.install.requireSecureOrigin and the requireBuiltInCerts prefs don't apply to these
# http requests and keep Zen's defaults.
UPDATE_TEST_OMIT = ("extensions.update.enabled",)
UPDATE_TIMER_PREF = "app.update.lastUpdateTime.addon-background-update-timer"


def update_test_prefs(now=None):
    """The prefs make_update_profile adds to the template: `now` (epoch seconds, the clock by default) pins the add-on
    timer's last run."""
    return {"xpinstall.signatures.required": False, "extensions.checkUpdateSecurity": False,
            UPDATE_TIMER_PREF: int(time.time() if now is None else now), "extensions.logging.enabled": True}


def make_update_profile(name, port, extra_prefs=None, fresh=True, allow_hosts=None):
    """make_profile_without(UPDATE_TEST_OMIT) with update_test_prefs (then extra_prefs): a throwaway profile under
    spike/profiles/ (throwaway_profile) whose add-ons update from a local http server."""
    return make_profile_without(UPDATE_TEST_OMIT, name, port, {**update_test_prefs(), **(extra_prefs or {})}, fresh=fresh,
                                allow_hosts=allow_hosts)


# The release checks' prefs (notes/m8-contracts.md, "C. Release checks harness"). Throwaway profile only:
# make_signed_profile writes them nowhere else. Signature checks are ON, as Zen's own default in the person's profile
# (browser/omni.ja defaults/preferences/firefox.js; Zen is built without MOZ_REQUIRE_SIGNING, so this pref decides), so
# only a build Mozilla signed installs; the template turns them off for the unsigned spike builds, so that line is left
# out and written true (SIGNED_TEST_OMIT). extensions.checkUpdateSecurity is never written: it stays at Zen's default
# (on), as in the person's profile, and extra_prefs may set neither of the two (SIGNED_TEST_LOCKED). update_checks turns
# add-on update checks on (the template's off line left out, written true) and pins the daily add-on timer's last run to
# the profile's creation as make_update_profile does, so the only update check is the harness's own. Logging on: the add-on
# manager's debug lines reach the browser console, where a failed check reads them.
SIGNED_TEST_OMIT = ("xpinstall.signatures.required",)
SIGNED_TEST_LOCKED = ("xpinstall.signatures.required", "extensions.checkUpdateSecurity")


def signed_test_prefs(update_checks=False, now=None):
    """The prefs make_signed_profile adds to the template: with update_checks, add-on updates on and `now` (epoch seconds,
    the clock by default) pinning the add-on timer's last run."""
    prefs = {"xpinstall.signatures.required": True, "extensions.logging.enabled": True}
    if update_checks:
        prefs.update({"extensions.update.enabled": True, UPDATE_TIMER_PREF: int(time.time() if now is None else now)})
    return prefs


def make_signed_profile(name, port, extra_prefs=None, fresh=True, allow_hosts=None, update_checks=False, local_hosts=True):
    """make_profile_without(SIGNED_TEST_OMIT, and UPDATE_TEST_OMIT with update_checks) with signed_test_prefs (then
    extra_prefs): a throwaway profile under spike/profiles/ (throwaway_profile) that installs only signed add-ons, as the
    person's own does. extra_prefs naming a SIGNED_TEST_LOCKED pref is a ValueError, before anything is written."""
    locked = sorted(set(extra_prefs or {}) & set(SIGNED_TEST_LOCKED))
    if locked:
        raise ValueError(f"a signed-checks profile keeps {', '.join(locked)} as Zen's own profile has it")
    omit = SIGNED_TEST_OMIT + (UPDATE_TEST_OMIT if update_checks else ())
    return make_profile_without(omit, name, port, {**signed_test_prefs(update_checks), **(extra_prefs or {})}, fresh=fresh,
                                allow_hosts=allow_hosts, local_hosts=local_hosts)


class LocalFileServer:
    """The files directly inside `root` on http://127.0.0.1:<port>/<name>, for the local auto-update test: GET and HEAD,
    never cached (Cache-Control: no-store), .json as application/json and .xpi as application/x-xpinstall. A name that
    isn't a plain file name in `root` (a folder, a dotfile, any / or ..) is a 404, any other method a 405. Bound to
    127.0.0.1 only; port 0 picks a free port (`port` then holds it). `take()` hands over the requests logged since the
    last call: method, path, status and time."""

    TYPES = {".json": "application/json", ".xpi": "application/x-xpinstall"}
    _NAME_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*$")

    def __init__(self, root, port=0):
        self.root = os.path.realpath(root)
        self._log = []
        self._lock = threading.Lock()
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self, body):
                name = self.path.split("?", 1)[0].lstrip("/")
                full = os.path.join(server.root, name)
                if not server._NAME_RE.match(name) or not os.path.isfile(full):
                    status, data, ctype = 404, b"", "text/plain"
                else:
                    with open(full, "rb") as f:
                        data = f.read()
                    status, ctype = 200, server.TYPES.get(os.path.splitext(name)[1], "application/octet-stream")
                # Logged before the answer goes out, so a client that has its answer finds the request in take().
                server._record(self.command, self.path, status)
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if body:
                    self.wfile.write(data)

            def do_GET(self):
                self._answer(True)

            def do_HEAD(self):
                self._answer(False)

            def _refuse(self):
                server._record(self.command, self.path, 405)
                self.send_response(405)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_POST = do_PUT = do_DELETE = do_OPTIONS = do_PATCH = _refuse

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.port = self.httpd.server_address[1]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def _record(self, method, path, status):
        with self._lock:
            self._log.append({"t": round(time.time(), 3), "method": method, "path": path, "status": status})

    def url(self, name=""):
        return f"http://127.0.0.1:{self.port}/{name}"

    def start(self):
        self._thread.start()
        return self

    def take(self):
        with self._lock:
            out, self._log = self._log, []
        return out

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()


def build_xpi(src_dir, out_path, manifest_overrides=None):
    """Zip an extension folder into an .xpi, optionally overriding manifest keys."""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(src_dir):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, src_dir).replace(os.sep, "/")
                if rel == "manifest.json" and manifest_overrides:
                    with open(full, encoding="utf-8") as f:
                        manifest = json.load(f)
                    manifest.update(manifest_overrides)
                    z.writestr(rel, json.dumps(manifest, indent=2))
                else:
                    z.write(full, rel)
    return out_path


class ZenSession:
    """One running Zen instance on one throwaway profile. memory_mb: the cap on its process tree's committed memory
    (ZenJob, Windows only; None: no cap). After a launch, `job` holds the job (None without one); `peaks` collects each
    launch's peak memory in MB as it quits. before_launch: called with the session at the start of every launch, while
    Zen is not running on the profile (in a restart, after the quit), to change the profile's files; settable any time,
    and an exception from it stops the launch before Zen starts. A profile inside Zen's own profile folders is refused
    (refuse_real_profile)."""

    def __init__(self, profile, port, headless=True, memory_mb=ZEN_MEMORY_MB, before_launch=None):
        self.profile = refuse_real_profile(profile)
        self.port = port
        self.headless = headless
        self.memory_mb = memory_mb if sys.platform == "win32" else None
        self.before_launch = before_launch
        self.proc = None
        self.job = None
        self.peaks = []
        self.m = None

    def launch(self):
        if self.before_launch:
            self.before_launch(self)
        args = [ZEN, "-no-remote", "-profile", self.profile, "-marionette", "-remote-allow-system-access"]
        if self.headless:
            args.append("-headless")
        env = dict(os.environ)
        env["MOZ_CRASHREPORTER_DISABLE"] = "1"
        # Zen 1.24b (Firefox 159) refuses Marionette's chrome context ("System access is required") unless this is set
        # too; the flag alone was enough up to Zen 1.23.4b. Only this Zen's environment, never the harness's own.
        env["MOZ_REMOTE_ALLOW_SYSTEM_ACCESS"] = "1"
        if self.memory_mb:
            self.job = ZenJob(self.memory_mb)
            self.proc = self.job.start(args, env)
        else:
            self.proc = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.m = Marionette(self.port)
        self.m.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
        self.m.send("WebDriver:SetTimeouts", {"script": 600000})
        self.wait_for_startup()
        return self

    def wait_for_startup(self):
        self.chrome("""
            const done = arguments[arguments.length - 1];
            (async () => {
              const win = Services.wm.getMostRecentWindow("navigator:browser");
              await win.delayedStartupPromise;
              if (win.gZenWorkspaces?.promiseInitialized) await win.gZenWorkspaces.promiseInitialized;
              await new Promise(r => win.setTimeout(r, 1500));
              done(true);
            })();
        """)

    def chrome(self, js, args=None):
        """Run an async script in the browser window's chrome scope. The script must call the last argument."""
        self.m.send("Marionette:SetContext", {"value": "chrome"})
        handles = self.m.send("WebDriver:GetWindowHandles")
        handles = handles.get("value", handles) if isinstance(handles, dict) else handles
        self.m.send("WebDriver:SwitchToWindow", {"handle": handles[0], "focus": False})
        r = self.m.send("WebDriver:ExecuteAsyncScript", {"script": js, "args": args or []})
        return r.get("value") if isinstance(r, dict) else r

    def install_addon(self, xpi_path, temporary=False):
        """Install an xpi through Marionette (Addon:Install). For good (temporary=False: AddonManager.getInstallForFile,
        as about:addons' Install Add-on From File, without the prompt) only into a throwaway profile (throwaway_profile):
        an unsigned build needs signature checks off, which only those profiles have (a make_signed_profile one keeps
        them on, so only a signed build installs there)."""
        if not temporary:
            throwaway_profile(self.profile)
        r = self.m.send("Addon:Install", {"path": os.path.abspath(xpi_path), "temporary": temporary})
        return r.get("value") if isinstance(r, dict) else r

    def open_ext_page(self, addon_id, page="spike.html", pin=True):
        """Open an extension page in a (pinned) tab and return its content window handle."""
        return self.chrome("""
            const [addonId, page, pin, done] = arguments;
            (async () => {
              const win = Services.wm.getMostRecentWindow("navigator:browser");
              const policy = WebExtensionPolicy.getByID(addonId);
              if (!policy) return done({error: "addon not found"});
              const url = policy.getURL(page);
              // A spike tab restored from the last session is unloaded; replace it with a live one.
              for (const old of win.gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec === url)) {
                const loaded = old.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec === url;
                if (!loaded) win.gBrowser.removeTab(old, { animate: false });
              }
              let tab = win.gBrowser.tabs.find(t =>
                t.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec === url);
              if (!tab) {
                tab = win.gBrowser.addTab(url, {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                });
                if (pin) win.gBrowser.pinTab(tab);
              }
              const browser = tab.linkedBrowser;
              for (let i = 0; i < 100 && (browser.browsingContext?.currentWindowGlobal?.documentURI?.spec !== url
                   || browser.webProgress?.isLoadingDocument); i++) {
                await new Promise(r => win.setTimeout(r, 100));
              }
              await new Promise(r => win.setTimeout(r, 300));
              const { NavigableManager } = ChromeUtils.importESModule(
                "chrome://remote/content/shared/NavigableManager.sys.mjs");
              done({handle: NavigableManager.getIdForBrowser(browser), url});
            })();
        """, [addon_id, page, pin])

    def ext(self, handle, command, args=None):
        """Run a command in the spike extension page (window.spike.run) and return its parsed result."""
        self.m.send("Marionette:SetContext", {"value": "content"})
        self.m.send("WebDriver:SwitchToWindow", {"handle": handle, "focus": False})
        r = self.m.send("WebDriver:ExecuteAsyncScript", {"script": """
            const [command, argsJson, done] = arguments;
            (window.wrappedJSObject || window).spike.run(command, argsJson)
              .then(done, e => done(JSON.stringify({error: String(e)})));
        """, "args": [command, json.dumps(args if args is not None else [])]})
        value = r.get("value") if isinstance(r, dict) else r
        self.m.send("Marionette:SetContext", {"value": "chrome"})
        return json.loads(value) if isinstance(value, str) else value

    def quit(self, timeout=60):
        """Normal quit so the session is saved, then wait for the process tree to exit."""
        if self.m:
            try:
                self.m.send("Marionette:Quit", {"flags": ["eAttemptQuit"]})
            except Exception:
                pass
            self.m.close()
            self.m = None
        if self.proc:
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # Only ever kill the process tree this harness launched.
                subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.proc = None
        if self.job:
            # The process started may be only Zen's launcher: the job knows when the whole tree has exited (the session
            # saved). Whatever still runs after the timeout ends with the job.
            try:
                self.job.wait_empty(timeout)
                self.peaks.append(round(self.job.peak_mb()))
            except OSError:
                pass
            self.job.close()
            self.job = None
        time.sleep(2)

    def restart(self):
        self.quit()
        return self.launch()


def save_result(name, data):
    out = os.path.join(SPIKE, "results", name + ".json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    return out
