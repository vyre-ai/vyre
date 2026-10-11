// The next person's turn is judged only after a hop back has finished; past the wait it is refused, never judged on the hop's state (asker-account.js revertSettled).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { revertSettled, runQueuedOver } from "./asker-account.js";
import { Switchboard } from "./index.js";

test("revertSettled: true with no hop back, true once it finishes (or fails), false when it is still held open after the wait", async () => {
  const sb = /** @type {any} */ ({ reverting: new Map(), revertWaitMs: 40 });
  assert.equal(await revertSettled(sb, "t"), true, "nothing reverting");
  let done; sb.reverting.set("t", new Promise(r => { done = r; }));
  setTimeout(() => done(undefined), 10);
  assert.equal(await revertSettled(sb, "t"), true, "the revert finished inside the wait");
  sb.reverting.set("t", Promise.reject(new Error("could not go back")));
  assert.equal(await revertSettled(sb, "t"), true, "a revert that failed is over too");
  sb.reverting.set("t", new Promise(() => {}));
  const t0 = Date.now();
  assert.equal(await revertSettled(sb, "t"), false, "held open past the wait: not settled, so the caller must not judge");
  assert.ok(Date.now() - t0 >= 35, "and it waited");
});

test("runQueuedOver: a hop that cannot start says so in words, tells the stream nothing began, and releases the drain so the rows behind it run", async () => {
  /** @type {any[]} */ const events = []; /** @type {any[]} */ const drained = [];
  const sb = /** @type {any} */ ({ reverting: new Map(), record: () => ({ project: null }), emit: (/** @type {string} */ type, /** @type {any} */ p) => events.push([type, p]), onceTarget: async () => { throw new Error("That account is not yours to use here."); }, sendOnce: async () => { throw new Error("must not be reached"); }, drainDone: (/** @type {string} */ id, /** @type {boolean} */ again) => drained.push([id, again]) });
  const row = { id: 1, text: "A-ONE", surface: "via:module:stream", uuid: "u", at: 1 };
  assert.equal(runQueuedOver(sb, "t", [row], { chat: "c", asker: "per_ada", over: { provider: "claude", account: "x", person: "per_ada" } }, () => ({ changes: 1 }), 1), true);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(events.map(e => e[0]), ["thread.text"], "only a notice, and no thread.sent: the stream is not told a turn began");
  assert.match(events[0][1].text, /could not run on your own account/);
  assert.deepEqual(drained, [["t", true]], "the drain lock is released with a re-drain");
});

test("a write that throws while a queued turn is handed over releases the drain lock, and the row behind it still runs", async () => {
  /** @type {any[]} */ const drained = [];
  const sb = /** @type {any} */ ({
    reverting: new Map(), draining: new Set(["t"]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, emit() {}, record: () => ({ project: null }), deps: { log() {} },
    write() { throw new Error("lent: the words may not go into a process on a computer"); },
    dropQueuedChatTurn: (/** @type {string} */ id) => drained.push("notice"),   // the room is told the words were not sent
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  Switchboard.prototype.drainRun.call(sb, "t", null, [{ id: 1, text: "x", surface: "s", uuid: "u", at: 1 }], null);   // (logged and told, not thrown into whatever ended the turn)
  assert.equal(sb.draining.has("t"), false, "the lock is released");
  assert.deepEqual(drained, ["notice", "t"], "the room is told, and the rows behind it are drained again");
});

test("a hop whose turn ended before sendOnce resolved still drains the row behind it", async () => {
  /** @type {any[]} */ const drained = [];
  const st = { turn: null, stopping: false };
  const sb = /** @type {any} */ ({
    reverting: new Map(), draining: new Set(["t"]), once: new Map(), live: new Map([["t", st]]),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => ({}), sendOnce: async () => { /* the hop's whole turn ran and ended here: its turnEnded returned at the lock */ },
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 2, text: "A-ONE", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_ada", over: { provider: "claude", account: "x", person: "per_ada" } }, () => ({ changes: 1 }), 1);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sb.draining.has("t"), false);
  assert.deepEqual(drained, ["t"], "the thread is idle with no hop pending, so the next row is drained");
});

test("runQueuedOver past the revert wait puts the row back instead of judging it on the hop's state", async () => {
  /** @type {any[]} */ const ran = []; /** @type {any[]} */ const drained = [];
  const sb = /** @type {any} */ ({
    reverting: new Map([["t", new Promise(() => {})]]), revertWaitMs: 30, draining: new Set(["t"]), once: new Map(), live: new Map([["t", { turn: null }]]),
    db: { prepare: (/** @type {string} */ q) => ({ run: (/** @type {any[]} */ ...a) => { ran.push([q.slice(0, 90), a]); return { changes: 1 }; } }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => { throw new Error("must not be judged"); }, sendOnce: async () => { throw new Error("must not run"); },
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 3, text: "B-TWO", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_bob", over: { provider: "claude", account: "y", person: "per_bob" } }, () => ({ changes: 1 }), 1);
  await new Promise(r => setTimeout(r, 120));
  assert.ok(ran.some(r => /delivered_at = NULL/.test(r[0])), "the row is put back in the queue");
  assert.deepEqual(drained, [], "and nothing is drained or run on the wrong base");
  assert.equal(sb.draining.has("t"), false, "the lock is released");
});

test("while a hop back swaps the process nothing drains; the row behind a hop whose turn ended first is written after the revert, not during", async () => {
  /** @type {any[]} */ const drained = [];
  let finish; const revert = new Promise(r => { finish = r; });
  const sb = /** @type {any} */ ({ reverting: new Map([["t", revert]]), draining: new Set(), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]), record: () => ({ project: null }), db: { prepare: () => ({ all: () => { drained.push("read-queue"); return []; } }) } });
  sb.drainDone = Switchboard.prototype.drainDone;
  sb.drainQueued = Switchboard.prototype.drainQueued;
  sb.drainDone("t", true);
  sb.drainQueued("t", sb.live.get("t"), null);
  assert.deepEqual(drained, [], "during the revert neither drainDone nor drainQueued reads or runs the queue");
  sb.reverting.delete("t"); finish(undefined);
  sb.drainDone("t", true);
  assert.deepEqual(drained, ["read-queue"], "once the revert is over the queue is read");
});

test("a revert whose switch throws still drains the put-back row", async () => {
  /** @type {any[]} */ const drained = []; /** @type {any[]} */ const sql = [];
  const revert = new Promise(r => setTimeout(r, 60));   // (turnEnded's promise has its .catch: it settles even when the switch threw)
  const sb = /** @type {any} */ ({
    reverting: new Map([["t", revert]]), revertWaitMs: 20, draining: new Set(["t"]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]),
    db: { prepare: (/** @type {string} */ q) => ({ run: () => { sql.push(q.slice(0, 50)); return { changes: 1 }; } }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => { throw new Error("must not be judged"); }, sendOnce: async () => { throw new Error("must not run"); },
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  void revert.finally(() => sb.reverting.delete("t"));   // turnEnded's own cleanup runs first
  runQueuedOver(sb, "t", [{ id: 9, text: "B-TWO", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_bob", over: { provider: "claude", account: "y", person: "per_bob" } }, () => ({ changes: 1 }), 1);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(drained, [], "past the wait and the revert still going: nothing runs");
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(drained, ["t"], "when the revert is over, thrown or not, the put-back row is drained");
});

test("a queued row whose hop needs no move (sendOnce answers null) still delivers its words, under their asker", async () => {
  /** @type {any[]} */ const calls = [];
  const sb = /** @type {any} */ ({
    reverting: new Map(), draining: new Set(["t"]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => ({}), sendOnce: async () => null,
    deliverRow: async (/** @type {string} */ id, /** @type {any} */ r, /** @type {any} */ kt) => { calls.push([id, r.text, kt.asker]); },
    drainQueued() {}, reverting_: 0,
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 4, text: "C-ONE", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_carol", over: { provider: "claude", account: "same", person: "per_carol" } }, () => ({ changes: 1 }), 1);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(calls, [["t", "C-ONE", "per_carol"]], "the words are delivered, not swallowed");
});

test("deliverRow writes the words under the asker's session, and tells the room when that session cannot open", async () => {
  /** @type {any[]} */ const log = [];
  const mk = (/** @type {boolean} */ ok) => /** @type {any} */ ({ record: () => ({ project: null }), renewKernelSession: async () => ok, renewCapped: async () => ok, write: (/** @type {string} */ id, /** @type {string} */ text, /** @type {any} */ o) => log.push(["write", text, o.askedBy]), dropQueuedChatTurn: () => log.push(["told"]) });
  await Switchboard.prototype.deliverRow.call(mk(true), "t", { text: "C-ONE", uuid: "u" }, { chat: "c", asker: "per_carol" });
  await Switchboard.prototype.deliverRow.call(mk(false), "t", { text: "C-TWO", uuid: "v" }, { chat: "c", asker: "per_carol" });
  assert.deepEqual(log, [["write", "C-ONE", "per_carol"], ["told"]]);
});

test("a switch back that fails twice leaves the record on the base with no live process, tells the room once, and starts a waiting row on the base; nothing is written into the hop's process", async () => {
  /** @type {any[]} */ const events = []; /** @type {any[]} */ const sql = []; /** @type {string[]} */ const resumed = []; let stops = 0, tries = 0;
  const hopProcess = { writes: [] };
  const sb = /** @type {any} */ ({
    once: new Map([["t", { to: "codex", back: { provider: "claude", account: "bobs", model: "opus", person: "per_bob" }, sent: "x", reply: "" }]]), carry: new Map(), switches: new Set(), reverting: new Map(), closing: false,
    live: new Map([["t", { turn: null, stopping: false, hopProcess }]]), deps: { log() {} },
    record: () => ({ project: null, provider: "codex", account: "carols" }),
    db: { prepare: (/** @type {string} */ q) => ({ get: () => ({ opts: JSON.stringify({ account: "carols", person: "per_carol", switchPerson: "per_carol", origin: "x" }) }), run: (/** @type {any[]} */ ...a) => { sql.push([q.slice(0, 40), a]); return { changes: 1 }; } }) },
    emit: (/** @type {string} */ type, /** @type {any} */ p) => events.push([type, p.text]),
    switchProvider: async () => { tries++; throw new Error("no process"); },
    stop: async () => { stops++; sb.live.delete("t"); },
    launch: async (/** @type {any} */ o) => { resumed.push(o.resume); },
    turnEnded: () => { throw new Error("turnEnded must not run on a thread with no process"); },
  });
  sb.resumeWaiting = Switchboard.prototype.resumeWaiting;
  sb.db.prepare = ((orig) => (/** @type {string} */ q) => (/waiting|delivered_at IS NULL AND kturn/.test(q) ? { get: () => ({ n: 1 }) } : orig(q)))(sb.db.prepare);
  await Switchboard.prototype.revertOnce.call(sb, "t");
  assert.equal(tries, 2, "retried once");
  const update = sql.find(r => /UPDATE threads_runs SET provider/.test(r[0]));
  assert.ok(update, "the base is written back to the record");
  assert.deepEqual(update[1].slice(0, 3), ["claude", "bobs", "opus"], "provider, account and model of the base");
  const opts = JSON.parse(update[1][3]);
  assert.deepEqual([opts.account, opts.person, opts.switchPerson], ["bobs", "per_bob", undefined], "nothing recorded says the thread is on the member's account");
  assert.equal(stops, 1, "the hop's process is stopped");
  assert.equal(sb.live.has("t"), false, "no live process");
  assert.ok(events.some(e => e[0] === "thread.provider"), "the app's provider chip follows the base");
  assert.equal(sb.carry.has("t"), true, "what the hop answered is kept for the resume to pass on");
  assert.equal(sb.reverting.has("t"), false, "the revert mark is released before the resume");
  assert.equal(events.filter(e => e[0] === "thread.text").length, 1, "the room is told once");
  assert.match(String(events.find(e => e[0] === "thread.text")[1]), /session stopped while switching back/);
  assert.deepEqual(resumed, ["t"], "a row already waiting starts the thread again on its base, as a restart would");
  assert.deepEqual(hopProcess.writes, [], "and no queued words went into the hop's process");
});
