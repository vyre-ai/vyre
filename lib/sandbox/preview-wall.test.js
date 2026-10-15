// @ts-check
// A preview's process gets its own loopback port and no other address. The profile and the wrappers are checked as text; then a real preview, started by the real supervisor (macOS: sandbox-exec, Linux: a private
// network with the port carried out on a unix socket), answers its page to the parent while its own attempts to reach another loopback listener and an address outside fail (the same server with no wall reaches
// them, so the listeners are real).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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

test("the wrappers: sandbox-exec on macOS; on Linux bubblewrap with a private network, the forwarder beside the command and a socket to relay to; nothing where there is neither", () => {
  const find = () => "/usr/bin/sandbox-exec";
  const w = previewWall(5123, { platform: "darwin", find });
  assert.ok(w);
  const r = /** @type {any} */ (w)("npm run dev");
  assert.equal(r.cmd, "/usr/bin/sandbox-exec");
  assert.deepEqual(r.args.slice(0, 1), ["-p"]);
  assert.deepEqual(r.args.slice(2), ["/bin/sh", "-c", "npm run dev"], "the command is handed on whole");
  assert.equal(previewWall(5123, { platform: "darwin", find: () => undefined }), null);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-pwt-"));
  try {
    const lin = /** @type {any} */ (previewWall(5123, { platform: "linux", find: () => "/usr/bin/bwrap", probe: () => true, base }));
    assert.ok(lin && lin.socket && lin.dir, "a Linux wall names the socket the preview's port is carried on");
    assert.ok(lin.socket.startsWith(lin.dir + path.sep));
    assert.equal(fs.statSync(lin.dir).mode & 0o777, 0o700, "a private folder");
    const x = lin("npm run dev && echo hi");
    assert.equal(x.cmd, "/usr/bin/bwrap");
    for (const need of ["--unshare-net", "--unshare-pid", "--die-with-parent"]) assert.ok(x.args.includes(need), need);
    assert.ok(!x.args.includes("--share-net"));
    const sh = x.args[x.args.length - 1];
    assert.ok(sh.includes("preview-forward.js") && sh.includes(`${lin.socket}' 5123 & exec /bin/sh -c 'npm run dev && echo hi'`), "the forwarder runs beside the command, which is handed on whole");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
  assert.equal(previewWall(5123, { platform: "linux", find: () => "/usr/bin/bwrap", probe: () => false }), null, "bubblewrap that cannot make a private network is no wall");
  assert.equal(previewWall(5123, { platform: "linux", find: () => undefined }), null);
  assert.equal(previewWall(5123, { platform: "win32", find }), null);
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

const SERVER = `
const net=require("node:net"),http=require("node:http");
const tryTo=(out,k,...a)=>new Promise(r=>{const s=net.connect(...a);s.on("connect",()=>{out[k]="connected";s.destroy();r()});s.on("error",e=>{out[k]="blocked:"+e.code;r()});setTimeout(()=>{out[k]=out[k]||"blocked:TIMEOUT";r()},2000)});
http.createServer(async(req,res)=>{const out={};
  const jobs=[tryTo(out,"other",Number(process.env.OTHER_PORT),"127.0.0.1"),tryTo(out,"unix",process.env.OTHER_SOCK)];
  if(process.env.OUTSIDE_ADDR)jobs.push(tryTo(out,"outside",Number(process.env.OUTSIDE_PORT),process.env.OUTSIDE_ADDR));
  await Promise.all(jobs);res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(out))}).listen(Number(process.env.PORT),"127.0.0.1");`;

/** Start the server through a supervisor, wait until it is live, ask it what it can reach, stop it. @param {any} wall @param {number} port @param {string} file @param {Record<string, string>} env */
async function probeThrough(wall, port, file, env) {
  /** @type {string} */ let state = "";
  const sup = createSupervisor({ wall, log: () => {}, onState: (_id, st) => { state = st; } });
  try {
    sup.start("pv", { command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`, cwd: os.tmpdir(), port, env });
    const end = Date.now() + 20_000;
    while (state !== "live" && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    assert.equal(state, "live", `the preview came up (${sup.tail("pv")})`);
    const res = await fetch(`http://127.0.0.1:${port}/probe`);
    return /** @type {any} */ (await res.json());
  } finally { sup.stop("pv"); await new Promise(r => setTimeout(r, 400)); }
}

test("a real preview: its page answers the parent on the leased port, and it reaches no other loopback port, no unix socket (macOS) and no outside address", { skip: skipOffRunner(), timeout: 90_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-pw-"));
  const file = path.join(dir, "server.cjs");
  fs.writeFileSync(file, SERVER);
  const sock = path.join(dir, "s.sock");
  const listen = (/** @type {net.Server} */ srv, /** @type {any[]} */ ...a) => new Promise(r => srv.listen(...a, () => r(undefined)));
  const unix = net.createServer(s => s.end()); await listen(unix, sock);
  const other = net.createServer(s => s.end()); await listen(other, 0, "127.0.0.1");
  const ext = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal);
  const outside = net.createServer(s => s.end()); if (ext) await listen(outside, 0, "0.0.0.0");
  const free = async () => { const f = net.createServer(); await listen(f, 0, "127.0.0.1"); const p = /** @type {any} */ (f.address()).port; await new Promise(r => f.close(() => r(undefined))); return p; };
  t.after(() => { unix.close(); other.close(); outside.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { OTHER_PORT: String(/** @type {any} */ (other.address()).port), OTHER_SOCK: sock, ...(ext ? { OUTSIDE_ADDR: ext.address, OUTSIDE_PORT: String(/** @type {any} */ (outside.address()).port) } : {}) };
  // control: with no wall the same page reaches every listener, so the listeners are real
  const bare = await probeThrough(() => null, await free(), file, env);
  assert.equal(bare.other, "connected", "without a wall it reaches another loopback port");
  assert.equal(bare.unix, "connected", "and a unix socket");
  if (ext) assert.equal(bare.outside, "connected", "and an address outside");
  // walled: the page still answers (probeThrough fetched it from here), and nothing else is reachable
  const got = await probeThrough(previewWall, await free(), file, env);
  assert.match(String(got.other), /^blocked/, "another loopback port is out of reach");
  if (ext) assert.match(String(got.outside), /^blocked/, "so is an address outside this machine");
  if (process.platform === "darwin") assert.match(String(got.unix), /^blocked/, "and a unix socket (macOS)");
});
