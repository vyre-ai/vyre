#!/usr/bin/env node
// Measures what lending costs: the same work in a plain folder and inside the runner's sandbox on the encrypted, leased workspace.
// node scripts/runner-perf.mjs [--reps N] [--out file.json]   (macOS or Linux; never run on a person's own account: use a runner or a test box)
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import http from "node:http"; import { spawn } from "node:child_process";
import { createRunner } from "../core/runner/runner.js";
import { fakeSpace } from "../core/runner/testing/fake-space.js";
import { unavailable } from "../core/runner/sandbox.js";
import { workspaceUnavailable } from "../core/runner/workspace.js";
import { selfTest } from "../core/runner/homesandbox.js";

const reps = Number(process.argv[process.argv.indexOf("--reps") + 1]) || 5;
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const why = unavailable() || workspaceUnavailable(); if (why) { console.error("cannot run here: " + why); process.exit(2); }
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rperf-"));
const worker = path.join(root, "agent"); fs.mkdirSync(worker); fs.copyFileSync(new URL("../core/runner/testing/perf-worker.mjs", import.meta.url), path.join(worker, "worker.mjs"));
const up = http.createServer((req, res) => res.end("ok")); await new Promise(r => up.listen(0, "127.0.0.1", r));
const sp = fakeSpace();
const result = { platform: process.platform + "-" + process.arch, node: process.version, reps, start: {}, rows: [] };

/** Lines from a child's stdout, one at a time, as a queue. */
const lines = child => { const q = [], w = []; let b = ""; child.stdout.on("data", d => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); try { const j = JSON.parse(l); const x = w.shift(); x ? x(j) : q.push(j); } catch {} } }); return () => new Promise(r => { q.length ? r(q.shift()) : w.push(r); }); };
const turn = async (send, next, cmd) => { send(cmd); let r; const res = []; for (;;) { r = await next(); if (r.type === "result") break; res.push(r); } return res.find(x => x.scenario); };

// ---- plain: the worker in an ordinary folder, no sandbox, no encryption -------------------------------------------------
const plainDir = path.join(root, "plain"); fs.mkdirSync(plainDir);
const t0 = performance.now();
const pc = spawn(process.execPath, [path.join(worker, "worker.mjs")], { cwd: plainDir, stdio: ["pipe", "pipe", "inherit"] });
const pnext = lines(pc); await pnext();   // ready
result.start.plain = performance.now() - t0;
const SCEN = ["writes", "search", "extract", "cpu", "clone"];
const plain = {};
for (const s of SCEN) { plain[s] = []; for (let i = 0; i < (s === "extract" || s === "clone" ? Math.min(reps, 3) : reps); i++) plain[s].push((await turn(l => pc.stdin.write(l + "\n"), pnext, "run " + s)).ms); }
plain.calls = []; for (let i = 0; i < reps; i++) plain.calls.push((await turn(l => pc.stdin.write(l + "\n"), pnext, `run calls http://127.0.0.1:${up.address().port}/`)).ms);
pc.kill();

// ---- lent: the runner (lease, encrypted workspace, sandbox, proxy, checkpoint at every turn) ---------------------------
const ev = []; const stamp = (e) => ev.push({ ...e, at: performance.now() });
const runner = createRunner({ base: path.join(root, "rn"), space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), watchdog: false, onEvent: stamp });
const routes = [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.address().port}`, credential: { header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }] }];
const tLease = performance.now(); await runner.open(); result.start.lease_and_workspace = performance.now() - tLease;   // lease + create + mount
const tStart = performance.now();
const h = await runner.start({ session: "s1", command: process.execPath, args: [path.join(worker, "worker.mjs")], readOnly: [worker, path.dirname(process.execPath)], routes });
const lnext = lines(h.child); await lnext();   // ready
result.start.sandbox_to_ready = performance.now() - tStart;
result.start.lent_total = result.start.lease_and_workspace + result.start.sandbox_to_ready;
const lent = {}, ckpt = {};
for (const s of [...SCEN, "calls"]) {
  lent[s] = []; ckpt[s] = [];
  for (let i = 0; i < (s === "extract" || s === "clone" ? Math.min(reps, 3) : reps); i++) {
    const n0 = ev.length; const r = await turn(l => h.send(l), lnext, "run " + s);
    // the checkpoint after the turn: how long the session was paused while the reader and the upload ran
    const t1 = performance.now(); const c = await new Promise(res => { const tick = setInterval(() => { const e = ev.slice(n0).find(x => x.type === "checkpoint"); if (e) { clearInterval(tick); res(e); } }, 5); });
    lent[s].push(r.ms); ckpt[s].push(c.at - t1 < 0 ? 0 : c.at - t1);
  }
}
// lock then reopen: the cost of getting back after the workspace was closed (a sleeping laptop wakes to this)
await h.stop();
const tl = performance.now(); await runner.lock(); result.start.lock = performance.now() - tl;
const to = performance.now(); await runner.contact(); result.start.reopen_after_lock = performance.now() - to;
const tr = performance.now(); const h2 = await runner.start({ session: "s1", resume: true, command: process.execPath, args: [path.join(worker, "worker.mjs")], readOnly: [worker, path.dirname(process.execPath)], routes }).catch(e => ({ error: e.message }));
result.start.resume_from_checkpoint = performance.now() - tr; if (h2.child) { await lines(h2.child)(); await h2.stop(); }
await runner.lock();
// the home-session self-test, which runs before each session
try {
  const home = path.join(root, "home"); fs.mkdirSync(path.join(home, ".vyre/run"), { recursive: true }); const own = path.join(home, ".vyre/run/s.sock");
  const net = await import("node:net"); const srv = net.createServer(c => c.end()); await new Promise(r => srv.listen(own, r));
  const ts = performance.now();
  const st = await selfTest({ platform: process.platform, command: process.execPath, home, vyreHome: path.join(home, ".vyre"), sessionSocket: own, workdirs: [], temp: path.join(root, "t"), agent: { command: process.execPath, versionArgs: ["-v"], settingsPaths: [], hosts: [] }, probes: { personSocket: path.join(home, ".vyre/p.sock"), otherSocket: path.join(home, ".vyre/o.sock"), daemonPorts: [1], keyFile: path.join(home, ".vyre/k") } });
  result.start.self_test = performance.now() - ts; result.start.self_test_ok = st.ok; srv.close();
} catch (e) { result.start.self_test_error = e.message; }

for (const s of [...SCEN, "calls"]) result.rows.push({ scenario: s, plain_median: med(plain[s]), plain_max: Math.max(...plain[s]), lent_median: med(lent[s]), lent_max: Math.max(...lent[s]), ratio: med(lent[s]) / med(plain[s]), checkpoint_pause_median: med(ckpt[s]), checkpoint_pause_max: Math.max(...ckpt[s]) });
console.log(JSON.stringify(result, null, 1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
await runner.revoke().catch(() => {}); up.close(); fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
