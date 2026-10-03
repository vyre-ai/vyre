// Regression tests for reviewer-2's gate on the runner (team/0.3/reviews/runner.md): Z1 to Z8, the watchdog, resume taint.
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { SCRATCH } from "../../test/scratch.mjs";
import { readInside, listInside, writeInside } from "./safefs.js";
import { createSessionSync, restore, localReaderFor } from "./sync.js";
import { sandboxReader } from "./readerhost.js";
import { createLease } from "./lease.js";
import { createRunner, reconcile, weakest } from "./runner.js";
import { createEgress } from "./egress.js";
import { checkBind, plan, unavailable } from "./sandbox.js";
import { driverFor, workspaceUnavailable } from "./workspace.js";
import { watch } from "./watchdog.js";
import { fakeSpace } from "./testing/fake-space.js";

const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "hd-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POSIX = process.platform !== "win32";

// ---- Z1, Z2: the session plants symlinks; the runner's sync must never follow one ----------------------------------

test("Z1: restore never writes through a symlink the session planted", { skip: !POSIX }, async t => {
  const sp = fakeSpace(); const a = tmp(), host = tmp(); t.after(() => { rm(a); rm(host); });
  // The space holds a checkpoint with a file under files/real/.
  const src = path.join(a, "src"); fs.mkdirSync(path.join(src, "work", "files", "real"), { recursive: true }); fs.mkdirSync(path.join(src, "state"));
  fs.writeFileSync(path.join(src, "work", "files", "real", "pwned.txt"), "SESSION-CHOSEN");
  const sy = createSessionSync({ space: sp.sync, session: "s1", work: path.join(src, "work"), state: path.join(src, "state"), reader: localReaderFor(path.join(src, "work")), seal: s => s });
  await sy.line('{"type":"result"}'); assert.equal(await sy.checkpoint(), true);
  // The destination workspace has files/real replaced by a link to a host folder.
  const dst = path.join(a, "dst"); fs.mkdirSync(path.join(dst, "work", "files"), { recursive: true });
  fs.symlinkSync(host, path.join(dst, "work", "files", "real"));
  await restore({ space: sp.sync, session: "s1", work: path.join(dst, "work"), state: path.join(dst, "state"), verify: () => true });
  assert.deepEqual(fs.readdirSync(host), [], "nothing was written in the host folder");
});

test("Z2: a file swapped for a symlink to a host file is not uploaded, and links in the walk are skipped", { skip: !POSIX }, async t => {
  const sp = fakeSpace(); const a = tmp(), host = tmp(); t.after(() => { rm(a); rm(host); });
  fs.writeFileSync(path.join(host, "secret"), "HOST-SECRET-KEY");
  const work = path.join(a, "work"); fs.mkdirSync(path.join(work, "files"), { recursive: true });
  fs.symlinkSync(path.join(host, "secret"), path.join(work, "files", "b.txt"));
  fs.symlinkSync(host, path.join(work, "files", "dir"));
  fs.writeFileSync(path.join(work, "files", "ok.txt"), "fine");
  assert.equal(readInside(work, "files/b.txt", 1e6), null);
  assert.equal(readInside(work, "files/dir/secret", 1e6), null);
  assert.deepEqual(listInside(work, "files"), ["files/ok.txt"]);
  const sy = createSessionSync({ space: sp.sync, session: "s1", work, state: path.join(a, "state"), reader: localReaderFor(work), seal: s => s });
  await sy.line('{"type":"result"}'); await sy.checkpoint();
  const uploaded = [...sp.state.files.keys()].map(k => k.split("|")[1]);
  assert.deepEqual(uploaded, ["files/ok.txt"]);
  assert.ok(![...sp.state.files.values()].some(v => v.some(b => b && b.includes("HOST-SECRET"))));
  // a symlinked home subfolder is refused as a whole
  fs.mkdirSync(path.join(work, "home"), { recursive: true });
  fs.symlinkSync(host, path.join(work, "home", ".claude"));
  assert.deepEqual(listInside(work, "home/.claude"), []);
  assert.throws(() => writeInside(work, "home/.claude/x", Buffer.from("x")));
  // special files and parent climbs
  assert.equal(readInside(work, "../x", 10), null);
  assert.throws(() => writeInside(work, "files/../../escape", Buffer.from("x")));
});

// ---- Z3: wall-clock expiry and sleep -------------------------------------------------------------------------------

test("Z3: after a sleep the lease is locked by the wall clock, not by a timer that never fired", async () => {
  const sp = fakeSpace({ ttlMs: 3_600_000 });
  let t = 1_000_000; const locks = [];
  const l = createLease({ vault: sp.vault, space: "harlow", device: "kit", now: () => t, tickMs: 1e9, onLock: w => locks.push(w) });
  await l.acquire();
  t += 8 * 3_600_000;                       // eight hours pass with no timer firing (a closed laptop)
  assert.equal(l.key(), null, "no key after the lease");
  await l.tick();
  assert.deepEqual(locks, ["expired"], "the tick locks it at once");
  assert.equal(l.state, "locked");
});

test("Z3b: a gap between ticks means the machine slept: lock now and ask the vault again on wake", async () => {
  const sp = fakeSpace({ ttlMs: 3_600_000 });
  let t = 5_000; const locks = [];
  let m = 0;
  const l = createLease({ vault: sp.vault, space: "harlow", device: "kit", now: () => t, mono: () => m, tickMs: 1e9, sleepGapMs: 90_000, onLock: w => locks.push(w) });
  await l.acquire();
  t += 30_000; m += 30_000; await l.tick(); assert.deepEqual(locks, []);
  t += 20 * 60_000; m += 20 * 60_000; await l.tick(); assert.deepEqual(locks, [], "a blocked event loop moves both clocks: not a sleep");
  t += 20 * 60_000; m += 5_000; await l.tick();         // 20 minutes of wall time, 5 s of monotonic time: the machine slept, still inside the lease
  assert.deepEqual(locks, ["slept"]);
  assert.equal(l.key(), null);
  assert.deepEqual(await l.acquire(), { ok: true });   // wake: a fresh lease, checked again by the vault
  assert.equal(sp.state.leases, 2);
});

// ---- Z4, Z5: a failed unmount is not "locked"; a dead runner's workspace is closed -----------------------------------

function fakeDriver() {
  const st = { mounted: false, failUnmount: 0, exists: false, unmounts: 0 };
  return { st, name: "fake", exists: () => st.exists, isMounted: () => st.mounted,
    async create() { st.exists = true; }, async mount(d) { st.mounted = true; return path.join(d, "mnt"); },
    async unmount() { st.unmounts++; if (st.failUnmount > 0) { st.failUnmount--; throw new Error("busy"); } st.mounted = false; },
    async destroy() { if (st.mounted) throw new Error("busy"); st.exists = false; } };
}
const mk = (over = {}) => {
  const base = tmp(); const drv = fakeDriver(); const sp = fakeSpace(); const ev = [];
  const r = createRunner({ base, space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, driver: drv, watchdog: false, lockRetryMs: 1, platform: process.platform === "win32" ? "linux" : process.platform,
    grants: () => ({ spaceAllows: true, memberAccepts: true }), onEvent: e => ev.push(e.type), ...over });
  return { base, drv, sp, ev, r };
};

test("Z4: a failed unmount is reported as lock-pending, never locked, and is chased until it works", async t => {
  const { base, drv, ev, r } = mk(); t.after(() => rm(base));
  fs.mkdirSync(path.join(r.dir, "mnt"), { recursive: true });
  await r.open();
  drv.st.failUnmount = 1000;
  await r.lock();
  assert.ok(ev.includes("lock-pending"));
  assert.ok(!ev.includes("locked"), "locked is not claimed while the workspace is still mounted");
  assert.equal(r.status().mounted, true);
  drv.st.failUnmount = 0;
});

test("Z4b: revoke with an unmount that fails does not say deleted", async t => {
  const { base, drv, ev, r } = mk(); t.after(() => rm(base));
  await r.open();
  drv.st.failUnmount = 1000;
  await r.revoke();
  assert.ok(!ev.includes("deleted"));
  assert.ok(!ev.includes("locked"));
  assert.equal(drv.st.exists, true);
  drv.st.failUnmount = 0;
});

test("Z5: the watchdog closes a workspace whose runner is gone, and one whose deadline has passed", async t => {
  const d = tmp(); t.after(() => rm(d));
  const drv = fakeDriver(); drv.st.mounted = true;
  const f = path.join(d, "deadline"); fs.writeFileSync(f, JSON.stringify({ gen: "g1", at: Date.now() + 3_600_000 }));
  assert.equal(await watch({ driver: drv, dir: "x", pid: 1, deadlineFile: f, isAlive: () => false, pollMs: 5, gen: "g1" }), "unmounted");
  drv.st.mounted = true; fs.writeFileSync(f, JSON.stringify({ gen: "g1", at: Date.now() - 1 }));
  assert.equal(await watch({ driver: drv, dir: "x", pid: 1, deadlineFile: f, isAlive: () => true, pollMs: 5, gen: "g1" }), "unmounted");
  // a newer opening of the workspace: the old watchdog leaves its mount alone
  drv.st.mounted = true; fs.writeFileSync(f, JSON.stringify({ gen: "g2", at: Date.now() - 1 }));
  assert.equal(await watch({ driver: drv, dir: "x", pid: 1, deadlineFile: f, isAlive: () => false, pollMs: 5, gen: "g1" }), "superseded");
  assert.equal(drv.st.mounted, true);
});

test("Z5b: start-up reconcile closes every workspace nobody holds a lease for", async t => {
  const { base, drv } = mk(); t.after(() => rm(base));
  fs.mkdirSync(path.join(base, "spaces", "aa"), { recursive: true });
  drv.st.mounted = true;
  const closed = await reconcile({ base, driver: drv, platform: "linux" });
  assert.equal(closed.length, 1);
  assert.equal(drv.st.mounted, false);
});

const REAL = unavailable() === "" && workspaceUnavailable() === "" && POSIX;
test("Z5c: kill -9 the runner and the real workspace is closed by the watchdog", { skip: !REAL || false, timeout: 60_000 }, async t => {
  const base = tmp(); t.after(() => rm(base));
  const child = spawn(process.execPath, [new URL("./testing/open-and-wait.mjs", import.meta.url).pathname, base], { stdio: ["ignore", "pipe", "inherit"] });
  let dir = "";
  await new Promise((res, rej) => { child.stdout.on("data", d => { const m = /ready (.+)/.exec(String(d)); if (m) { dir = m[1].trim(); res(undefined); } }); child.on("exit", () => rej(new Error("child exited"))); setTimeout(() => rej(new Error("timeout")), 30000); });
  const drv = driverFor(process.platform);
  t.after(async () => { try { await drv.unmount(dir); } catch {} });
  assert.equal(drv.isMounted(dir), true, "open while the runner lives");
  child.kill("SIGKILL");
  const t0 = Date.now(); while (drv.isMounted(dir) && Date.now() - t0 < 20000) await sleep(250);
  assert.equal(drv.isMounted(dir), false, "closed by the watchdog after the runner died");
});

// ---- Z7: a home-like folder is never bound ---------------------------------------------------------------------------

test("Z7: the sandbox is never given the home folder, anything above it, or a folder holding a secret folder", t => {
  const home = tmp(); t.after(() => rm(home));
  fs.mkdirSync(path.join(home, ".ssh")); fs.mkdirSync(path.join(home, "agents", "juno"), { recursive: true }); fs.mkdirSync(path.join(home, "tools", ".aws"), { recursive: true });
  assert.throws(() => checkBind(home, home), /home folder/);
  assert.throws(() => checkBind(path.dirname(home), home), /home folder or above/);
  assert.throws(() => checkBind("/", home));
  assert.throws(() => checkBind(path.join(home, "tools"), home), /\.aws/);
  assert.equal(checkBind(path.join(home, "agents", "juno"), home), fs.realpathSync(path.join(home, "agents", "juno")));
});

test("Z7b: a program is only run from a granted tool folder, and plan refuses a home as a tool folder", t => {
  const home = tmp(), ws = tmp(); t.after(() => { rm(home); rm(ws); });
  fs.mkdirSync(path.join(home, ".ssh")); fs.mkdirSync(path.join(home, "agents"));
  fs.writeFileSync(path.join(home, "agents", "agent"), "#!/bin/sh\n", { mode: 0o755 });
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  assert.throws(() => plan({ platform, workspace: ws, command: path.join(home, "agents", "agent"), readOnly: [home], proxy: { port: 1, socket: "/x" }, home }), /home folder|holds/);
  assert.throws(() => plan({ platform, workspace: ws, command: path.join(home, "agents", "agent"), readOnly: [], proxy: { port: 1, socket: "/x" }, home }), /granted tool folder/);
});

// ---- Z8: a credentialed route only does what it lists ------------------------------------------------------------------

test("Z8: a credential is only added for a listed method and path, and the vault is told the method and path", async () => {
  const seen = []; const up = http.createServer((req, res) => { seen.push(req.method + " " + req.url + " " + (req.headers.authorization || "")); res.end("ok"); });
  await new Promise(r => up.listen(0, "127.0.0.1", r));
  const sp = fakeSpace();
  const eg = createEgress({ routes: [{ prefix: "/pay", upstream: `http://127.0.0.1:${up.address().port}`, credential: { header: "authorization", prefix: "Bearer " }, allow: [{ method: "GET", path: "/v1/customers/*" }] }],
    vault: sp.vault, session: "s1", token: "t", lease: () => "lease-1" });
  const { port } = await eg.listen();
  const call = (method, p) => new Promise(res => { const q = http.request({ hostname: "127.0.0.1", port, path: p, method, headers: { authorization: "Bearer t" } }, m => { m.resume(); m.on("end", () => res(m.statusCode)); }); q.on("error", () => res(0)); q.end(); });
  try {
    assert.equal(await call("GET", "/pay/v1/customers/cus_1"), 200);
    assert.equal(await call("POST", "/pay/v1/refunds"), 403);
    assert.equal(await call("DELETE", "/pay/v1/customers/cus_1"), 403);
    assert.equal(await call("GET", "/pay/v1/customers/%2e%2e/refunds"), 403, "a dot-dot is normalised away and then not on the list");
    assert.equal(await call("GET", "/pay/v1/customers/a%2fb"), 400);
    assert.equal(await call("GET", "/pay/v1/charges"), 403);
    assert.deepEqual(seen, ["GET /v1/customers/cus_1 Bearer ya29.REAL-GMAIL-SECRET"]);
    assert.deepEqual(sp.state.uses.map(u => u.method + " " + u.path), ["GET /v1/customers/cus_1"]);
  } finally { await eg.close(); await new Promise(r => { up.closeAllConnections(); up.close(r); }); }
  assert.throws(() => createEgress({ routes: [{ prefix: "/pay", upstream: "https://x.example", credential: { header: "authorization" } }], vault: sp.vault, session: "s", token: "t" }), /allowed methods and paths/);
});

// ---- resume carries trust ---------------------------------------------------------------------------------------------

test("resume: the checkpoint carries the session's trust and routes, and a resumed session cannot start cleaner or wider", () => {
  assert.equal(weakest("member", "external"), "external");
  assert.equal(weakest("untrusted", "system"), "untrusted");
});

// ---- S-1: the reader runs inside the sandbox, so a racing worker cannot make it read a host file ---------------------------

const SANDBOX = unavailable() === "" && process.platform !== "win32";
test("S-1: a racing worker swapping a folder for a link gets 0 host reads over 10,000 tries (the reader runs in the sandbox)", { skip: !SANDBOX, timeout: 120_000 }, async t => {
  const a = tmp(), host = tmp(); let racer;
  t.after(async () => { racer?.kill("SIGKILL"); await sleep(200); rm(a); rm(host); });
  fs.writeFileSync(path.join(host, "f.txt"), "HOST-FILE-CONTENT");
  const work = path.join(a, "work"); fs.mkdirSync(path.join(work, "files", "d"), { recursive: true }); fs.mkdirSync(path.join(work, "home"), { recursive: true });
  for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(work, "files", "d", `f${i}.txt`), "OWN-CONTENT");
  fs.writeFileSync(path.join(host, "f0.txt"), "HOST-FILE-CONTENT");
  racer = spawn(process.execPath, ["-e", `
    const fs=require("fs"),p=${JSON.stringify(path.join(work, "files", "d"))},real=p+"-real",host=${JSON.stringify(host)};
    fs.renameSync(p,real);
    for(;;){ try{fs.symlinkSync(host,p);}catch{} try{fs.unlinkSync(p);}catch{} try{fs.symlinkSync(real,p);}catch{} try{fs.unlinkSync(p);}catch{} }`], { stdio: "ignore", detached: true });   // its own session, like a setsid helper
  await sleep(300);
  const read = sandboxReader({ platform: process.platform, space: "harlow", work, base: a });
  let host_reads = 0, n = 0;
  await read({ roots: [{ dir: "files", remote: "files" }], have: {}, maxBytes: 1e6 }, async f => { n++; if (f.bytes && f.bytes.includes("HOST-FILE")) host_reads++; });
  console.log(`S-1 race: ${n} files read, ${host_reads} host reads`);
  assert.equal(host_reads, 0);
});

test("S-1b: the sandboxed reader returns plain files, skips links, and sends only what changed", { skip: !SANDBOX, timeout: 60_000 }, async t => {
  const a = tmp(), host = tmp(); t.after(() => { rm(a); rm(host); });
  fs.writeFileSync(path.join(host, "secret"), "HOST-SECRET-KEY");
  const work = path.join(a, "work"); fs.mkdirSync(path.join(work, "files", "sub"), { recursive: true });
  fs.writeFileSync(path.join(work, "files", "a.txt"), "alpha"); fs.writeFileSync(path.join(work, "files", "sub", "b.txt"), "beta");
  fs.symlinkSync(path.join(host, "secret"), path.join(work, "files", "link.txt")); fs.symlinkSync(host, path.join(work, "files", "linkdir"));
  const read = sandboxReader({ platform: process.platform, space: "harlow", work, base: a });
  const collect = async have => { const out = []; await read({ roots: [{ dir: "files", remote: "files" }], have, maxBytes: 1e6 }, async f => { out.push(f); }); return out; };
  const first = await collect({});
  assert.deepEqual(first.map(f => f.rel).sort(), ["files/a.txt", "files/sub/b.txt"]);
  assert.equal(first.find(f => f.rel === "files/a.txt").bytes.toString(), "alpha");
  const a0 = first.find(f => f.rel === "files/a.txt");
  const again = await collect({ "files/a.txt": { hash: a0.hash, size: a0.len, mtimeMs: a0.mtimeMs } });
  assert.equal(again.find(f => f.rel === "files/a.txt").bytes, null);
  assert.equal(again.find(f => f.rel === "files/a.txt").hash, a0.hash, "an unchanged file (same size and mtime) is listed with its known hash, not re-read");
  assert.equal(again.find(f => f.rel === "files/sub/b.txt").bytes.toString(), "beta");
});

// ---- seccomp (Linux) --------------------------------------------------------------------------------------------------

import { launch } from "./sandbox.js";
import { filter } from "./seccomp.js";
test("seccomp: the filter is a well-formed BPF program, and refuses keyctl, ptrace and bpf inside the sandbox but not ordinary calls", { skip: process.platform !== "linux" || unavailable() !== "", timeout: 30_000 }, async t => {
  const f = filter(); assert.ok(f && f.length % 8 === 0);
  const ws = tmp(); t.after(() => rm(ws));
  fs.mkdirSync(path.join(ws, "files"), { recursive: true });
  const code = `import ctypes,os
l=ctypes.CDLL(None,use_errno=True)
nr={"x86_64":{"keyctl":250,"ptrace":101,"bpf":321,"getpid":39},"aarch64":{"keyctl":219,"ptrace":117,"bpf":280,"getpid":172}}[os.uname().machine]
out={}
for k,v in nr.items():
    r=l.syscall(v,0,0,0,0,0); out[k]=(r,ctypes.get_errno() if r==-1 else 0)
print(out)`;
  const p = plan({ platform: "linux", workspace: ws, command: "/usr/bin/python3", args: ["-c", code], proxy: { port: 1, socket: "" }, env: {} });
  const child = launch(p);
  let out = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
  await new Promise(r => child.on("close", r));
  assert.match(out, /'keyctl': \(-1, 1\)/, out);
  assert.match(out, /'ptrace': \(-1, 1\)/, out);
  assert.match(out, /'bpf': \(-1, 1\)/, out);
  assert.doesNotMatch(out, /'getpid': \(-1/, out);
});

// ---- the real ports ---------------------------------------------------------------------------------------------------

import { realPorts } from "./ports.js";
test("ports: the lease is for this computer's device key and carries the kernel's answer; revoke callbacks are for this device", async () => {
  const calls = []; let both = true; const subs = [];
  const sealer = { lease: { issue: i => { calls.push(["issue", i]); return { id: "lease_1", key: "AA==", ttlMs: 1 }; }, renew: i => { calls.push(["renew", i]); return { ttlMs: 1 }; } } };
  const offers = { active: q => { calls.push(["active", q]); return { spaceAllows: both, memberAccepts: true }; }, onRevoke: fn => { subs.push(fn); return () => {}; } };
  const p = realPorts({ sealer, offers, credentialFor: async o => "secret-for-" + o.method, deviceId: () => "dev_kit", member: "usr_juno", spec: async () => ({}), sync: {} });
  assert.equal(p.device, "dev_kit");
  await p.vault.lease({ space: "spc_harlow", device: "anything the caller says" });
  assert.deepEqual(calls.find(c => c[0] === "issue")[1], { space: "spc_harlow", device: "dev_kit", allowed: true });
  both = false; await p.vault.renew({ id: "lease_1" });
  assert.deepEqual(calls.find(c => c[0] === "renew")[1], { id: "lease_1", allowed: false });
  assert.equal(await p.vault.credential({ method: "GET" }), "secret-for-GET");
  const got = []; p.onRevoke(i => got.push(i.id));
  subs[0]({ id: "o1", device: "dev_other" }); subs[0]({ id: "o2", device: "dev_kit" }); subs[0]({ id: "o3", device: null });
  assert.deepEqual(got, ["o2", "o3"]);
  assert.throws(() => realPorts({ sealer, offers, credentialFor: async () => "", deviceId: () => "", member: "m", spec: async () => ({}), sync: {} }), /device key/);
});

// ---- R-14: the reader is capped and has a deadline ---------------------------------------------------------------------

test("R-14: too many files or bytes refuses the checkpoint, and a slow reader is killed", { skip: !SANDBOX, timeout: 60_000 }, async t => {
  const a = tmp(); t.after(() => rm(a));
  const work = path.join(a, "work"); fs.mkdirSync(path.join(work, "files"), { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(work, "files", `f${i}.txt`), "x".repeat(1000));
  const roots = [{ dir: "files", remote: "files" }];
  const few = sandboxReader({ platform: process.platform, space: "harlow", work, base: a, limits: { maxFiles: 10 } });
  assert.deepEqual(await few({ roots, have: {} }, async () => {}), { truncated: true });
  const small = sandboxReader({ platform: process.platform, space: "harlow", work, base: a, limits: { maxTotal: 5000 } });
  assert.deepEqual(await small({ roots, have: {} }, async () => {}), { truncated: true });
  const slow = sandboxReader({ platform: process.platform, space: "harlow", work, base: a, limits: { deadlineMs: 1 } });
  await assert.rejects(() => slow({ roots, have: {} }, async () => {}), /too long/);
  const ok = sandboxReader({ platform: process.platform, space: "harlow", work, base: a });
  let n = 0; assert.deepEqual(await ok({ roots, have: {} }, async () => { n++; }), { truncated: false }); assert.equal(n, 30);
  // a checkpoint over the limits is refused, not recorded with files missing
  const sp = fakeSpace(); fs.mkdirSync(path.join(a, "state"), { recursive: true });
  const sy = createSessionSync({ space: sp.sync, session: "s1", work, state: path.join(a, "state"), reader: few, seal: s => s });
  await sy.line('{"type":"result"}');
  assert.equal(await sy.checkpoint(), false);
  assert.equal(sp.state.checkpoints.has("s1"), false);
});

// ---- reviewer-3: X-1 to X-5 ---------------------------------------------------------------------------------------------

import { run as runFilter, archId, numbers } from "./seccomp.js";
test("X-1, X-2: the filter refuses x32 numbers, io_uring and the new mount API, and allows ordinary calls, on both architectures", () => {
  for (const arch of ["x64", "arm64"]) {
    const f = filter(arch), id = archId(arch), nr = numbers(arch);
    for (const [name, n] of Object.entries(nr)) {
      assert.equal(runFilter(f, id, n), "refuse", `${arch} ${name}`);
      assert.equal(runFilter(f, id, n | 0x40000000), "refuse", `${arch} ${name} with the x32 bit`);
    }
    for (const n of arch === "x64" ? [0, 1, 2, 3, 39, 57, 59, 202, 231, 257] : [63, 64, 93, 172, 56, 220]) assert.equal(runFilter(f, id, n), "allow", `${arch} ordinary ${n}`);
    assert.equal(runFilter(f, id, 0x40000000 | 1), "refuse", "any x32 number");
    assert.equal(runFilter(f, 0x40000003, 1), "refuse", "another architecture");
    for (const name of ["io_uring_setup", "io_uring_enter", "io_uring_register", "fsopen", "fsmount", "mount_setattr", "chroot", "kcmp", "fanotify_init"]) assert.ok(name in nr, name);
  }
  assert.equal(filter("ia32"), null);
});

test("X-2: a CPU the filter does not cover refuses to start a session", { skip: process.platform !== "linux" }, () => {
  const old = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { value: "riscv64" });
  try { assert.match(unavailable("linux"), /no seccomp filter/); assert.throws(() => plan({ platform: "linux", workspace: tmp(), command: "/usr/bin/true", proxy: { port: 1, socket: "" } }), /no seccomp filter/); }
  finally { Object.defineProperty(process, "arch", old); }
});

test("X-3: a checkpoint is never resumed without a verifier, with a bad seal, or with a manifest or transcript that is not the one sealed", async t => {
  const sp = fakeSpace(); const a = tmp(); t.after(() => rm(a));
  const src = path.join(a, "src"); fs.mkdirSync(path.join(src, "work", "files"), { recursive: true });
  fs.writeFileSync(path.join(src, "work", "files", "doc.txt"), "mine");
  const key = "k"; const crypto = await import("node:crypto");
  const hm = s => crypto.createHmac("sha256", key).update(s).digest("hex");
  const seal = st => ({ ...st, mac: hm(JSON.stringify(st)) });
  const verify = st => { const { mac, ...r } = st || {}; return mac === hm(JSON.stringify(r)); };
  const sy = createSessionSync({ space: sp.sync, session: "s1", work: path.join(src, "work"), state: path.join(src, "state"), reader: localReaderFor(path.join(src, "work")), seal });
  await sy.line('{"type":"result"}'); assert.equal(await sy.checkpoint({ labels: { trust: "member" } }), true);
  const dst = () => { const d = path.join(a, "d" + Math.random().toString(36).slice(2)); fs.mkdirSync(path.join(d, "work", "files"), { recursive: true }); return { work: path.join(d, "work"), state: path.join(d, "state") }; };
  await assert.rejects(() => restore({ space: sp.sync, session: "s1", ...dst() }), /no way to verify/);
  await assert.rejects(() => restore({ space: sp.sync, session: "s1", ...dst(), verify: () => false }), /does not verify/);
  assert.equal((await restore({ space: sp.sync, session: "s1", ...dst(), verify })).turn, 1);
  // the space (or someone on the way) edits the file's version in the manifest, or the transcript, under a still-valid seal
  const cp = sp.state.checkpoints.get("s1");
  cp.manifest["files/doc.txt"].hash = "0".repeat(64);
  await assert.rejects(() => restore({ space: sp.sync, session: "s1", ...dst(), verify }), /does not verify/);
  cp.manifest["files/doc.txt"].hash = (await import("node:crypto")).createHash("sha256").update("mine").digest("hex");
  sp.state.transcript.get("s1")[0].line = '{"type":"result","forged":true}';
  await assert.rejects(() => restore({ space: sp.sync, session: "s1", ...dst(), verify }), /does not verify/);
});

// ---- Windows lending is out of 0.3 -------------------------------------------------------------------------------------

import { WINDOWS_LINE } from "./sandbox.js";
import { place } from "./placement.js";
test("Windows: lending is refused with one plain line, placement never says here, and nothing is reachable by accident", () => {
  const old = process.env.VYRE_WINDOWS_LENDING; delete process.env.VYRE_WINDOWS_LENDING;
  try {
    assert.equal(WINDOWS_LINE, "Running a space's work on this computer isn't available on Windows yet. Your sessions run on the space's server.");
    assert.equal(unavailable("win32"), WINDOWS_LINE);
    assert.equal(workspaceUnavailable("win32"), WINDOWS_LINE);
    assert.throws(() => driverFor("win32"), /isn't available on Windows yet/);
    const calm = { onPower: true, awake: true, cpuPct: 1, memPct: 1 };
    const p = place({ spaceAllows: true, memberAccepts: true, state: calm, runnerReady: unavailable("win32"), server: { available: true, hasRoom: true } });
    assert.equal(p.where, "server");
    assert.equal(place({ spaceAllows: true, memberAccepts: true, state: calm, runnerReady: unavailable("win32") }).where, "wait");
    assert.throws(() => createRunner({ platform: "win32", base: "/x", space: "s", device: "d", vault: {}, sync: {}, grants: () => ({}) }), /isn't available on Windows yet/);
  } finally { if (old !== undefined) process.env.VYRE_WINDOWS_LENDING = old; }
});

// ---- fscrypt, the kernel-native Linux workspace ------------------------------------------------------------------------

import { fscryptSupported } from "./workspace.js";
const FSDIR = process.env.VYRE_FSCRYPT_DIR || "";
test("fscrypt workspace: opens with the leased key, locks with no key, a wrong key never opens it", { skip: process.platform !== "linux" || !FSDIR || !fscryptSupported(FSDIR), timeout: 60_000 }, async t => {
  const base = fs.mkdtempSync(path.join(FSDIR, "fsc-")); t.after(() => rm(base));
  const drv = driverFor("linux", { prefer: "fscrypt" });
  assert.equal(drv.name, "fscrypt");
  const dir = path.join(base, "w"); const key = crypto_.randomBytes(32), wrong = crypto_.randomBytes(32);
  await drv.create(dir, key);
  const m = await drv.mount(dir, key);
  assert.equal(drv.isMounted(dir), true);
  fs.writeFileSync(path.join(m, "secret-name.txt"), "FSCRYPT-PLAINTEXT-4417");
  await drv.unmount(dir);
  assert.equal(drv.isMounted(dir), false);
  assert.throws(() => fs.readFileSync(path.join(m, "secret-name.txt")), /Required key|ENOKEY|EACCES|ENOENT|-126/);
  await assert.rejects(() => drv.mount(dir, wrong), /did not take|could not open/);
  assert.equal(drv.isMounted(dir), false);
  await drv.mount(dir, key);
  assert.equal(fs.readFileSync(path.join(m, "secret-name.txt"), "utf8"), "FSCRYPT-PLAINTEXT-4417");
  await drv.destroy(dir);
  assert.equal(fs.existsSync(dir), false);
});
import crypto_ from "node:crypto";

import { fscryptSetupPlan, SLOWER_LINE } from "./workspace.js";
test("fscrypt setup plan: ext4 needs one tune2fs, other filesystems fall back to gocryptfs with the slower line", () => {
  const fake = (out, status = 0) => () => ({ status, stdout: out }), no = () => false, yes = () => true;
  const ext4 = fscryptSetupPlan("/x", fake("ext4 /dev/vda1\n"), no);
  assert.equal(ext4.state, "needs-admin");
  assert.deepEqual(ext4.command, ["tune2fs", "-O", "encrypt", "/dev/vda1"]);
  assert.equal(ext4.fallback, "gocryptfs");
  const btrfs = fscryptSetupPlan("/x", fake("btrfs /dev/nvme0n1p2\n"), no);
  assert.deepEqual([btrfs.state, btrfs.fallback, btrfs.line], ["unsupported", "gocryptfs", SLOWER_LINE]);
  assert.equal(fscryptSetupPlan("/x", fake("", 1), no).state, "unsupported");
  assert.equal(fscryptSetupPlan("/x", fake("ext4 /dev/vda1\n"), yes).state, "ready");
});

test("lent network: provider-and-space only by default; the Space can allow the internet through the proxy (HTTPS_PROXY with the session token)", () => {
  const ws = tmp(); try {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const opts = { platform, workspace: ws, command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567, socket: path.join(ws, "e.sock") } };
    const off = plan(opts), on = plan({ ...opts, internet: { token: "tok" } });
    const env = p => (platform === "linux" ? Object.fromEntries(p.argv.reduce((a, x, i) => (x === "--setenv" ? a.concat([[p.argv[i + 1], p.argv[i + 2]]]) : a), [])) : p.env);
    assert.equal(env(off).HTTPS_PROXY, undefined);
    assert.match(env(on).HTTPS_PROXY, /^http:\/\/vyre:tok@127\.0\.0\.1:\d+$/);
  } finally { rm(ws); }
});

import { swapInfo, SWAP_LINE } from "./workspace.js";
import { spawnSync } from "node:child_process";
test("FS-1: swap or a hibernation image is detected and reported with one plain line", () => {
  const files = { "/proc/swaps": "Filename Type Size Used Priority\n/swapfile file 1048572 0 -2\n", "/sys/power/resume": "0:0\n" };
  const read = p => files[p] ?? "";
  assert.deepEqual(swapInfo({ platform: "linux", read }), { swap: true, hibernation: false, line: SWAP_LINE });
  assert.equal(swapInfo({ platform: "linux", read: p => (p === "/proc/swaps" ? "Filename Type Size Used Priority\n" : "0:0") }).line, "");
  assert.equal(swapInfo({ platform: "linux", read: p => (p === "/sys/power/resume" ? "259:3\n" : "Filename\n") }).hibernation, true);
  assert.equal(swapInfo({ platform: "darwin", read }).line, "", "macOS encrypts swap by default");
  assert.equal(swapInfo({ platform: "linux", read: p => (p === "/proc/swaps" ? "Filename Type Size Used Priority\n/dev/mapper/cryptswap1 partition 1 0 -2\n" : "0:0") }).swap, false, "dm-crypt swap is not a leak");
  assert.equal(swapInfo({ platform: "linux", read: p => (p === "/proc/swaps" ? "Filename Type Size Used Priority\n/dev/dm-1 partition 1 0 -2\n" : p === "/sys/block/dm-1/dm/uuid" ? "CRYPT-LUKS2-abc\n" : "0:0") }).swap, false);
  assert.equal(swapInfo({ platform: "linux", read: p => (p === "/proc/swaps" ? "Filename Type Size Used Priority\n/dev/dm-2 partition 1 0 -2\n" : p === "/sys/block/dm-2/dm/uuid" ? "LVM-xyz\n" : "0:0") }).swap, true, "plain LVM swap is");
});

test("FS-2: the session starts with umask 077", { skip: SKIP_UMASK() , timeout: 30_000 }, async t => {
  const ws = tmp(); t.after(() => rm(ws));
  fs.mkdirSync(path.join(ws, "files"), { recursive: true });
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const p = plan({ platform, workspace: ws, command: process.execPath, args: ["-e", 'const fs=require("fs");fs.writeFileSync("u.txt","x");console.log((fs.statSync("u.txt").mode&0o777).toString(8))'], readOnly: [path.dirname(process.execPath)], proxy: { port: 4567, socket: "" } });
  const c = launch(p, { cwd: p.cwd }); let out = ""; c.stdout.on("data", d => out += d); await new Promise(r => c.on("close", r));
  assert.equal(out.trim(), "600");
});
function SKIP_UMASK() { return !["darwin", "linux"].includes(process.platform) || unavailable() !== ""; }

test("FS-2: another user cannot read an fscrypt workspace, unlocked or locked, and the folders above it are 0700", { skip: process.platform !== "linux" || !FSDIR || !fscryptSupported(FSDIR) || spawnSync("sudo", ["-n", "true"]).status !== 0, timeout: 60_000 }, async t => {
  const base = fs.mkdtempSync(path.join(FSDIR, "fs2-")); t.after(() => rm(base));
  const drv = driverFor("linux", { prefer: "fscrypt" });
  const dir = path.join(base, "spaces", "w"); const key = crypto_.randomBytes(32);
  await drv.create(dir, key);
  const m = await drv.mount(dir, key);
  fs.writeFileSync(path.join(m, "a.txt"), "OWNER-ONLY");
  for (const d of [m, dir, path.dirname(dir)]) assert.equal(fs.statSync(d).mode & 0o077, 0, `${d} is owner-only`);
  const other = () => spawnSync("sudo", ["-n", "-u", "nobody", "cat", path.join(m, "a.txt")], { encoding: "utf8" });
  assert.notEqual(other().status, 0, "another user cannot read it while unlocked");
  await drv.unmount(dir);
  assert.notEqual(other().status, 0, "nor while locked");
  await drv.destroy(dir);
});

import { effectiveNetwork, LENT_NETWORK_DEFAULT } from "./runner.js";
test("lent network: the default is the internet, the Space can say provider, and the lender's cap always wins", () => {
  assert.equal(LENT_NETWORK_DEFAULT, "internet");
  assert.equal(effectiveNetwork(undefined, undefined), "internet");
  assert.equal(effectiveNetwork("provider", undefined), "provider");
  assert.equal(effectiveNetwork("internet", undefined), "internet");
  assert.equal(effectiveNetwork("internet", "provider"), "provider", "the lender's cap beats the Space");
  assert.equal(effectiveNetwork(undefined, "provider"), "provider");
  assert.equal(effectiveNetwork("provider", "internet"), "provider", "a lender saying internet does not widen the Space's setting");
  assert.equal(effectiveNetwork("bogus", undefined), "internet");
});

import { createEgress as mkEgress } from "./egress.js";
import netmod from "node:net";
import osmod from "node:os";
test("internet mode refusals: a changing answer, a redirect, the machine's own address, IPv6 private and mapped forms, CONNECT to a LAN address", async t => {
  const target = netmod.createServer(c => { c.on("error", () => {}); c.end("hi"); }); await new Promise(r => target.listen({ port: 0, host: "127.0.0.1" }, r)); t.after(() => target.close());
  const tp = target.address().port, dialed = [];
  let n = 0;
  // A name that answers public to the check and private on the next lookup: the proxy looked once and dialled what it checked.
  const eg = mkEgress({ routes: [], vault: {}, session: "s", token: "tok", internet: true, lookup: async h => (h === "flip.example" ? (n++ === 0 ? [{ address: "93.184.216.34" }] : [{ address: "10.0.0.1" }]) : h === "v6.example" ? [{ address: "fd00::5" }] : h === "map.example" ? [{ address: "::ffff:192.168.1.5" }] : h === "ll.example" ? [{ address: "fe80::1" }] : [{ address: "93.184.216.34" }]), dial: (ip, port) => { dialed.push(ip + ":" + port); return netmod.connect(tp, "127.0.0.1"); } });
  const { port } = await eg.listen(); t.after(() => eg.close());
  const ask = host => new Promise(res => { const s = netmod.connect(port, "127.0.0.1"); let b = ""; s.on("connect", () => s.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic ${Buffer.from("vyre:tok").toString("base64")}\r\n\r\n`)); s.on("data", d => { b += d; if (b.includes("\r\n")) { s.destroy(); res(b.split("\r\n")[0]); } }); s.on("error", () => res("error")); setTimeout(() => res("timeout"), 3000); });
  assert.match(await ask("flip.example:443"), / 200 /);
  assert.deepEqual(dialed, ["93.184.216.34:443"], "it dialled the address it checked, not a later answer");
  for (const h of ["v6.example:443", "map.example:443", "ll.example:443", "[fd00::1]:443", "[::ffff:10.0.0.1]:443", "169.254.169.254:80", "100.100.100.100:443"]) assert.match(await ask(h), / 403 /, h);
  const lan = Object.values(osmod.networkInterfaces()).flat().find(a => a && !a.internal && a.family === "IPv4");
  if (lan) assert.match(await ask(`${lan.address}:${tp}`), / 403 /, "this machine's own LAN address");
  // a redirect to a private address is the client's next request through the same proxy, and is refused there
  const redir = http.createServer((q, r) => { r.writeHead(302, { location: "http://10.0.0.1/secret" }); r.end(); }); await new Promise(r => redir.listen(0, "127.0.0.1", r)); t.after(() => redir.close());
  const eg2 = mkEgress({ routes: [], vault: {}, session: "s", token: "tok", internet: true, lookup: async h => [{ address: h === "10.0.0.1" ? "10.0.0.1" : "93.184.216.34" }] }); const e2 = await eg2.listen(); t.after(() => eg2.close());
  const get = url => new Promise(res => { const q = http.request({ hostname: "127.0.0.1", port: e2.port, path: url, headers: { host: new URL(url).host, "proxy-authorization": "Basic " + Buffer.from("vyre:tok").toString("base64") } }, m => { m.resume(); res(m.statusCode); }); q.on("error", () => res(0)); q.end(); });
  assert.equal(await get("http://10.0.0.1/secret"), 403, "the redirect target is refused when the client follows it");
});

test("FS-3: a folder that was already there is never chmodded, and a world-writable one above is refused", { skip: process.platform !== "linux" || !FSDIR || !fscryptSupported(FSDIR), timeout: 60_000 }, async t => {
  const outer = fs.mkdtempSync(path.join(FSDIR, "fs3-")); t.after(() => rm(outer));
  fs.chmodSync(outer, 0o755); fs.writeFileSync(path.join(outer, "other-file.txt"), "kept");
  const drv = driverFor("linux", { prefer: "fscrypt" });
  const dir = path.join(outer, "vyre", "spaces", "w");
  await drv.create(dir, crypto_.randomBytes(32));
  assert.equal(fs.statSync(outer).mode & 0o777, 0o755, "the pre-existing folder's mode is unchanged");
  assert.equal(fs.readFileSync(path.join(outer, "other-file.txt"), "utf8"), "kept");
  assert.equal(fs.statSync(path.join(outer, "vyre")).mode & 0o077, 0, "the folders it created are owner-only");
  await drv.destroy(dir);
  const open_ = fs.mkdtempSync(path.join(FSDIR, "fs3w-")); t.after(() => rm(open_)); fs.chmodSync(open_, 0o777);
  await assert.rejects(() => drv.create(path.join(open_, "spaces", "w"), crypto_.randomBytes(32)), /writable by other users/);
});
