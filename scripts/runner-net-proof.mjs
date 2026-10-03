#!/usr/bin/env node
// A real-network proof of the internet mode on Linux: a session in the home sandbox clones a public repo over https and fetches over https and
// http, all through the runner's proxy; and cannot reach loopback, the LAN or a private address. node scripts/runner-net-proof.mjs  (test box only)
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net";
import { createEgress } from "../core/runner/egress.js";
import { planHome } from "../core/runner/homesandbox.js";
import { launch } from "../core/runner/sandbox.js";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "np-")); const run = path.join(home, ".vyre/run"); fs.mkdirSync(run, { recursive: true });
for (const d of ["proj", "t", ".realcfg"]) fs.mkdirSync(path.join(home, d), { recursive: true });
const own = path.join(run, "s.sock"); const sv = net.createServer(c => c.end()); await new Promise(r => sv.listen(own, r));
const sock = path.join(home, "egress.sock"); const eg = createEgress({ routes: [], vault: {}, session: "s", token: "tok", internet: true }); await eg.listen({ socket: sock });
const priv = net.createServer(c => c.end("SECRET")); await new Promise(r => priv.listen(0, "127.0.0.1", r));
const script = `
set -u
cd /home-proj 2>/dev/null || cd "$PWD"
echo "== git clone https"; git clone -q --depth 1 https://github.com/octocat/Hello-World.git hw 2>&1 | tail -2; ls hw | head -3
echo "== python https"; python3 - <<'PY'
import urllib.request, os
for u in ["https://pypi.org/simple/pip/", "http://example.com/"]:
    try:
        r = urllib.request.urlopen(u, timeout=15); print(u, r.status)
    except Exception as e: print(u, "FAIL", e)
for u in ["http://127.0.0.1:${priv.address().port}/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/"]:
    try:
        r = urllib.request.urlopen(u, timeout=8); print(u, "REACHED", r.status)
    except Exception as e: print(u, "refused:", str(e)[:60])
PY`;
const wd = path.join(home, "proj");
const p = planHome({ platform: "linux", command: "/bin/sh", args: ["-c", script], home, vyreHome: path.join(home, ".vyre"), sessionSocket: own, workdirs: [wd], temp: path.join(home, "t"), readOnly: [], proxy: { socket: sock, token: "tok" },
  agent: { command: "/bin/sh", hosts: [], private: { from: path.join(home, ".realcfg"), env: "AGENT_CONFIG_DIR", credentialFiles: [] } } });
const c = launch(p, { cwd: p.cwd }); c.stdout.on("data", d => process.stdout.write(d)); c.stderr.on("data", d => process.stdout.write("ERR " + d));
await new Promise(r => c.on("close", r)); process.exit(0);
