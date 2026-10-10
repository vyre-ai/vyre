// @ts-check
// A chat's agent process on a lent computer, with the box as the way back (team/contracts/lent-spawn.md): the one object the SDK holds, what it does when the lender never starts, and the real home and wire under it.
import "../../scripts/mac-test-guard.mjs";
import "../runner/testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lentOrBox } from "./lent-spawn.js";
import { lentSpawnFor, lentOf, carryOn } from "../../lib/lent-placement.js";
import { spawnSession } from "./spawn.js";
import { rig, BOB, SPACE } from "../runner/testing/lent-rig.js";
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
  assert.equal(lent.got, "{\"a\":1}\n", "written down at once: the lender holds it until its process is up");
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
  box.emit("spawn");
  await spawned;
  p.stdin.write("{\"user\":1}\n");
  await tick();
  assert.equal(box.got, "{\"initialize\":1}\n{\"user\":1}\n");
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

test("only a chat the home's book places on a computer gets a lent spawn; a new chat, or a daemon that is not the home, runs on the box", async () => {
  const calls = /** @type {any[]} */ ([]);
  const row = { where: "mac", session: "ses_native", chat: "chat_1", person: "per_bob" };
  const kernel = (/** @type {any} */ rows) => ({ runnerHost: () => ({ lentSpawn: (/** @type {string} */ space, /** @type {any} */ i) => { calls.push({ space, ...i }); return {}; }, placements: { spaces: () => ["spc_a"], find: (/** @type {string} */ _s, /** @type {string} */ id) => rows[id] || null } }) });
  const q = { thread: "thr_1", chat: "chat_1", native: "ses_native" };
  assert.equal(await lentSpawnFor(kernel({}), q), null, "no row: the server's");
  assert.equal(await lentSpawnFor(kernel({ chat_1: { ...row, where: "server" } }), q), null, "a row that says server");
  assert.equal(await lentSpawnFor(null, q), null, "no kernel");
  assert.equal(await lentSpawnFor({ runnerHost: () => { throw new Error("no runner host"); } }, q), null, "a computer that is not a home");
  const fn = await lentSpawnFor(kernel({ chat_1: row }), { ...q, title: "Harlow intake" });
  assert.ok(fn, "a chat placed on a computer");
  const ac = new AbortController();
  fn?.("claude", ["--output-format", "stream-json"], { SECRET: "no" }, "/box/work", { signal: ac.signal });
  assert.deepEqual(Object.keys(calls[0]).sort(), ["args", "chat", "command", "person", "session", "signal", "space", "thread", "title"]);
  assert.deepEqual([calls[0].session, calls[0].thread, calls[0].chat, calls[0].person, calls[0].space], ["ses_native", "thr_1", "chat_1", "per_bob", "spc_a"], "an older row keeps its own session; the thread id rides beside it, for the route to Vyre's tools; the row's own person; the box's env and folder are not sent");
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

test("the switchboard says thread.placing while a chat's process starts on the computer, and says it fell back when nothing ran there", async () => {
  const said = /** @type {any[]} */ ([]);
  const proc = fake(); proc.lent = { computer: "Office Mac", state: "starting" };
  const self = { deps: { lentFor: async () => () => proc }, chatOf: () => "chat_1", nativeOf: () => "ses_1", turnAsker: new Map(), emit: (/** @type {string} */ type, /** @type {any} */ payload, /** @type {string} */ thread) => said.push({ type, payload, thread }) };
  const spawn = await /** @type {any} */ lentOf(self, "thr_1", { provider: "claude", project: null });
  const p = spawn("claude", [], {}, "/x", {});
  assert.equal(p, proc);
  proc.emit("spawn");
  assert.deepEqual(said.map(x => [x.type, x.payload.state, x.payload.computer]), [["thread.placing", "starting", "Office Mac"], ["thread.placing", "up", "Office Mac"]]);
  const gone = fake(); gone.lent = { computer: "Office Mac" };
  self.deps.lentFor = async () => () => gone;
  const again = await lentOf(self, "thr_1", {});
  again("claude", [], {}, "/x", {});
  gone.emit("error", Object.assign(new Error("none"), { code: "lent_unavailable" }));
  assert.deepEqual(said.at(-1).payload, { thread: "thr_1", state: "fallback", computer: "Office Mac", reason: "unavailable" });
});

test("the switchboard asks for a lent spawn for a claude session only, and a failing lookup is the box's", async () => {
  const fn = () => ({});
  const sb = (/** @type {any} */ lentFor) => ({ deps: { lentFor }, chatOf: () => "chat_1", nativeOf: () => "ses_native", turnAsker: new Map() });
  const ask = (/** @type {any} */ self, /** @type {any} */ rec) => lentOf(self, "thr_1", rec);
  assert.equal(typeof (await ask({ ...sb(async () => fn), emit() {} }, { provider: "claude" })), "function");
  assert.equal(typeof (await ask({ ...sb(async () => fn), emit() {} }, {})), "function", "claude is the default");
  assert.equal(await ask(sb(async () => fn), { provider: "codex" }), undefined, "another provider's process is not lent");
  assert.equal(await ask(sb(async () => null), { provider: "claude" }), undefined);
  assert.equal(await ask(sb(async () => { throw new Error("no host"); }), { provider: "claude" }), undefined);
  assert.equal(await ask({ deps: {}, chatOf: () => null, nativeOf: () => "x", turnAsker: new Map() }, {}), undefined);
});

test("a new chat of the home's owner is placed once at creation: a ready computer gets the row, none ready leaves it on the box, and another person's chat or one that already ran is never placed", async () => {
  const rows = /** @type {Record<string, any>} */ ({});
  const placed = /** @type {any[]} */ ([]);
  const make = (/** @type {{ where: string }} */ answer) => ({
    owner: "per_owner", id: { space: "spc_a", owner: "per_owner" },
    runnerHost: () => ({
      lentSpawn: () => ({}),
      placeNew: async (/** @type {string} */ space, /** @type {any} */ i) => { placed.push({ space, ...i }); if (answer.where === "mac") rows[i.chat] = { where: "mac", session: i.session, chat: i.chat, person: i.person }; return answer; },
      placements: { spaces: () => ["spc_a"], find: (/** @type {string} */ _s, /** @type {string} */ id) => rows[id] || null },
    }),
  });
  const q = { thread: "thr_9", chat: "chat_9", native: "ses_9", fresh: true };
  assert.equal(await lentSpawnFor(make({ where: "box" }), q), null, "none ready: the box");
  assert.deepEqual(placed.map(p => [p.space, p.session, p.chat, p.person]), [["spc_a", "thr_9", "chat_9", "per_owner"]]);
  assert.equal(await lentSpawnFor(make({ where: "mac" }), { ...q, asker: "per_member" }), null, "another person's chat is not placed on the owner's computer");
  assert.equal(await lentSpawnFor(make({ where: "mac" }), { ...q, fresh: false }), null, "a chat that already ran is not placed now");
  assert.equal(placed.length, 1);
  const fn = await lentSpawnFor(make({ where: "mac" }), q);
  assert.ok(fn, "a ready computer: the row is written and the process is lent");
  assert.equal(placed.length, 2);
});

test("the lent process says it is starting on its computer from the first moment, and the SDK's object passes it on", async () => {
  const lent = fake(); lent.lent = { device: "dev_1", computer: "Office Mac", state: "starting", epoch: 1 };
  const p = lentOrBox({ lent, box: () => fake() });
  assert.equal(p.lent.computer, "Office Mac");
  const said = new Promise(res => p.once("starting", res));
  lent.emit("starting");
  assert.equal(/** @type {any} */ (await said).state, "starting");
  lent.lent = { ...lent.lent, state: "up" };
  lent.emit("spawn");
  assert.equal(p.lent.state, "up");
});

test("on the real home: a new chat of the owner is placed at creation on the owner's ready computer, the row says mac under the thread's id, and the process is lent; with no computer ready it stays on the box", { timeout: 60_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const r = await rig(t);
  const kernel = (/** @type {any} */ h) => ({ owner: BOB, id: { space: SPACE, owner: BOB }, runnerHost: () => ({ lentSpawn: (/** @type {string} */ _s, /** @type {any} */ i) => h.spawn(i), placeNew: async (/** @type {string} */ _s, /** @type {any} */ i) => h.placeNew(i), placements: { spaces: () => [SPACE], find: (/** @type {string} */ _s, /** @type {string} */ id) => h.book.find(id) } }) });
  const q = { thread: "thr_new", chat: "chat_new", native: "thr_new", fresh: true, title: "Harlow intake" };
  assert.equal(await lentSpawnFor(kernel(r.home), q), null, "no computer ready: the box");
  assert.equal(r.home.book.find("thr_new"), null, "nothing was written");
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  const spawn = await lentSpawnFor(kernel(r.home), q);
  assert.ok(spawn, "a ready computer: the chat is placed there");
  const row = r.home.book.find("thr_new");
  assert.deepEqual([row.where, row.person, row.session], ["mac", BOB, "thr_new"]);
  const proc = spawn("claude", ["--output-format", "stream-json"], {}, "/box/work", {});
  assert.equal(typeof proc.kill, "function");
  proc.kill();
});

test("a chat that moved to the server under a running turn starts again here with resume and sends the cut turn again; a finished turn is not repeated; a failure ends the thread in words", async () => {
  const calls = /** @type {any[]} */ ([]);
  const sb = () => ({ live: new Map(), record: () => ({ project: "p" }), libraryPlugin: async () => "plug", sandboxFor: async () => undefined, gitEnv: async () => ({}), deps: {}, chatOf: () => null, nativeOf: () => "n", turnAsker: new Map(),
    spawn: (/** @type {string} */ id, /** @type {any} */ o) => calls.push(["spawn", id, o.resume, o.lastPrompt]), write: (/** @type {string} */ id, /** @type {string} */ text) => calls.push(["write", id, text]),
    emit: (/** @type {string} */ type, /** @type {any} */ payload) => calls.push([type, payload.text || payload.reason || null]), set: (/** @type {string} */ id, /** @type {any} */ patch) => calls.push(["set", id, patch.status]) });
  const cutTurn = { turn: "t:2", lastPrompt: "and again", launch: { cwd: "/x" }, switching: false };
  await carryOn(sb(), "t", cutTurn);
  assert.deepEqual(calls.filter(c => c[0] !== "thread.text"), [["spawn", "t", true, "and again"], ["write", "t", "and again"]], "resumed here and the cut turn sent again");
  assert.equal(cutTurn.switching, true);
  calls.length = 0;
  await carryOn(sb(), "t", { turn: null, lastPrompt: "and again", launch: {}, switching: false });
  assert.deepEqual(calls.filter(c => c[0] !== "thread.text"), [["spawn", "t", true, null]], "a finished turn is not sent again");
  calls.length = 0;
  const broken = sb(); broken.spawn = () => { throw new Error("no folder"); };
  const st = { turn: "t:3", lastPrompt: "x", launch: {}, switching: false };
  await carryOn(broken, "t", st);
  assert.equal(st.switching, false);
  assert.deepEqual(calls.map(c => c[0]), ["set", "thread.stopped"], "the thread ends, saying why");
});
