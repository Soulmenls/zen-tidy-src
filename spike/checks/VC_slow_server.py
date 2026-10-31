"""Group C, check 6 helper: a slow HTTP server on 127.0.0.1 that logs what the client does.

GET /slow?delay=<seconds>&label=<text> answers after <delay> seconds (default --delay).
Every request is logged as JSON lines: request.start, then exactly one of
request.client_disconnected (the client closed or reset the socket before the answer),
request.responded, or request.write_failed.

Run it as its own process; the check script starts it and stops it by PID.
Stdlib only. Binds to 127.0.0.1 only.
"""
import argparse
import itertools
import json
import os
import select
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LOCK = threading.Lock()
COUNTER = itertools.count(1)
ARGS = None


def log(**entry):
    entry = {"t": time.time(), **entry}
    with LOCK:
        with open(ARGS.log, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0: one request per connection, so any later readability means FIN or RST.
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def do_OPTIONS(self):
        rid = next(COUNTER)
        log(event="request.options", id=rid, path=self.path)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        rid = next(COUNTER)
        url = urlparse(self.path)
        q = parse_qs(url.query)
        label = q.get("label", [""])[0]
        try:
            delay = float(q.get("delay", [ARGS.delay])[0])
        except ValueError:
            delay = ARGS.delay
        start = time.time()
        log(event="request.start", id=rid, label=label, path=self.path, delay=delay,
            peer=list(self.client_address), origin=self.headers.get("Origin"),
            user_agent=self.headers.get("User-Agent"))
        sock = self.connection
        disconnected = None
        while time.time() - start < delay:
            readable, _, errored = select.select([sock], [], [sock], 0.25)
            if readable or errored:
                try:
                    peek = sock.recv(1, socket.MSG_PEEK)
                except (ConnectionResetError, ConnectionAbortedError) as e:
                    disconnected = type(e).__name__
                    break
                except OSError as e:
                    disconnected = f"OSError:{e.errno}"
                    break
                if peek == b"":
                    disconnected = "FIN"
                    break
                time.sleep(0.25)  # unexpected extra bytes; keep waiting
        if disconnected:
            log(event="request.client_disconnected", id=rid, label=label, how=disconnected,
                after_s=round(time.time() - start, 3))
            return
        body = json.dumps({"label": label, "delay": delay, "id": rid}).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            log(event="request.responded", id=rid, label=label, after_s=round(time.time() - start, 3))
        except OSError as e:
            log(event="request.write_failed", id=rid, label=label, error=repr(e),
                after_s=round(time.time() - start, 3))


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--delay", type=float, default=70.0)
    p.add_argument("--log", required=True)
    p.add_argument("--portfile", required=True)
    p.add_argument("--max-seconds", type=float, default=1800.0, help="exit on its own after this long")
    ARGS = p.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    log(event="server.start", port=port, pid=os.getpid(), default_delay=ARGS.delay)
    with open(ARGS.portfile, "w", encoding="utf-8") as f:
        f.write(str(port))

    def stop_later():
        time.sleep(ARGS.max_seconds)
        log(event="server.max_seconds_reached")
        os._exit(0)

    threading.Thread(target=stop_later, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        log(event="server.stop")


if __name__ == "__main__":
    sys.exit(main())
