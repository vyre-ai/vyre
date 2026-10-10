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
import { PLACE_SCRIPT } from "./server.js";
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
async function withAccounts(t, homes) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-"));
  const work = path.join(dir, "work");
  const acct = path.join(dir, "acct");
  fs.mkdirSync(work, { recursive: true });
  for (const uid of Object.keys(homes)) fs.mkdirSync(path.join(acct, uid), { recursive: true });
  const socket = path.join(dir, "s.sock");
  const ran = [], wiped = [];
  const stat = d => { const uid = path.basename(d); const h = homes[uid]; return h ? { isDirectory: () => true, isSymbolicLink: () => Boolean(h.link), uid: h.uid, ...(h.gid !== undefined ? { gid: h.gid } : {}), mode: 0o40000 | h.mode } : null; };
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [1002] },
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
