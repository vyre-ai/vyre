// @ts-check
// A preview's process gets its own loopback port and no other address. The profile and the wrapper are checked as text; on a hosted macOS runner a real walled child proves it: the parent reaches the port, the child
// reaches itself on it, and its connections to another loopback listener and to a unix socket fail (while the same child with no wall reaches them, so the listeners are real).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { previewProfile, previewWall } from "./preview-wall.js";
import { createSupervisor, LIMITS } from "../../core/previews/supervisor.js";
import { skipOffRunner } from "./test-host.js";

test("the profile allows everything but the network, and the network only on the preview's own port", () => {
  const p = previewProfile(5123);
  assert.ok(p.startsWith("(version 1)\n(allow default)\n(deny network*)"));
  assert.equal((p.match(/5123/g) || []).length, 3, "bind, accept and connect to itself, all on its port");
  for (const only of ["network-bind", "network-inbound", "network-outbound"]) assert.ok(p.includes(`(allow ${only}`));
  assert.ok(!/\(allow network\*|\(allow network-outbound \(remote ip/.test(p), "no blanket network allow, no other address");
  assert.throws(() => previewProfile(0));
  assert.throws(() => previewProfile(70000));
  assert.throws(() => previewProfile(Number("5123; (allow network*)")));
});

test("the wrapper: sandbox-exec on macOS only; nothing elsewhere (the Linux box keeps the limits alone)", () => {
  const find = () => "/usr/bin/sandbox-exec";
  const w = previewWall(5123, { platform: "darwin", find });
  assert.ok(w);
  const r = /** @type {any} */ (w)("npm run dev");
  assert.equal(r.cmd, "/usr/bin/sandbox-exec");
  assert.deepEqual(r.args.slice(0, 1), ["-p"]);
  assert.deepEqual(r.args.slice(2), ["/bin/sh", "-c", "npm run dev"], "the command is handed on whole");
  assert.equal(previewWall(5123, { platform: "linux", find }), null);
  assert.equal(previewWall(5123, { platform: "darwin", find: () => undefined }), null);
});

test("the supervisor starts the command through the wall, whole, and says when there is none", () => {
  /** @type {any[]} */ const started = [];
  const spawnFake = /** @type {any} */ ((cmd, args) => { started.push({ cmd, args }); return { stdout: null, stderr: null, on() {}, kill() {}, pid: 1 }; });
  const walled = createSupervisor({ spawn: spawnFake, wall: port => script => ({ cmd: "/wall", args: [String(port), script] }), log: () => {}, now: () => 0, pollMs: 1e6, giveUpMs: 1e6 });
  walled.start("a", { command: "npm run dev", cwd: "/tmp", port: 4100 });
  assert.equal(started[0].cmd, "/wall");
  assert.equal(started[0].args[0], "4100");
  assert.equal(started[0].args[1], `${LIMITS}npm run dev`);
  assert.doesNotMatch(walled.tail("a"), /no network wall/);
  walled.stop("a");
  const bare = createSupervisor({ spawn: spawnFake, wall: () => null, log: () => {}, now: () => 0, pollMs: 1e6, giveUpMs: 1e6 });
  bare.start("b", { command: "npm run dev", cwd: "/tmp", port: 4101 });
  assert.equal(started[1].cmd, "/bin/sh");
  assert.match(bare.tail("b"), /no network wall on this machine/);
  bare.stop("b");
});

const CHILD = `
const net=require("node:net");const [,, port, other, sock]=process.argv;const out={};
const srv=net.createServer(s=>s.end("hi"));
srv.on("error",e=>{out.listen="blocked:"+e.code});
srv.listen(Number(port),"127.0.0.1",()=>{
  const tryTo=(k,...a)=>new Promise(r=>{const s=net.connect(...a);s.on("connect",()=>{out[k]="connected";s.destroy();r()});s.on("error",e=>{out[k]="blocked:"+e.code;r()});setTimeout(()=>{out[k]=out[k]||"blocked:TIMEOUT";r()},2000)});
  Promise.all([tryTo("self",Number(port),"127.0.0.1"),tryTo("other",Number(other),"127.0.0.1"),tryTo("unix",sock)]).then(()=>setTimeout(()=>{console.log(JSON.stringify(out));process.exit(0)},1500));
});`;

/** @param {string} cmd @param {string[]} args @param {number} port */
const runChild = (cmd, args, port) => new Promise(resolve => {
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", reached = false, done = false;
  c.stdout.on("data", d => { out += d; });
  const poll = setInterval(() => { const s = net.connect({ host: "127.0.0.1", port }); s.on("connect", () => { reached = true; s.destroy(); }); s.on("error", () => {}); }, 150);
  const fin = () => { if (!done) { done = true; clearInterval(poll); let r = {}; try { r = JSON.parse(out.trim().split("\n").pop() || "{}"); } catch { r = {}; } resolve({ ...r, parent: reached ? "reached" : "blocked" }); } };
  c.on("exit", fin); setTimeout(() => { try { c.kill("SIGKILL"); } catch {} fin(); }, 12_000).unref();
});

test("a real walled child: the parent reaches its port, it reaches itself, and no other address answers it", { skip: skipOffRunner(), timeout: 60_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-pw-"));
  const file = path.join(dir, "child.cjs");
  fs.writeFileSync(file, CHILD);
  const sock = path.join(dir, "s.sock");
  const unix = net.createServer(s => s.end()); await new Promise(r => unix.listen(sock, () => r(undefined)));
  const other = net.createServer(s => s.end()); await new Promise(r => other.listen(0, "127.0.0.1", () => r(undefined)));
  const free = net.createServer(); await new Promise(r => free.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (free.address()).port; await new Promise(r => free.close(() => r(undefined)));
  t.after(() => { unix.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const otherPort = /** @type {any} */ (other.address()).port;
  const args = [file, String(port), String(otherPort), sock];
  // control: with no wall the same child reaches every listener, so the listeners are real
  const bare = /** @type {any} */ (await runChild(process.execPath, args, port));
  assert.equal(bare.other, "connected", "without the wall it reaches another loopback port");
  assert.equal(bare.unix, "connected", "and a unix socket");
  const wall = previewWall(port);
  if (!wall) { assert.notEqual(process.platform, "darwin", "a hosted macOS runner has sandbox-exec, so there is a wall"); return; }
  const w = wall(`exec ${JSON.stringify(process.execPath)} ${args.map(a => JSON.stringify(a)).join(" ")}`);
  const got = /** @type {any} */ (await runChild(w.cmd, w.args, port));
  assert.equal(got.parent, "reached", "the parent still reaches the preview's port");
  assert.equal(got.self, "connected", "the preview reaches itself on its port");
  assert.match(String(got.other), /^blocked/, "another loopback port is out of reach");
  assert.match(String(got.unix), /^blocked/, "a unix socket is out of reach");
});
