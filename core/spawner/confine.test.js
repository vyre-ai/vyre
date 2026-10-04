import "../../scripts/mac-test-guard.mjs";
// The packaged box's session confinement self-test (core/spawner/confine.js, confine-probe.sh): every refusal has a test, and the real probe script is run as the test's own user.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as nodeSpawn } from "node:child_process";
import { SCRATCH } from "../../test/scratch.mjs";
import { confineSelfTest, PROBE } from "./confine.js";

const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "cf-"));
/** A spawner stand-in that answers with the given probe output. */
const saying = (/** @type {string} */ text, extra = {}) => async () => { const p = /** @type {any} */ (new EventEmitter()); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => { p.emit("close", null); }; Object.assign(p, extra); setImmediate(() => { p.stdout.write(text); p.emit("close", 0); }); return p; };

test("confinement: a session as its own uid that reaches nothing and uses its project passes", async t => {
  const work = tmp(), a = tmp(), b = tmp(); t.after(() => { for (const d of [work, a, b]) fs.rmSync(d, { recursive: true, force: true }); });
  const r = await confineSelfTest({ cwd: work, vyreUid: 1000, out: [{ name: "Vyre's own home", path: a }, { name: "the vault and keys", path: b }], spawn: /** @type {any} */ (saying("uid 2001\nproject rw\ndenied 0\ndenied 1\n")) });
  assert.deepEqual(r.failures, []); assert.equal(r.ok, true); assert.equal(r.confined_by, "uid");
});

test("confinement: every refusal is named", async t => {
  const work = tmp(), a = tmp(), b = tmp(); t.after(() => { for (const d of [work, a, b]) fs.rmSync(d, { recursive: true, force: true }); });
  const out = [{ name: "Vyre's own home", path: a }, { name: "the daemon's socket", path: b }];
  const run = (/** @type {string} */ text, o = {}) => confineSelfTest({ cwd: work, vyreUid: 1000, out, spawn: /** @type {any} */ (saying(text)), ...o });
  assert.match((await run("uid 0\nproject rw\ndenied 0\ndenied 1\n")).failures[0], /as root/);
  assert.match((await run("uid 1000\nproject rw\ndenied 0\ndenied 1\n")).failures[0], /same user as Vyre/);
  assert.match((await run("uid 2001\nproject rw\nreached 0\ndenied 1\n")).failures[0], /can reach Vyre's own home/);
  assert.match((await run("uid 2001\nproject rw\ndenied 0\nreached 1\n")).failures[0], /can reach the daemon's socket/);
  assert.match((await run("uid 2001\nproject no\ndenied 0\ndenied 1\n")).failures[0], /cannot use its own project/);
  assert.match((await run("")).failures[0], /said nothing/);
  assert.match((await run("uid 2001\nproject rw\ndenied 0\n")).failures.join(" "), /did not answer for every protected path/);
  const missing = await confineSelfTest({ cwd: work, vyreUid: 1000, out: [{ name: "the vault and keys", path: path.join(work, "nope") }], spawn: /** @type {any} */ (saying("uid 2001\nproject rw\n")) });
  assert.equal(missing.ok, false); assert.match(missing.failures[0], /not where the box says it is/);
  const cant = await confineSelfTest({ cwd: work, vyreUid: 1000, out, spawn: async () => { throw new Error("spawner: account 2001 has no home"); } });
  assert.equal(cant.ok, false); assert.match(cant.failures[0], /could not start: spawner: account 2001 has no home/);
});

test("confinement: a probe that never answers is killed at the limit and fails the check", async t => {
  const work = tmp(); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const hang = async () => { const p = /** @type {any} */ (new EventEmitter()); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => { setImmediate(() => p.emit("close", null)); }; return p; };
  const t0 = Date.now();
  const r = await confineSelfTest({ cwd: work, vyreUid: 1000, out: [], spawn: /** @type {any} */ (hang), timeoutMs: 300 });
  assert.equal(r.ok, false); assert.ok(Date.now() - t0 < 5000);
});

test("confine-probe.sh, run for real as this user: reports its uid, the project, and what it can and cannot reach", { skip: process.platform === "win32" }, async t => {
  const work = tmp(), open = tmp();
  const closed = path.join(open, "closed"); fs.mkdirSync(closed, { mode: 0o000 });
  t.after(() => { try { fs.chmodSync(closed, 0o700); } catch {} for (const d of [work, open]) fs.rmSync(d, { recursive: true, force: true }); });
  const text = await new Promise(res => { let o = ""; const c = nodeSpawn(PROBE, ["allow", work, "deny", open, path.join(closed, "inner"), "/no/such/place"]); c.stdout.on("data", d => o += d); c.on("close", () => res(o)); });
  const lines = String(text).trim().split("\n");
  assert.equal(lines[0], `uid ${os.userInfo().uid}`);
  assert.equal(lines[1], "project rw");
  assert.equal(lines[2], "reached 0", "a folder this user can read is reached");
  if (os.userInfo().uid !== 0) assert.equal(lines[3], "denied 1", "a path inside a closed folder is not");
  assert.equal(lines[4], "denied 2");
  assert.deepEqual(fs.readdirSync(work), [], "the probe leaves nothing behind");
});
