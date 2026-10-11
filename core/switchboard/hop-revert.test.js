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
    draining: new Set(["t"]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, emit() {}, record: () => ({ project: null }), deps: { log() {} },
    write() { throw new Error("lent: the words may not go into a process on a computer"); },
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  assert.throws(() => Switchboard.prototype.drainRun.call(sb, "t", null, [{ id: 1, text: "x", surface: "s", uuid: "u", at: 1 }], null), /lent/);
  assert.equal(sb.draining.has("t"), false, "the lock is released");
  assert.deepEqual(drained, ["t"], "and the rows behind it are drained again");
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
    db: { prepare: (/** @type {string} */ q) => ({ run: (/** @type {any[]} */ ...a) => { ran.push([q.slice(0, 40), a]); return { changes: 1 }; } }) }, emit() {}, record: () => ({ project: null }),
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
