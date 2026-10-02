#!/usr/bin/env python3
"""link-server.py <port> <secret>: hands out one fresh onboarding link per GET /<secret>, minted on
demand, because each `vyre up --print-link` replaces the last (three links made at once leave only the
newest valid). CI runners only; it listens on loopback and is reached through a throwaway tunnel."""
import os, subprocess, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
if not os.environ.get("CI"): sys.exit("link-server: runs on a CI runner only")
port, secret = int(sys.argv[1]), sys.argv[2]
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/" + secret:
            self.send_response(404); self.end_headers(); return
        out = subprocess.run(["/usr/local/bin/vyre", "up", "--print-link"], capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout
        link = next((l[len("VYRE_LINK="):] for l in out.splitlines() if l.startswith("VYRE_LINK=")), "")
        self.send_response(200 if link else 500); self.end_headers(); self.wfile.write(link.encode())
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", port), H).serve_forever()
