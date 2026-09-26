// @ts-check
// The computer's tailnet side against a fake tailscale/tailscaled pair: small node scripts that
// keep their state in a file beside the "socket" and write down every argv they were given. No
// network, no real Tailscale.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTailnet } from "./tailnet.js";
import { tempHome } from "../../../../test/helpers.js";

const KEY = "tskey-auth-kFAKE0CNTRL-0123456789abcdef";

/** The fake pair in a temp home, and where they log. */
function fakes(t, { upFails = false } = {}) {
  const root = tempHome(t);
  const log = path.join(root, "argv.log");
  const seen = path.join(root, "seen.json");
  const socketOf = `const sock = (process.argv.find(a => a.startsWith("--socket=")) || "").slice(9);`;
  const tailscaled = path.join(root, "tailscaled");
  fs.writeFileSync(tailscaled, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(["tailscaled", ...process.argv.slice(2), "env:" + Object.keys(process.env).filter(k => !k.startsWith("__CF_")).sort().join(",")]) + "\\n");
${socketOf}
fs.writeFileSync(sock, JSON.stringify({ BackendState: "NeedsLogin" }));
setInterval(() => {}, 1 << 30);
`);
  const tailscale = path.join(root, "tailscale");
  fs.writeFileSync(tailscale, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(["tailscale", ...args]) + "\\n");
${socketOf}
let st; try { st = JSON.parse(fs.readFileSync(sock, "utf8")); } catch { process.stderr.write("failed to connect to local tailscaled"); process.exit(1); }
const cmd = args[1];
if (cmd === "status") { process.stdout.write(JSON.stringify(st)); process.exit(0); }
if (cmd === "up") {
  const file = args.find(a => a.startsWith("--auth-key=file:")).slice("--auth-key=file:".length);
  const s = fs.statSync(file);
  const dir = fs.statSync(require("node:path").dirname(file));
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ key: fs.readFileSync(file, "utf8"), mode: s.mode & 0o777, dirMode: dir.mode & 0o777 }));
  if (${upFails}) { process.stderr.write("backend error: invalid key: " + fs.readFileSync(file, "utf8")); process.exit(1); }
  const host = args.find(a => a.startsWith("--hostname=")).slice(11);
  fs.writeFileSync(sock, JSON.stringify({ BackendState: "Running", Self: { ID: "nKit7CNTRL", DNSName: host + ".tail0000.ts.net.", HostName: host, Tags: ["tag:vyre-agent"] } }));
  process.exit(0);
}
if (cmd === "logout") { fs.writeFileSync(sock, JSON.stringify({ BackendState: "NeedsLogin" })); process.exit(0); }
process.exit(2);
`);
  fs.chmodSync(tailscaled, 0o755);
  fs.chmodSync(tailscale, 0o755);
  const dir = path.join(root, "run");
  const argv = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  return { root, dir, tailscale, tailscaled, argv, seen: () => JSON.parse(fs.readFileSync(seen, "utf8")), logText: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}

function side(t, f, uid = 0) {
  // "Root" here is the test's own uid, so the folder it makes is owned by root as far as this knows.
  const me = /** @type {number} */ (process.getuid && process.getuid());
  const tn = createTailnet({ tailscale: f.tailscale, tailscaled: f.tailscaled, dir: f.dir, root: me, uid: () => uid === 0 ? me : uid });
  t.after(() => tn.stop());
  return tn;
}

test("computerd tailnet: up starts a userspace tailscaled, hands the key over a 0600 file it deletes, and says the node", async t => {
  const f = fakes(t);
  const tn = side(t, f);
  assert.deepEqual((await tn.handle("GET", "/tailnet")).body, { ready: true, running: false });
  const r = await tn.handle("POST", "/tailnet/up", { authKey: KEY, hostname: "vyre-agent-kit", tag: "tag:vyre-agent" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { stableId: "nKit7CNTRL", node: "vyre-agent-kit.tail0000.ts.net" });
  const [daemon] = f.argv().filter(a => a[0] === "tailscaled");
  assert.deepEqual(daemon.slice(1, 6), ["--tun=userspace-networking", "--state=mem:", `--socket=${path.join(f.dir, "tailscaled.sock")}`, "--socks5-server=127.0.0.1:1056", "--no-logs-no-support"]);
  assert.equal(daemon[6], "env:PATH", "tailscaled saw more of computerd's environment than PATH");
  const upArgs = f.argv().find(a => a[0] === "tailscale" && a[2] === "up");
  assert.ok(upArgs.includes("--hostname=vyre-agent-kit") && upArgs.includes("--advertise-tags=tag:vyre-agent") && upArgs.includes("--shields-up"));
  // The key reached tailscale, through a private file, and never through an argument.
  const seen = f.seen();
  assert.equal(seen.key, KEY);
  assert.equal(seen.mode, 0o600);
  assert.equal(seen.dirMode, 0o700);
  assert.ok(!f.logText().includes(KEY), "the key was on a command line");
  assert.deepEqual(fs.readdirSync(f.dir).filter(n => n.startsWith("authkey-")), [], "the key's file outlived the up call");
  assert.deepEqual((await tn.handle("GET", "/tailnet")).body, { ready: true, running: true, stableId: "nKit7CNTRL", node: "vyre-agent-kit.tail0000.ts.net" });
  // A clean stop logs out.
  assert.deepEqual((await tn.handle("POST", "/tailnet/down", {})).body, { down: true });
  assert.ok(f.argv().some(a => a[0] === "tailscale" && a[2] === "logout"));
  assert.equal((await tn.handle("GET", "/tailnet")).body.running, false);
});

test("computerd tailnet: as any uid but root it refuses, and starts nothing", async t => {
  const f = fakes(t);
  const tn = side(t, f, 1000);
  const st = await tn.handle("GET", "/tailnet");
  assert.equal(st.body.ready, false);
  assert.match(st.body.why, /uid 1000, not root/);
  const up = await tn.handle("POST", "/tailnet/up", { authKey: KEY, hostname: "vyre-agent-kit", tag: "tag:vyre-agent" });
  assert.equal(up.status, 403);
  assert.deepEqual(f.argv(), [], "a binary ran");
  assert.ok(!fs.existsSync(f.dir));
});

test("computerd tailnet: a failing up never echoes the key, and still deletes its file", async t => {
  const f = fakes(t, { upFails: true });
  const tn = side(t, f);
  const r = await tn.handle("POST", "/tailnet/up", { authKey: KEY, hostname: "vyre-agent-kit", tag: "tag:vyre-agent" });
  assert.equal(r.status, 500);
  assert.match(r.body.error.message, /tailscale up failed: backend error: invalid key: \[key\]/);
  assert.ok(!JSON.stringify(r.body).includes(KEY));
  assert.deepEqual(fs.readdirSync(f.dir).filter(n => n.startsWith("authkey-")), []);
});

test("computerd tailnet: bad input is refused before anything runs; a folder it does not own is refused", async t => {
  const f = fakes(t);
  const tn = side(t, f);
  for (const body of [
    { authKey: "not-a-key", hostname: "vyre-agent-kit", tag: "tag:vyre-agent" },
    { authKey: KEY, hostname: "laptop", tag: "tag:vyre-agent" },
    { authKey: KEY, hostname: "vyre-agent-kit", tag: "autogroup:admin" },
    { authKey: KEY, hostname: "vyre-agent-kit --exit-node=box", tag: "tag:vyre-agent" },
  ]) {
    const r = await tn.handle("POST", "/tailnet/up", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(f.argv(), []);
  fs.mkdirSync(f.dir, { mode: 0o755 });
  fs.chmodSync(f.dir, 0o755);
  const open = await tn.handle("POST", "/tailnet/up", { authKey: KEY, hostname: "vyre-agent-kit", tag: "tag:vyre-agent" });
  assert.equal(open.status, 500);
  assert.match(open.body.error.message, /not a private folder/);
});
