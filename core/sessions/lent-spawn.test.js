// @ts-check
// A chat's agent process on a lent computer, with the box as the way back (team/contracts/lent-spawn.md): the one object the SDK holds, what it does when the lender never starts, and the real home and wire under it.
import "../../scripts/mac-test-guard.mjs";
import "../runner/testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lentOrBox } from "./lent-spawn.js";
import { lentSpawnFor, lentOf, carryOn, lentYield, lentDrain, lentBlocks, lentHolder, lentRowFor, takeBackFor } from "../../lib/lent-placement.js";
import { Switchboard } from "../switchboard/index.js";
import { spawnSession } from "./spawn.js";
import { rig, BOB, CAROL, OWNER, SPACE } from "../runner/testing/lent-rig.js";
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
  const q = { thread: "thr_1", chat: "chat_1", native: "ses_native", asker: "per_bob" };
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
  const q = { thread: "thr_9", chat: "chat_9", native: "ses_9", fresh: true, asker: "per_owner" };
  assert.equal(await lentSpawnFor(make({ where: "mac" }), { ...q, asker: null }), null, "no person named: the box, never a computer");
  assert.equal(await lentSpawnFor(make({ where: "mac" }), { thread: "thr_n", chat: "chat_n", native: "ses_n", fresh: true }), null, "and no asker at all is the same");
  assert.equal(placed.length, 0, "nothing was placed for a turn with no person");
  assert.equal(await lentSpawnFor(make({ where: "box" }), q), null, "none ready: the box");
  assert.deepEqual(placed.map(p => [p.space, p.session, p.chat, p.person]), [["spc_a", "thr_9", "chat_9", "per_owner"]]);
  assert.equal(await lentSpawnFor(make({ where: "mac" }), { ...q, fresh: false }), null, "a chat that already ran is not placed now");
  assert.equal(placed.length, 1);
  const fn = await lentSpawnFor(make({ where: "mac" }), q);
  assert.ok(fn, "a ready computer: the row is written and the process is lent");
  assert.equal(placed.length, 2);
  // a member starts a chat of their own: it is placed for THEM (their own computer), never on the owner's
  const mfn = await lentSpawnFor(make({ where: "mac" }), { ...q, thread: "thr_m", chat: "chat_m", native: "ses_m", asker: "per_member" });
  assert.ok(mfn, "a member's new chat is placed on the member's own computer");
  assert.deepEqual([placed[2].person, placed[2].chat], ["per_member", "chat_m"]);
});

test("a turn runs on its own person's computer only: another member's turn in a chat placed on someone's computer runs on the box, and a turn with no person runs on the box", async () => {
  const calls = /** @type {any[]} */ ([]);
  const rows = /** @type {Record<string, any>} */ ({ chat_a: { where: "mac", session: "ses_a", chat: "chat_a", person: "per_alice" } });
  const kernel = { owner: "per_alice", id: { space: "spc_a", owner: "per_alice" }, runnerHost: () => ({ lentSpawn: (/** @type {string} */ space, /** @type {any} */ i) => { calls.push({ space, ...i }); return {}; }, placements: { spaces: () => ["spc_a"], find: (/** @type {string} */ _s, /** @type {string} */ id) => rows[id] || null } }) };
  const q = { thread: "thr_a", chat: "chat_a", native: "ses_a" };
  assert.equal(await lentSpawnFor(kernel, { ...q, asker: "per_bob" }), null, "Bob's turn in Alice's chat never runs on Alice's computer");
  assert.equal(calls.length, 0);
  assert.ok(await lentSpawnFor(kernel, { ...q, asker: "per_alice" }), "Alice's own turn does");
  assert.equal(await lentSpawnFor(kernel, q), null, "a turn with no person on its chain runs on the box, never on Alice's computer (not even as the home's owner)");

  assert.equal(await lentSpawnFor(kernel, q), null, "a turn with no person is never the owner's: it runs on the box");
  assert.equal(await lentSpawnFor(kernel, { ...q, fresh: true, thread: "thr_n", chat: "chat_n", native: "ses_n" }), null, "and a new chat with no person is not placed on the owner's computer");
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
  const q = { thread: "thr_new", chat: "chat_new", native: "thr_new", fresh: true, title: "Harlow intake", asker: BOB };
  assert.equal(await lentSpawnFor(kernel(r.home), { ...q, asker: null }), null, "a turn with no person is the box's even with a computer ready");
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

test("the switchboard's onExit sends a chat whose process ended because it moved to the server through carryOn, and any other exit stays an exit", async () => {
  const calls = /** @type {any[]} */ ([]);
  const st = { turn: "t:2", lastPrompt: "again", launch: {}, switching: false, stopping: false };
  const sb = /** @type {any} */ ({ live: new Map([["t", st]]), flush() {}, cancelTools() {}, releaseSlots() {}, record: () => ({ project: null }), libraryPlugin: async () => "p", sandboxFor: async () => undefined, gitEnv: async () => ({}), deps: {}, chatOf: () => null, nativeOf: () => "t", turnAsker: new Map(),
    spawn: (/** @type {string} */ id, /** @type {any} */ o) => calls.push(["spawn", id, o.resume]), write: (/** @type {string} */ id, /** @type {string} */ text) => calls.push(["write", id, text]), emit: () => {}, set: () => {}, closeSocket() {}, asks: { open: () => [] } });
  Switchboard.prototype.onExit.call(sb, "t", st, null, "SIGHUP", "", { to: "server", reason: "lid-closed", epoch: 2 });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(calls, [["spawn", "t", true], ["write", "t", "again"]], "carried on, the cut turn sent again");
  calls.length = 0;
  const st2 = { turn: "t:3", lastPrompt: "x", launch: {}, switching: false, stopping: false };
  sb.live.set("t", st2);
  Switchboard.prototype.onExit.call(sb, "t", st2, 0, null, "");
  assert.deepEqual(calls, [], "an ordinary exit starts nothing");
});

test("on the real home: a member's computer runs only that member's own turns: Carol's turn in Bob's chat runs on the box, Bob's own turn runs on Bob's computer, and a chat Carol starts is never placed on Bob's computer (the product ruling of 10 Oct)", { timeout: 60_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const r = await rig(t);
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  const calls = /** @type {any[]} */ ([]);
  const kernel = { owner: OWNER, id: { space: SPACE, owner: OWNER }, runnerHost: () => ({ space: SPACE,
    lentSpawn: (/** @type {string} */ _s, /** @type {any} */ i) => { calls.push(i.person); return r.home.spawn(i); },
    placeNew: async (/** @type {string} */ _s, /** @type {any} */ i) => r.home.placeNew(i),
    placements: { spaces: () => [SPACE], find: (/** @type {string} */ _s, /** @type {string} */ id) => r.home.book.get(id) || null } }) };
  // Bob starts a chat: it is placed on Bob's ready computer, and the book says it is Bob's
  const q = { thread: SESSION, chat: "chat_bob", native: SESSION, fresh: true };
  const mine = await lentSpawnFor(kernel, { ...q, asker: BOB });
  assert.ok(mine, "Bob's new chat is lent to Bob's computer");
  assert.equal(r.home.book.get(SESSION)?.person, BOB);
  // Carol's turn in Bob's chat never runs on Bob's computer, whatever the row says
  assert.equal(await lentSpawnFor(kernel, { ...q, fresh: false, asker: CAROL }), null, "Carol's turn in Bob's chat runs on the box");
  assert.equal(await lentSpawnFor(kernel, { ...q, fresh: false, asker: BOB }) !== null, true, "Bob's own turn still runs on his computer");
  // a chat Carol starts is hers: she has no computer ready, so it is the box's; it is never put on Bob's
  const carol = await lentSpawnFor(kernel, { thread: "ses_00000000000000000000000000000002", chat: "chat_carol", native: "ses_00000000000000000000000000000002", fresh: true, asker: CAROL });
  assert.equal(carol, null, "Carol's new chat is not placed on Bob's computer");
  assert.equal(r.home.book.get("ses_00000000000000000000000000000002"), null, "no row for it anywhere");
});

test("on the real home: another person's turn that reaches a chat whose live process is on Bob's computer takes the chat back to the server first and waits: it never runs there; Bob's own turn is left alone", { timeout: 60_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const r = await rig(t);
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  const kernel = { owner: OWNER, id: { space: SPACE, owner: OWNER }, runnerHost: () => ({ space: SPACE,
    lentSpawn: (/** @type {string} */ _s, /** @type {any} */ i) => r.home.spawn(i), placeNew: async (/** @type {string} */ _s, /** @type {any} */ i) => r.home.placeNew(i),
    placements: { spaces: () => [SPACE], find: (/** @type {string} */ _s, /** @type {string} */ id) => r.home.book.get(id) || null, takeBack: (/** @type {string} */ _s, /** @type {string} */ session, /** @type {string} */ reason) => r.home.takeOver(session, reason) } }) };
  const q = { thread: SESSION, chat: "chat_bob", native: SESSION, fresh: true, asker: BOB };
  assert.ok(await lentSpawnFor(kernel, q), "the chat is lent to Bob's computer");
  assert.equal(r.home.book.get(SESSION)?.where, "mac");
  // the switchboard side: a live process that is on a computer, and a turn by someone else
  const sb = (/** @type {any} */ asker) => ({ deps: { lentTakeBack: (/** @type {any} */ x) => takeBackFor(kernel, { ...x, asker }), lentRow: (/** @type {any} */ x) => lentRowFor(kernel, x) }, chatOf: () => "chat_bob", nativeOf: () => SESSION });
  const live = { proc: { where: "lent" } };
  assert.equal(await lentYield(sb(BOB), SESSION, live, BOB), false, "Bob's own turn runs on his computer as before");
  assert.equal(r.home.book.get(SESSION)?.where, "mac");
  assert.equal(await lentYield(sb(CAROL), SESSION, live, CAROL), true, "Carol's turn waits");
  assert.equal(r.home.book.get(SESSION)?.where, "server", "and the server took the chat back from Bob's computer: nothing of Carol's reaches it");
  assert.equal(await lentYield(sb(CAROL), SESSION, { proc: { where: "box" } }, CAROL), false, "a process on the box has nothing to yield");
  // if the server cannot take the chat back now, the message still waits
  const stuck = { deps: { lentTakeBack: () => Promise.resolve("held"), lentRow: (/** @type {any} */ x) => lentRowFor(kernel, x) }, chatOf: () => null, nativeOf: () => SESSION };
  assert.equal(await lentYield(stuck, SESSION, live, CAROL), true, "a held take-back still does not run the turn on the computer");
});


test("fail closed: a live process that does not say it is on the box is judged by the home's book, and another person's message (or one with no person) never goes into one that is on a computer", async () => {
  const row = { where: "mac", session: SESSION, chat: "chat_bob", person: BOB };
  const sb = (/** @type {any} */ r) => ({ deps: { lentRow: () => r }, chatOf: () => "chat_bob", nativeOf: () => SESSION, canon: (/** @type {string} */ x) => (x === "per_old_bob" ? BOB : x) });
  for (const where of [undefined, null, "", "weird", "pending", "lent"]) {
    const st = { proc: { where } };
    assert.equal(lentBlocks(sb(row), SESSION, st, CAROL), true, `where=${JSON.stringify(where)}: Carol's message is kept off Bob's computer`);
    assert.equal(lentBlocks(sb(row), SESSION, st, null), true, `where=${JSON.stringify(where)}: a message with no person is kept off it too`);
    assert.equal(lentBlocks(sb(row), SESSION, st, BOB), false, `where=${JSON.stringify(where)}: Bob's own message goes in`);
    assert.equal(lentBlocks(sb(row), SESSION, st, "per_old_bob"), false, "Bob under a replaced id is still Bob");
  }
  assert.equal(lentBlocks(sb(row), SESSION, { proc: { where: "box" } }, CAROL), false, "a process that says box is the box's");
  assert.equal(lentBlocks(sb(null), SESSION, { proc: {} }, CAROL), false, "no row and no claim: nothing says it is on a computer");
  assert.equal(lentHolder(sb(null), SESSION, { proc: { where: "lent" } }), "", "a process that says lent with no row is held for nobody");
  assert.equal(lentBlocks(sb(null), SESSION, { proc: { where: "lent" } }, BOB), true, "and nobody's message goes in");
  // no take-back available: it still waits
  assert.equal(await lentYield({ ...sb(row), deps: { lentRow: () => row } }, SESSION, { proc: { where: undefined } }, CAROL), true);
  // a running turn is never interrupted by a take-back: the message waits
  let asked = 0;
  assert.equal(await lentYield({ ...sb(row), deps: { lentRow: () => row, lentTakeBack: async () => { asked++; return "taken"; } } }, SESSION, { turn: "t:1", proc: { where: "lent" } }, CAROL), true);
  assert.equal(asked, 0, "no take-back while the owner's turn runs");
});

test("the last door: Switchboard.write refuses a message for a process on a computer unless the turn it belongs to is that person's", async () => {
  const { Switchboard } = await import("../switchboard/index.js");
  const row = { where: "mac", session: SESSION, chat: "chat_bob", person: BOB };
  const stub = (/** @type {any} */ asker) => ({ live: new Map([[SESSION, { proc: { where: undefined, write() { throw new Error("reached the process"); } } }]]), turnAsker: new Map(asker === undefined ? [] : [[SESSION, asker]]), deps: { lentRow: () => row }, chatOf: () => "chat_bob", nativeOf: () => SESSION });
  for (const asker of [undefined, null, CAROL]) assert.throws(() => Switchboard.prototype.write.call(stub(asker), SESSION, "hello"), (/** @type {any} */ e) => e.code === "held" && /waits/.test(e.message), `asker ${String(asker)}: refused before the process`);
});


test("another person's turn: the computer is asked to hand the chat over first and the server waits for it; only a computer that does not answer is taken from", async () => {
  /** @type {string[]} */ const calls = [];
  let where = "mac";
  const places = (/** @type {boolean} */ answers, /** @type {any} */ extra = {}) => ({ spaces: () => [SPACE], find: () => ({ session: SESSION, chat: "chat_bob", person: BOB, where, ...extra }),
    askRelease: (/** @type {string} */ _s, /** @type {string} */ _id, /** @type {string} */ reason) => { calls.push("ask:" + reason); if (answers) setTimeout(() => { where = "server"; }, 150); },
    takeBack: async () => { calls.push("force"); where = "server"; return { changed: true }; } });
  const kernel = (/** @type {boolean} */ answers, /** @type {any} */ extra) => ({ runnerHost: () => ({ placements: places(answers, extra) }) });
  const q = { thread: SESSION, chat: "chat_bob", native: SESSION, asker: CAROL };
  assert.equal(await takeBackFor(kernel(true), q), "taken");
  assert.deepEqual(calls, ["ask:another-person"], "a computer that answers is not taken from");
  calls.length = 0; where = "mac";
  assert.equal(await takeBackFor(kernel(false), { ...q, waitMs: 300 }), "taken");
  assert.deepEqual(calls, ["ask:another-person", "force"], "a computer that does not answer in time is taken from");
});

test("a burst of messages from other people makes the server wait for the hand-over once, not once each", async () => {
  /** @type {string[]} */ const calls = [];
  let where = "mac";
  const kernel = { runnerHost: () => ({ placements: { spaces: () => [SPACE], find: () => ({ session: SESSION, chat: "chat_bob", person: BOB, where }),
    askRelease: () => { calls.push("ask"); setTimeout(() => { where = "server"; }, 250); }, takeBack: async () => { calls.push("force"); return { changed: true }; } } }) };
  const q = { thread: SESSION, chat: "chat_bob", native: SESSION };
  const all = await Promise.all([takeBackFor(kernel, { ...q, asker: CAROL }), takeBackFor(kernel, { ...q, asker: CAROL }), takeBackFor(kernel, { ...q, asker: "per_dave" }), takeBackFor(kernel, { ...q, asker: null })]);
  assert.deepEqual(all, ["taken", "taken", "taken", "taken"]);
  assert.deepEqual(calls, ["ask"], "one request to the computer, shared by every waiting message");
});

test("a chat that works in a folder of the computer is never taken from it: the other person's message waits and is told why and what to do", async () => {
  /** @type {string[]} */ const calls = [], said = [];
  const kernel = { runnerHost: () => ({ placements: { spaces: () => [SPACE], find: () => ({ session: SESSION, chat: "chat_bob", person: BOB, where: "mac", folder: "f1" }), askRelease: () => calls.push("ask"), takeBack: async () => { calls.push("force"); return { changed: true }; } } }) };
  assert.equal(await takeBackFor(kernel, { thread: SESSION, chat: "chat_bob", native: SESSION, asker: CAROL }), "folder");
  assert.deepEqual(calls, [], "neither asked nor forced");
  const row = { where: "mac", session: SESSION, chat: "chat_bob", person: BOB, folder: "f1" };
  const sb = { deps: { lentRow: () => row, lentTakeBack: (/** @type {any} */ x) => takeBackFor(kernel, x) }, chatOf: () => "chat_bob", nativeOf: () => SESSION, record: () => ({ project: null }), emit: (/** @type {string} */ t, /** @type {any} */ p) => said.push(p.text) };
  assert.equal(await lentYield(sb, SESSION, { proc: { where: "lent" } }, CAROL), true);
  assert.ok(said.length === 1 && /Ask the chat's owner/.test(said[0]), "the person is told: " + said.join("|"));
});

test("the other person's message that waited while the chat came back is the next turn once the server has carried on", async () => {
  /** @type {any[]} */ const ended = [];
  const before = { turn: null }, fresh = { turn: null, switching: false, proc: { where: "box" } };
  const sb = (/** @type {any} */ live, /** @type {boolean} */ queued) => ({ live: new Map([["t", live]]), deps: {}, db: { prepare: () => ({ get: () => (queued ? { 1: 1 } : undefined) }) }, record: () => ({ project: null }), turnEnded: (/** @type {any} */ ...a) => ended.push(a) });
  lentDrain(sb(before, true), "t", before);
  assert.equal(ended.length, 0, "the old process is still the live one: carryOn hands the queue over itself");
  lentDrain(sb(fresh, false), "t", before);
  assert.equal(ended.length, 0, "nothing queued, nothing to hand over");
  lentDrain(sb({ ...fresh, proc: { where: "lent" } }, true), "t", before);
  assert.equal(ended.length, 0, "never into a process that is on a computer");
  lentDrain(sb(fresh, true), "t", before);
  assert.equal(ended.length, 1, "the fresh idle process on the server takes the waiting message as its turn");
});
