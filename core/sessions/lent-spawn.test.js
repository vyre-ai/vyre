// @ts-check
// A chat's agent process on a lent computer, with the box as the way back (team/contracts/lent-spawn.md): the one object the SDK holds, what it does when the lender never starts, and the real home and wire under it.
import "../../scripts/mac-test-guard.mjs";
import "../runner/testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lentOrBox, lentSpawnFor } from "./lent-spawn.js";
import { spawnSession } from "./spawn.js";
import { rig, BOB } from "../runner/testing/lent-rig.js";
import { lentSpawnFixtures as F, SESSION } from "../../test/contracts/lent-spawn.fixtures.js";

/** A ChildProcess-shaped stand-in that records what it was written. */
function fake() {
  const p = /** @type {any} */ (new EventEmitter());
  Object.assign(p, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 0, killed: false, killedWith: /** @type {string | null} */ (null), got: "" });
  p.stdin.on("data", (/** @type {Buffer} */ c) => { p.got += c.toString(); });
  p.kill = (/** @type {string} */ s = "SIGTERM") => { p.killedWith = s; return true; };
  return p;
}
const tick = () => new Promise(r => setTimeout(r, 20));
const readAll = (/** @type {any} */ s) => new Promise(res => { let b = ""; s.on("data", (/** @type {Buffer} */ c) => { b += c; }); s.on("end", () => res(b)); });

test("the lender's process is up: everything written, before and after, goes down to it once, and the box starts nothing", async () => {
  const lent = fake(); lent.lent = { session: SESSION, epoch: 1 };
  let boxed = 0;
  const p = lentOrBox({ lent, box: () => { boxed++; return fake(); } });
  p.stdin.write("{\"a\":1}\n");
  await tick();
  assert.equal(lent.got, "", "held until the lender's process is up");
  lent.emit("spawn");
  p.stdin.write("{\"b\":2}\n");
  await tick();
  assert.equal(lent.got, "{\"a\":1}\n{\"b\":2}\n");
  assert.equal(p.where, "lent");
  assert.equal(boxed, 0);
  const out = readAll(p.stdout);
  lent.stdout.write("hello\n"); lent.stdout.end();
  assert.equal(await out, "hello\n");
});

test("nothing could start on the lender (lent_unavailable): the box runs it, and gets the bytes already written, once", async () => {
  const lent = fake(), box = fake(); box.pid = 4242;
  const p = lentOrBox({ lent, box: () => box });
  p.stdin.write("{\"initialize\":1}\n");
  const spawned = new Promise(res => p.once("spawn", res));
  lent.emit("error", Object.assign(new Error("no computer of yours took this session in time"), { code: "lent_unavailable" }));
  lent.emit("close", null, null);
  await spawned;
  p.stdin.write("{\"user\":1}\n");
  await tick();
  assert.equal(box.got, "{\"initialize\":1}\n{\"user\":1}\n");
  assert.equal(lent.got, "", "the lender got none of it");
  assert.equal(p.where, "box");
  assert.equal(p.pid, 4242);
  const closed = new Promise(res => p.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  box.emit("exit", 0, null); box.emit("close", 0, null);
  assert.deepEqual(await closed, [0, null]);
});

test("a session that moved under the chat ends as a move, not a crash: the object carries `moved`", async () => {
  const lent = fake(); lent.lent = { session: SESSION, epoch: 1 };
  const p = lentOrBox({ lent, box: () => fake() });
  lent.emit("spawn");
  const closed = new Promise(res => p.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  lent.moved = F.moved.moved;
  lent.emit("exit", null, "SIGHUP"); lent.emit("close", null, "SIGHUP");
  assert.deepEqual(await closed, [null, "SIGHUP"]);
  assert.deepEqual(p.moved, F.moved.moved);
});

test("a stop is passed to whichever process has the chat, and an error of a running lender is the SDK's to see", async () => {
  const lent = fake();
  const p = lentOrBox({ lent, box: () => fake() });
  assert.equal(p.kill("SIGTERM"), true);
  assert.equal(lent.killedWith, "SIGTERM", "asked before it was up: the lender is asked to stop");
  const lent2 = fake(); lent2.lent = {};
  const q = lentOrBox({ lent: lent2, box: () => fake() });
  lent2.emit("spawn");
  q.kill("SIGKILL");
  assert.equal(lent2.killedWith, "SIGKILL");
  const seen = new Promise(res => q.on("error", res));
  lent2.emit("error", Object.assign(new Error("the pipe broke"), { code: "unavailable" }));
  assert.equal(/** @type {any} */ (await seen).code, "unavailable");
});

test("only a chat the home's book places on a computer gets a lent spawn; a new chat, or a daemon that is not the home, runs on the box", () => {
  const calls = /** @type {any[]} */ ([]);
  const row = { where: "mac", session: "ses_native", chat: "chat_1", person: "per_bob" };
  const kernel = (/** @type {any} */ rows) => ({ runnerHost: () => ({ lentSpawn: (/** @type {string} */ space, /** @type {any} */ i) => { calls.push({ space, ...i }); return {}; }, placements: { spaces: () => ["spc_a"], find: (/** @type {string} */ _s, /** @type {string} */ id) => rows[id] || null } }) });
  const q = { thread: "thr_1", chat: "chat_1", native: "ses_native" };
  assert.equal(lentSpawnFor(kernel({}), q), null, "no row: the server's");
  assert.equal(lentSpawnFor(kernel({ chat_1: { ...row, where: "server" } }), q), null, "a row that says server");
  assert.equal(lentSpawnFor(null, q), null, "no kernel");
  assert.equal(lentSpawnFor({ runnerHost: () => { throw new Error("no runner host"); } }, q), null, "a computer that is not a home");
  const fn = lentSpawnFor(kernel({ chat_1: row }), q);
  assert.ok(fn, "a chat placed on a computer");
  const ac = new AbortController();
  fn?.("claude", ["--output-format", "stream-json"], { SECRET: "no" }, "/box/work", { signal: ac.signal });
  assert.deepEqual(Object.keys(calls[0]).sort(), ["args", "chat", "command", "person", "session", "signal", "space"]);
  assert.deepEqual([calls[0].session, calls[0].chat, calls[0].person, calls[0].space], ["ses_native", "chat_1", "per_bob", "spc_a"], "the row's own person; the box's env and folder are not sent");
});

test("on the real home: with no computer of the person's ready the process starts here and answers; with one ready the bytes ride lent.pipe and the box starts nothing", { timeout: 60_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const r = await rig(t);
  const boxCmd = ["-e", "process.stdin.on('data', d => process.stdout.write('box:' + d))"];
  // no computer ready: the home's spawn never starts, and spawnSession runs the box's process
  const lentNone = (/** @type {string} */ command, /** @type {string[]} */ args) => r.home.spawn({ session: "s_none", person: BOB, command, args });
  const here = spawnSession(process.execPath, boxCmd, { lentSpawn: lentNone });
  here.stdin.write("hello\n");
  const out = await new Promise(res => here.stdout.once("data", res));
  assert.equal(String(out), "box:hello\n");
  here.stdin.end(); here.kill();

  // a computer ready: its heartbeat takes the session; stdin goes down the pipe and nothing runs here
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  let started = false;
  const lentOne = (/** @type {string} */ command, /** @type {string[]} */ args) => r.home.spawn({ session: SESSION, person: BOB, command, args });
  const there = spawnSession(process.execPath, boxCmd, { lentSpawn: lentOne });
  there.stdin.write("{\"type\":\"user\"}\n");
  there.on("spawn", () => { started = true; });
  await c.beat({ sessions: [], well: true }); await c.spec({ session: SESSION });
  const first = await c.pipe({ session: SESSION, up: F.call.up, ack: 0, wait_ms: 0 });
  assert.equal(Buffer.from(first.down[0].b64, "base64").toString(), "{\"type\":\"user\"}\n");
  await tick();
  assert.equal(started, true);
  assert.equal(/** @type {any} */ (there).where, "lent");
  const got = await new Promise(res => there.stdout.once("data", res));
  assert.equal(String(got), "{\"type\":\"system\"}\n", "the lender's output reached the SDK");
  there.kill();
});
