#!/usr/bin/env node
// The real commands through a sandbox's network: git clone over https, npm ci on a project with a lockfile, pip install into a virtualenv,
// git over ssh (port 22) as far as the tunnel, and the refusals. node scripts/runner-net-real.mjs home|lent   (test box or hosted runner only)
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net"; import { execFileSync } from "node:child_process";
import { createEgress } from "../core/runner/egress.js";
import { planHome } from "../core/runner/homesandbox.js";
import { launch } from "../core/runner/sandbox.js";
import { createRunner } from "../core/runner/runner.js";
import { fakeSpace } from "../core/runner/testing/fake-space.js";

const mode = process.argv[2] || "home";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nr-"));
// a small real project with a lockfile, made outside the sandbox
const proj = path.join(root, "seed"); fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } }));
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: proj, stdio: "ignore" });
const own = Object.values(os.networkInterfaces()).flat().find(a => a && !a.internal && a.family === "IPv4")?.address || "10.255.255.1";
const lan = await new Promise(r => { const s = net.createServer(c => c.end("LAN-SECRET")); s.listen(0, "0.0.0.0", () => r(s)); });
const lanPort = lan.address().port;
const script = `set +e
echo "== git clone https"; git clone -q --depth 1 https://github.com/octocat/Hello-World.git hw 2>&1 | tail -2; ls hw 2>&1 | head -2
echo "== npm ci"; cp seed/package.json seed/package-lock.json . 2>/dev/null; npm ci --no-audit --no-fund 2>&1 | tail -3; node -e "console.log('is-odd installed:', require('is-odd')(3))" 2>&1 | tail -1
echo "== pip install into a virtualenv"; python3 -m venv venv 2>&1 | tail -1; venv/bin/pip install --no-input six==1.16.0 2>&1 | tail -2; venv/bin/python -c "import six; print('six', six.__version__)" 2>&1 | tail -1
echo "== git over ssh (the tunnel on port 22; no key, so a refusal by the host proves it was reached)"
( ssh -o BatchMode=yes -o ConnectTimeout=15 git@github.com 2>&1 || true ) | head -2
echo "== refusals"
python3 - <<'PY'
import urllib.request
for u in ["http://127.0.0.1:1/", "http://10.0.0.1/", "http://${own}:${lanPort}/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fd00::1]/"]:
    try:
        r = urllib.request.urlopen(u, timeout=8); print(u, "REACHED", r.status, r.read(20))
    except Exception as e: print(u, "refused:", str(e)[:50])
PY`;
const work = mode === "lent" ? null : path.join(root, "home", "proj");
async function runHome() {
  const home = path.join(root, "home"); const run = path.join(home, ".vyre/run"); fs.mkdirSync(run, { recursive: true });
  for (const d of ["proj", "t", ".realcfg"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.cpSync(proj, path.join(home, "proj", "seed"), { recursive: true });
  const ownSock = path.join(run, "s.sock"); const sv = net.createServer(c => c.end()); await new Promise(r => sv.listen(ownSock, r));
  let proxy;
  if (process.platform === "linux") { const sock = path.join(home, "egress.sock"); const eg = createEgress({ routes: [], vault: {}, session: "s", token: "tok", internet: true }); await eg.listen({ socket: sock }); proxy = { socket: sock, token: "tok" }; }
  const ro = [path.dirname(process.execPath)].filter(d => !["/usr/bin", "/bin"].includes(d));
  const p = planHome({ platform: process.platform, command: "/bin/sh", args: ["-c", script], home, vyreHome: path.join(home, ".vyre"), sessionSocket: ownSock, workdirs: [path.join(home, "proj")], temp: path.join(home, "t"), readOnly: ro, ...(proxy ? { proxy } : {}), passEnv: [],
    agent: { command: "/bin/sh", hosts: [], private: { from: path.join(home, ".realcfg"), env: "AGENT_CONFIG_DIR", credentialFiles: [] } } });
  const c = launch(p, { cwd: p.cwd }); c.stdout.on("data", d => process.stdout.write(d)); c.stderr.on("data", d => process.stdout.write("ERR " + d));
  await new Promise(r => c.on("close", r));
}
async function runLent() {
  const sp = fakeSpace(); const events = [];
  const r = createRunner({ base: path.join(root, "rn"), space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), watchdog: false, onEvent: e => { if (e.type === "egress" && e.route === "tunnel") events.push(`${e.host}:${e.port} in ${e.bytesIn} out ${e.bytesOut}`); } });
  await r.open();
  fs.cpSync(proj, path.join(r.mnt, "work", "files", "seed"), { recursive: true });
  const h = await r.start({ session: "s1", command: "/bin/sh", args: ["-c", script], readOnly: [path.dirname(process.execPath)].filter(d => !["/usr/bin", "/bin"].includes(d)), routes: [] });
  h.child.stdout.on("data", d => process.stdout.write(d)); h.child.stderr.on("data", d => process.stdout.write("ERR " + d));
  await h.done; console.log("== tunnels logged (destination and byte counts only)\n" + events.slice(0, 8).join("\n"));
  await r.revoke().catch(() => {});
}
console.log(`### ${process.platform} ${mode}`);
await (mode === "lent" ? runLent() : runHome());
lan.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0);
