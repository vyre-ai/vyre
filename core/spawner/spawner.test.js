// @ts-check
// The spawner and its client, as the same uid (no root here): the protocol, what it refuses, the
// environment it passes, and kill. The uid change itself (setpriv) is checked in the box image by
// scripts/e2e-headscale.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serve } from "./server.js";
import { spawnAsAgent, wipeAccount, shareTranscript, placeTranscript } from "./client.js";
import { PLACE_SCRIPT, SKILLS_SEED_SCRIPT, SKILLS_PRUNE_SCRIPT } from "./server.js";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { SCRATCH } from "../../test/scratch.mjs";

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-"));
  const work = path.join(dir, "work");
  fs.mkdirSync(path.join(work, "northwind"), { recursive: true });
  // Unix socket paths are short: keep it near the root of the scratch folder.
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work,
    agent: { uid: 0, gid: 0, groups: [] }, wrap: argv => argv });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, work, srv };
}

const collect = stream => new Promise(resolve => { let out = ""; stream.setEncoding("utf8"); stream.on("data", d => (out += d)); stream.on("end", () => resolve(out)); });
const exited = p => new Promise(resolve => p.once("exit", (code, signal) => resolve({ code, signal })));

test("spawner: a session child's stdin, stdout, stderr and exit ride the connections", async t => {
  const { socket, work } = await setup(t);
  const p = await spawnAsAgent(["/bin/sh", "-c", 'read line; echo "got $line"; echo "$VYRE_THREAD ${LD_PRELOAD:-none} $(pwd)"; echo oops >&2; exit 3'],
    { socket, cwd: path.join(work, "northwind"), env: { VYRE_THREAD: "t1", LD_PRELOAD: "/tmp/evil.so", PATH: "/usr/bin:/bin" } });
  assert.ok(Number.isInteger(p.pid) && p.pid > 1);
  const out = collect(p.stdout), err = collect(p.stderr), done = exited(p);
  p.stdin.write("hello\n");
  p.stdin.end();
  assert.deepEqual(await done, { code: 3, signal: null });
  assert.equal(await out, `got hello\nt1 none ${fs.realpathSync(path.join(work, "northwind"))}\n`, "LD_PRELOAD never reaches the child");
  assert.equal(await err, "oops\n");
});

test("spawner: only allowed programs, only under the work folder", async t => {
  const { socket, work } = await setup(t);
  await assert.rejects(spawnAsAgent(["/usr/bin/env", "true"], { socket, cwd: work }), /not a program the spawner starts/);
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: "/etc" }), /cwd must be under/);
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: path.join(work, "..", "elsewhere") }), /cwd must be under/);
});

test("spawner: kill ends the child's whole group, including what it left in the background", async t => {
  const { socket, work, srv } = await setup(t);
  const marker = path.join(work, "still-running");
  const p = await spawnAsAgent(["/bin/sh", "-c", `(sleep 2; touch ${marker}) & sleep 30`], { socket, cwd: work });
  const done = exited(p);
  p.kill("SIGTERM");
  const r = await done;
  assert.equal(r.signal, "SIGTERM");
  await new Promise(r2 => setTimeout(r2, 2500));
  assert.ok(!fs.existsSync(marker), "the background child went with the group");
  assert.equal(srv.live(), 0);
});

test("spawner: its socket is the owner's alone", async t => {
  const { socket } = await setup(t);
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
});

// ---- one uid per account (ADR 0030 phase 2, reviewer-2's B1)

/** A spawner with account uids 2000-2063 and a HOME stat the test controls; wrap records who each child would run as. */
async function withAccounts(t, homes, allow = ["/bin/sh"]) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-"));
  const work = path.join(dir, "work");
  const acct = path.join(dir, "acct");
  fs.mkdirSync(work, { recursive: true });
  for (const uid of Object.keys(homes)) fs.mkdirSync(path.join(acct, uid), { recursive: true });
  const socket = path.join(dir, "s.sock");
  const ran = [], wiped = [];
  const stat = d => { const uid = path.basename(d); const h = homes[uid]; return h ? { isDirectory: () => true, isSymbolicLink: () => Boolean(h.link), uid: h.uid, ...(h.gid !== undefined ? { gid: h.gid } : {}), mode: 0o40000 | h.mode } : null; };
  const srv = await serve({ socket, allow, work, agent: { uid: 1001, gid: 1001, groups: [1002] },
    wrap: (argv, cwd, who) => { ran.push(who); return argv; },
    accounts: { min: 2000, max: 2063, home: acct, shared: [1002], stat, wipe: (d, who) => wiped.push([d, who.uid]) } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, work, acct, ran, wiped };
}

test("spawner accounts: a session for an account runs as that uid and gid, in its own HOME, in no group unless it is project work", async t => {
  const { socket, work, acct, ran } = await withAccounts(t, { 2000: { uid: 2000, mode: 0o700 }, 2001: { uid: 2001, mode: 0o700 } });
  const p = await spawnAsAgent(["/bin/sh", "-c", 'echo "$HOME $USER"'], { socket, cwd: path.join(acct, "2000"), account: 2000 });
  assert.equal(await collect(p.stdout), `${path.join(acct, "2000")} acct2000\n`);
  const q = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2001, shared: true });
  await exited(q);
  assert.deepEqual(ran.map(w => [w.uid, w.gid, w.groups]), [[2000, 2000, []], [2001, 2001, [1002]]]);
  // Not the agent's own uid: the plain path is unchanged.
  const a = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work });
  await exited(a);
  assert.deepEqual([ran[2].uid, ran[2].gid, ran[2].groups], [1001, 1001, [1002]]);
});

test("spawner accounts: a uid outside the range, a missing or someone else's or group-readable or symlinked HOME is refused before anything starts", async t => {
  const { socket, work, ran } = await withAccounts(t, { 2000: { uid: 2000, mode: 0o700 }, 2002: { uid: 2001, mode: 0o700 }, 2003: { uid: 2003, mode: 0o750 }, 2004: { uid: 2004, mode: 0o700, link: true } });
  for (const [account, why] of [[1001, /account must be a uid from 2000 to 2063/], [0, /account must be a uid/], [2064, /account must be a uid/], [2010, /has no home/],
    [2002, /not private to it/], [2003, /not private to it/], [2004, /has no home/]]) {
    await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account }), why, `account ${account}`);
  }
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: /** @type {any} */ ("2000") }), /account is a uid/);
  // Another account's home is never a place this one may work in.
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: path.join(path.dirname(work), "acct", "2003"), account: 2000 }), /cwd must be under/);
  assert.deepEqual(ran, [], "nothing was ever started");
});

test("spawner accounts: a spawner with no account range refuses an account; wipe empties a HOME, and not while a session of it runs", async t => {
  const { socket } = await setup(t);
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, account: 2000 }), /account must be a uid/);
  const w = await withAccounts(t, { 2000: { uid: 2000, mode: 0o700 } });
  const busy = await spawnAsAgent(["/bin/sh", "-c", "sleep 30"], { socket: w.socket, cwd: w.work, account: 2000 });
  await assert.rejects(wipeAccount(2000, { socket: w.socket }), /still has a session running/);
  busy.kill("SIGKILL");
  await exited(busy);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await wipeAccount(2000, { socket: w.socket }), true);
  assert.deepEqual(w.wiped, [[path.join(w.acct, "2000"), 2000]]);
  await assert.rejects(wipeAccount(2999, { socket: w.socket }), /account must be a uid/);
});

test("spawner accounts: a HOME open to its own group for walking in (710) is fine; open to another group, or readable, is not", async t => {
  const { socket, work } = await withAccounts(t, { 2000: { uid: 2000, gid: 2000, mode: 0o710 }, 2001: { uid: 2001, gid: 1000, mode: 0o710 }, 2002: { uid: 2002, gid: 2002, mode: 0o750 } });
  await exited(await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000 }));
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2001 }), /not private to it/);
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2002 }), /not private to it/);
});

test("spawner accounts: seed files are for an account, stay inside its HOME, and are written by the seed hook before the child starts", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-"));
  const work = path.join(dir, "work"), acct = path.join(dir, "acct");
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(acct, "2000"), { recursive: true });
  const written = [];
  const socket = path.join(dir, "s.sock");
  const stat = () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 2000, mode: 0o40700 });
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [] }, wrap: argv => argv,
    seed: (home, who, files) => written.push([home, who.uid, files]),
    accounts: { min: 2000, max: 2063, home: acct, shared: [], stat } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Without an account the client sends no seed at all, so nothing is ever written for the shared agent.
  await exited(await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, seed: { "a": "b" } }));
  assert.deepEqual(written, []);
  for (const bad of [{ "../x": "y" }, { "/etc/x": "y" }, { a: 1 }]) await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000, seed: /** @type {any} */ (bad) }), /seed is up to 8/);
  const p = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000, seed: { ".grok/config.toml": "x = 1\n" } });
  await exited(p);
  assert.deepEqual(written, [[path.join(acct, "2000"), 2000, { ".grok/config.toml": "x = 1\n" }]]);
});

test("spawner share: only one .jsonl under the account's own .claude/projects is made group-readable; any other path, account or shape is refused", async t => {
  const shared = [];
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const acct = path.join(dir, "acct"); fs.mkdirSync(path.join(acct, "2000"), { recursive: true }); fs.mkdirSync(path.join(acct, "2001"), { recursive: true });
  const stat = d => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: Number(path.basename(d)), mode: 0o40700 });
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work: path.join(dir, "work"), agent: { uid: 1001, gid: 1001, groups: [1002] }, accounts: { min: 2000, max: 2063, home: acct, shared: [1002], stat, share: (home, who, file) => shared.push([who.uid, file]) } });
  t.after(() => srv.close());
  const good = path.join(acct, "2000", ".claude", "projects", "p", "s1.jsonl");
  assert.equal(await shareTranscript(2000, good, { socket }), true);
  assert.deepEqual(shared, [[2000, good]]);
  await assert.rejects(shareTranscript(2001, good, { socket }), /only a \.jsonl under the account's own/);   // another account's file
  await assert.rejects(shareTranscript(2000, path.join(acct, "2000", ".claude", "projects", "p", "s1.txt"), { socket }), /only a \.jsonl/);
  await assert.rejects(shareTranscript(2000, path.join(acct, "2000", ".claude", ".credentials.json"), { socket }), /only a \.jsonl/);
  await assert.rejects(shareTranscript(2000, path.join(acct, "2000", ".claude", "projects", "..", "..", "x.jsonl"), { socket }), /only a \.jsonl/);
  await assert.rejects(shareTranscript(2999, good, { socket }), /account must be a uid/);
  assert.equal(shared.length, 1, "nothing else was shared");
});

test("spawner place: one plain transcript of the account itself, whole, checked against its hash; another account, a path out of the projects folder, a wrong hash or size, and a bad shape are refused", async t => {
  const placed = /** @type {any[]} */ ([]);
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const acct = path.join(dir, "acct"); fs.mkdirSync(path.join(acct, "2000"), { recursive: true }); fs.mkdirSync(path.join(acct, "2001"), { recursive: true });
  const stat = (/** @type {string} */ d) => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: Number(path.basename(d)), mode: 0o40700 });
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work: path.join(dir, "work"), agent: { uid: 1001, gid: 1001, groups: [1002] }, accounts: { min: 2000, max: 2063, home: acct, shared: [1002], stat, place: (home, who, file, bytes) => placed.push([who.uid, file, bytes.toString()]) } });
  t.after(() => srv.close());
  const good = path.join(acct, "2000", ".claude", "projects", "-work-acme", "s1.jsonl");
  assert.equal(await placeTranscript(2000, good, Buffer.from('{"a":1}\n{"b":2}\n'), { socket }), true);
  assert.deepEqual(placed, [[2000, good, '{"a":1}\n{"b":2}\n']]);
  await assert.rejects(placeTranscript(2001, good, Buffer.from("x"), { socket }), /only <HOME>\/\.claude\/projects/);   // another account's file
  for (const bad of [path.join(acct, "2000", ".claude", "settings.json"), path.join(acct, "2000", ".claude", "projects", "p", "s.txt"), path.join(acct, "2000", ".claude", "projects", "..", "x", "s.jsonl"), path.join(acct, "2000", ".claude", "projects", "a", "b", "s.jsonl"), path.join(acct, "2000", ".claude", "projects", "s.jsonl"), path.join(acct, "2000", ".claude", "projects", ".", "s.jsonl")]) await assert.rejects(placeTranscript(2000, bad, Buffer.from("x"), { socket }), /only <HOME>/, bad);
  await assert.rejects(placeTranscript(2999, good, Buffer.from("x"), { socket }), /account must be a uid/);
  // the hash and the size are the request's own
  const c = await new Promise(res => { const s = net.connect(socket, () => res(s)); });
  /** @type {any} */ const ans = await new Promise(res => { let o = ""; c.on("data", d => { o += d; }); c.on("end", () => res(JSON.parse(o.split("\n")[0]))); c.write(JSON.stringify({ op: "place", account: 2000, path: good, size: 3, sha256: "0".repeat(64) }) + "\n" + "abc"); });
  assert.match(ans.error, /does not match its sha256/);
  const big = await new Promise(res => { const s = net.connect(socket, () => res(s)); });
  /** @type {any} */ const ans2 = await new Promise(res => { let o = ""; big.on("data", d => { o += d; }); big.on("end", () => res(JSON.parse(o.split("\n")[0]))); big.write(JSON.stringify({ op: "place", account: 2000, path: good, size: 64 * 1024 * 1024 + 1, sha256: "0".repeat(64) }) + "\n"); });
  assert.match(ans2.error, /1 byte to 64 MiB/);
  assert.equal(placed.length, 1, "nothing else was placed");
});

test("spawner place, the real script (run as the current user): 0600, whole, the account's own folder only; a link anywhere, another owner's folder or a non-file target is refused", { skip: process.platform !== "linux" }, t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-place-"))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const uid = String(process.getuid());
  const run = (/** @type {string} */ file, /** @type {string} */ body, /** @type {string} */ owner = uid) => spawnSync("/bin/sh", ["-c", PLACE_SCRIPT, "sh", file, owner], { input: body });
  const f = path.join(dir, "projects", "-work-a", "s1.jsonl");
  assert.equal(run(f, "one\ntwo\n").status, 0);
  assert.equal(fs.readFileSync(f, "utf8"), "one\ntwo\n");
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), "600", "0600");
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["s1.jsonl"], "no temp file is left");
  assert.equal(run(f, "three\n").status, 0); assert.equal(fs.readFileSync(f, "utf8"), "three\n", "replaced whole");
  // a link as the file, as the folder, or in the way
  const other = path.join(dir, "elsewhere"); fs.mkdirSync(other);
  fs.symlinkSync(path.join(other, "target.jsonl"), path.join(dir, "projects", "-work-a", "link.jsonl"));
  assert.equal(run(path.join(dir, "projects", "-work-a", "link.jsonl"), "x").status, 11);
  fs.symlinkSync(other, path.join(dir, "projects", "-work-b"));
  assert.equal(run(path.join(dir, "projects", "-work-b", "s.jsonl"), "x").status, 11);
  assert.deepEqual(fs.readdirSync(other), [], "nothing was written through a link");
  fs.symlinkSync(other, path.join(dir, "up")); assert.notEqual(run(path.join(dir, "up", "-work-c", "s.jsonl"), "x").status, 0, "a linked parent");
  assert.deepEqual(fs.readdirSync(other), [], "or through a linked parent");
  // another account's folder, and a directory where the file should be
  assert.equal(run(f, "x", String(process.getuid() + 1)).status, 13);
  fs.mkdirSync(path.join(dir, "projects", "-work-a", "d.jsonl")); assert.equal(run(path.join(dir, "projects", "-work-a", "d.jsonl"), "x").status, 14);
});

test("the daemon's own-server host places a transcript through the spawner and makes it readable for the seal (the packaged box carries a chat on from a computer)", async t => {
  const { createOwnServerHost } = await import("../daemon/ownserver-host.js");
  /** @type {any[]} */ const log = [];
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const acct = path.join(dir, "acct"); fs.mkdirSync(path.join(acct, "2000"), { recursive: true });
  const stat = (/** @type {string} */ d) => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: Number(path.basename(d)), mode: 0o40700 });
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work: path.join(dir, "work"), agent: { uid: 1001, gid: 1001, groups: [1002] }, accounts: { min: 2000, max: 2063, home: acct, shared: [1002], stat,
    place: (home, who, file, bytes) => { log.push(["place", who.uid, file, bytes.toString()]); }, share: (home, who, file) => { log.push(["share", who.uid, file]); } } });
  t.after(() => srv.close());
  const host = createOwnServerHost({ kernel: { id: { space: "spc_aaaaaaaaaaaa", owner: "per_o" }, chains: {}, gateway: {} }, registry: {}, root: dir, spawnerSocket: socket });
  const file = path.join(acct, "2000", ".claude", "projects", "-srv-acme", "s1.jsonl");
  await host.place(2000, file, Buffer.from("one\ntwo\n"));
  assert.deepEqual(log, [["place", 2000, file, "one\ntwo\n"], ["share", 2000, file]], "placed, then shared for the seal, in that order");
  await assert.rejects(host.place(2001, file, Buffer.from("x")), /only <HOME>/);
});

/** A spawner with accounts 2000 and 2001 whose `place` is the test's own (it may be slow). */
async function placing(t, place) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const acct = path.join(dir, "acct"), work = path.join(dir, "work"); for (const u of ["2000", "2001"]) fs.mkdirSync(path.join(acct, u), { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const stat = (/** @type {string} */ d) => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: Number(path.basename(d)), mode: 0o40700 });
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [1002] }, wrap: (argv) => argv, accounts: { min: 2000, max: 2063, home: acct, shared: [1002], stat, share: () => {}, place } });
  t.after(() => srv.close());
  const file = (/** @type {string} */ u, n = "s1") => path.join(acct, u, ".claude", "projects", "p", `${n}.jsonl`);
  return { socket, acct, work, file };
}

test("spawner place (trust rows 23-25): a slow write does not hold the spawner still, an account with a running session is refused, only two at a time, and a client that goes away frees its place", async t => {
  /** @type {(() => void)[]} */ const release = [];
  const w = await placing(t, () => new Promise(res => { release.push(() => res(undefined)); }));
  // 23: while a place is being written, another connection is answered at once (the spawner relays every live session)
  const slow = placeTranscript(2000, w.file("2000"), Buffer.from("a"), { socket: w.socket });
  await new Promise(r => setTimeout(r, 150));
  const t0 = Date.now();
  assert.equal(await shareTranscript(2001, w.file("2001"), { socket: w.socket }), true);
  assert.ok(Date.now() - t0 < 100, `an other call was answered while a place was being written (${Date.now() - t0} ms)`);
  let done = false; slow.then(() => { done = true; });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(done, false, "and the place is not reported done until it is written");
  // 25: two at a time
  const second = placeTranscript(2001, w.file("2001"), Buffer.from("b"), { socket: w.socket });
  await new Promise(r => setTimeout(r, 150));
  await assert.rejects(placeTranscript(2000, w.file("2000", "s2"), Buffer.from("c"), { socket: w.socket }), /placing other transcripts/);
  for (const r of release.splice(0)) r();
  assert.equal(await slow, true); assert.equal(await second, true);
  // 25: a client that leaves mid-body frees its place
  for (let k = 0; k < 3; k++) {
    const c = await new Promise(res => { const s = net.connect(w.socket, () => res(s)); });
    c.write(JSON.stringify({ op: "place", account: 2000, path: w.file("2000", `g${k}`), size: 1000, sha256: "0".repeat(64) }) + "\n" + "partial"); await new Promise(r => setTimeout(r, 80)); c.destroy();
  }
  await new Promise(r => setTimeout(r, 100));
  const again = placeTranscript(2000, w.file("2000", "after"), Buffer.from("z"), { socket: w.socket }); await new Promise(r => setTimeout(r, 100)); for (const r of release.splice(0)) r();
  assert.equal(await again, true, "the abandoned ones left nothing counted");
  // 24: a running session of that account: refused; of another account or none: placed
  const live = await spawnAsAgent(["/bin/sh", "-c", "sleep 3"], { socket: w.socket, cwd: w.work, account: 2000, shared: true });
  await assert.rejects(placeTranscript(2000, w.file("2000", "busy"), Buffer.from("x"), { socket: w.socket }), /still has a session running/);
  const other = placeTranscript(2001, w.file("2001", "fine"), Buffer.from("x"), { socket: w.socket }); await new Promise(r => setTimeout(r, 100)); for (const r of release.splice(0)) r();
  assert.equal(await other, true, "another account is not held up by it");
  live.kill(); await exited(live);
});

test("spawner place, the real setpriv call (root on Linux only): the file belongs to the account, 0600, written whole", { skip: process.platform !== "linux" || process.getuid?.() !== 0 || !fs.existsSync("/usr/bin/setpriv") }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const acct = path.join(dir, "acct"), home = path.join(acct, "2000"); fs.mkdirSync(home, { recursive: true }); fs.chownSync(home, 2000, 2000); fs.chmodSync(home, 0o700); fs.chmodSync(acct, 0o755); fs.chmodSync(dir, 0o755);
  const stat = (/** @type {string} */ d) => fs.statSync(d);
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work: path.join(dir, "work"), agent: { uid: 1001, gid: 1001, groups: [] }, accounts: { min: 2000, max: 2063, home: acct, shared: [], stat } });
  t.after(() => srv.close());
  const file = path.join(home, ".claude", "projects", "p", "s1.jsonl");
  assert.equal(await placeTranscript(2000, file, Buffer.from("one\ntwo\n"), { socket }), true);
  const st = fs.statSync(file);
  assert.deepEqual([st.uid, st.mode & 0o777, fs.readFileSync(file, "utf8")], [2000, 0o600, "one\ntwo\n"]);
});

// A client terminal (an ACP agent's terminal/create, after Vyre's floor judged the command) is the one place `/bin/sh` is started, under role "terminal" and as an account's uid. The allow list stays what the image names.
const NO_SHELL = ["/usr/bin/true"];
test("spawner terminal: role terminal runs `/bin/sh -c <line>` as the account's uid in its HOME, with no credential in its environment, though /bin/sh is not on the allow list", async t => {
  const { socket, acct, ran } = await withAccounts(t, { 2000: { uid: 2000, mode: 0o700 } }, NO_SHELL);
  const p = await spawnAsAgent(["/bin/sh", "-c", 'echo "$HOME|$USER|${ANTHROPIC_API_KEY:-nokey}|${OPENAI_API_KEY:-nokey}|${MY_TOKEN:-notoken}|${CLAUDE_CODE_OAUTH_TOKEN:-nooauth}|${LD_PRELOAD:-nopreload}"'],
    { socket, cwd: path.join(acct, "2000"), account: 2000, role: "terminal", env: { ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", MY_TOKEN: "tk", CLAUDE_CODE_OAUTH_TOKEN: "oa", LD_PRELOAD: "/tmp/x.so", PATH: "/usr/bin:/bin" } });
  assert.equal(await collect(p.stdout), `${path.join(acct, "2000")}|acct2000|nokey|nokey|notoken|nooauth|nopreload\n`);
  await exited(p);
  assert.deepEqual(ran.map(w => [w.uid, w.gid, w.groups]), [[2000, 2000, []]], "as that account's uid, in no supplementary group");
});

test("spawner terminal: /bin/sh without the terminal role is refused as before, and the role starts nothing but one shell line as an account", async t => {
  const { socket, acct } = await withAccounts(t, { 2000: { uid: 2000, mode: 0o700 } }, NO_SHELL);
  const cwd = path.join(acct, "2000");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd, account: 2000 }), /\/bin\/sh is not a program the spawner starts/, "no role: refused");
  await assert.rejects(spawnAsAgent(["/usr/bin/env", "true"], { socket, cwd, account: 2000, role: "terminal" }), /a terminal runs \/bin\/sh -c and one command line/, "another program under the role");
  await assert.rejects(spawnAsAgent(["/usr/bin/true"], { socket, cwd, account: 2000, role: "terminal" }), /a terminal runs/, "even an allowed program is not a terminal");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-lc", "true"], { socket, cwd, account: 2000, role: "terminal" }), /a terminal runs/, "a login shell flag");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true", "extra"], { socket, cwd, account: 2000, role: "terminal" }), /a terminal runs/, "more arguments");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd, role: "terminal" }), /a terminal runs as an account/, "not as the agent's own uid");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd, account: 2000, shared: true, fd3: "k", role: "terminal" }), /takes no fd3 or seed/, "no credential descriptor even with the shared flag");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd, account: 2000, fd3: "sk-secret", role: "terminal" }), /takes no fd3 or seed/, "no credential descriptor");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd, account: 2000, seed: { "a.txt": "x" }, role: "terminal" }), /takes no fd3 or seed/, "no seed files");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: "/etc", account: 2000, role: "terminal" }), /cwd must be under/, "the same folder rule");
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd, account: 2999, role: "terminal" }), /account must be a uid from/, "the same account range");
});

// The request a REAL session's terminal makes: spawnSession with the account the Switchboard gives it ({ uid, shared } with `shared` a boolean, false or true) and the credential the session holds in its
// environment. The earlier terminal tests used a bare account number, so a flag only a real session sends reached the spawner for the first time on a real install (walk-7b): refused as "takes no fd3, seed or shared".
for (const shared of [false, true]) {
  test(`a real session's terminal (account { uid, shared: ${shared} }, a picked credential in its environment) runs as the account, holding no credential`, async t => {
    const { spawnSession } = await import("../sessions/spawn.js");
    const { socket, acct, ran } = await withAccounts(t, { 2000: { uid: 2000, mode: 0o700 } }, NO_SHELL);
    const env = { PATH: "/usr/bin:/bin", HOME: path.join(acct, "2000"), ANTHROPIC_API_KEY: "sk-ant-api03-stand-in", CLAUDE_CODE_OAUTH_TOKEN: "oat-stand-in", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3", VYRE_SOCKET: "/run/x.sock" };
    const p = spawnSession("/bin/sh", ["-c", 'echo "${ANTHROPIC_API_KEY:-nokey}|${CLAUDE_CODE_OAUTH_TOKEN:-nooauth}|${CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR:-nofd}|$(if { true <&3; } 2>/dev/null; then echo fd3open; else echo fd3closed; fi)"'],
      { cwd: path.join(acct, "2000"), env, account: { uid: 2000, shared }, spawner: true, spawnerSocket: socket, terminal: true, seed: { "a.txt": "x" } });
    let out = ""; p.stdout.on("data", (/** @type {any} */ d) => { out += d; });
    const code = await new Promise(res => p.on("close", res));
    assert.equal(code, 0, "the shell ran: " + out);
    assert.match(out, /^nokey\|nooauth\|nofd\|/, "no credential in its environment");
    assert.match(out, /fd3closed/, "and no descriptor 3: " + out);
    assert.deepEqual(ran.map(w => [w.uid, w.groups.length]), [[2000, shared ? 1 : 0]], "as the account, in the shared group only when its session is");
  });
}

test("spawner accounts: an account's approved skills are one content id under .vyre-skills/, capped before any write; a traversal, a second id or an oversized set is refused in words", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-"));
  const work = path.join(dir, "work"), acct = path.join(dir, "acct");
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(acct, "2000"), { recursive: true });
  /** @type {any[]} */ const written = [];
  const socket = path.join(dir, "s.sock");
  const stat = () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 2000, mode: 0o40700 });
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [] }, wrap: argv => argv, seed: (home, who, files) => written.push(files), accounts: { min: 2000, max: 2063, home: acct, shared: [], stat } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ID = "0123456789abcdef", spawn1 = (/** @type {any} */ seed) => spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000, seed });
  const set = (/** @type {number} */ n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`.vyre-skills/${ID}/skills/s${i}/SKILL.md`, `skill ${i}\n`]));
  await exited(await spawn1(set(40)));
  assert.equal(written.length, 1, "a set of 40 files (far over the 8 of an ordinary seed) is accepted");
  assert.equal(Object.keys(written[0]).length, 40);
  const refused = [
    ["a traversal key", { [`.vyre-skills/${ID}/../../x`]: "y" }], ["a dot segment", { [`.vyre-skills/${ID}/./x`]: "y" }], ["an absolute key", { "/.vyre-skills/x": "y" }],
    ["an id that is not a content id", { ".vyre-skills/../x": "y" }, ".vyre-skills/notanid/skills/a/SKILL.md"], ["two ids", { [`.vyre-skills/${ID}/a`]: "y", ".vyre-skills/fedcba9876543210/b": "y" }],
    ["too many files", set(129)], ["one file over its cap", { [`.vyre-skills/${ID}/big`]: "x".repeat(65537) }],
    ["a set over the total", Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`.vyre-skills/${ID}/f${i}`, "x".repeat(60000)]))],
  ];
  for (const [what, seed, extra] of /** @type {any[]} */ (refused)) {
    await assert.rejects(spawn1(extra ? { [extra]: "y" } : seed), /seed is up to 8|a skills set is one content id/, what);
  }
  await assert.rejects(spawn1(set(129)), /send a smaller set/, "an oversized set is refused in words that name the next step");
  assert.equal(written.length, 1, "and nothing was written for any refused one");
});

test("skills seed scripts, as the writing user: files 0600 and folders 0700, a link is refused or removed and never followed, other sets are pruned", t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-skills-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const h = fs.realpathSync(home), ID = "0123456789abcdef";
  const put = (/** @type {string} */ rel, /** @type {string} */ text) => spawnSync("/bin/sh", ["-c", SKILLS_SEED_SCRIPT, "sh", path.join(h, rel), h], { input: text });
  assert.equal(put(`.vyre-skills/${ID}/skills/okafor/SKILL.md`, "BLUEBIRD-77").status, 0);
  const mode = (/** @type {string} */ f) => fs.statSync(path.join(h, f)).mode & 0o777;
  assert.equal(fs.readFileSync(path.join(h, `.vyre-skills/${ID}/skills/okafor/SKILL.md`), "utf8"), "BLUEBIRD-77");
  assert.equal(mode(`.vyre-skills/${ID}/skills/okafor/SKILL.md`), 0o600, "a file is 0600");
  assert.equal(mode(`.vyre-skills/${ID}/skills`), 0o700, "a folder is 0700");
  assert.equal(mode(".vyre-skills"), 0o700);
  // a folder that is a link is refused, and nothing is written through it
  const outside = fs.mkdtempSync(path.join(SCRATCH, "vyre-outside-")); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(h, ".vyre-skills", "aaaaaaaaaaaaaaaa"));
  assert.notEqual(put(".vyre-skills/aaaaaaaaaaaaaaaa/skills/x", "NO").status, 0, "a folder that is a link is refused");
  assert.deepEqual(fs.readdirSync(outside), [], "and nothing reached the folder it points at");
  // a file that is a link is refused, and nothing is written through it
  const target = path.join(outside, "target"); fs.writeFileSync(target, "KEEP");
  fs.symlinkSync(target, path.join(h, ".vyre-skills", ID, "skills", "okafor", "LINK.md"));
  assert.equal(put(`.vyre-skills/${ID}/skills/okafor/LINK.md`, "NEW").status, 11, "a file that is a link is refused");
  assert.equal(fs.readFileSync(target, "utf8"), "KEEP", "a link is never written through");
  // a path outside the HOME is refused
  assert.notEqual(spawnSync("/bin/sh", ["-c", SKILLS_SEED_SCRIPT, "sh", path.join(outside, "x"), h], { input: "NO" }).status, 0, "outside the HOME is refused");
  // pruning keeps the one set and removes the others, links included, without following them
  fs.mkdirSync(path.join(h, ".vyre-skills", "fedcba9876543210", "skills"), { recursive: true });
  assert.equal(spawnSync("/bin/sh", ["-c", SKILLS_PRUNE_SCRIPT, "sh", h, ID]).status, 0);
  assert.deepEqual(fs.readdirSync(path.join(h, ".vyre-skills")).sort(), [ID], "only the current set stays");
  // the sets of other running sessions are named too, and stay
  fs.mkdirSync(path.join(h, ".vyre-skills", "1111111111111111")); fs.mkdirSync(path.join(h, ".vyre-skills", "2222222222222222")); fs.mkdirSync(path.join(h, ".vyre-skills", "3333333333333333"));
  assert.equal(spawnSync("/bin/sh", ["-c", SKILLS_PRUNE_SCRIPT, "sh", h, ID, "1111111111111111", "2222222222222222"]).status, 0);
  assert.deepEqual(fs.readdirSync(path.join(h, ".vyre-skills")).sort(), [ID, "1111111111111111", "2222222222222222"].sort(), "a named set stays, an unnamed one goes");
  assert.ok(fs.existsSync(target) && fs.readFileSync(target, "utf8") === "KEEP", "and nothing a link pointed at was touched");
});
