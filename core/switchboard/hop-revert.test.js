// The next person's turn is judged only after a hop back has finished; past the wait it is refused, never judged on the hop's state (asker-account.js revertSettled).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { revertSettled, runQueuedOver } from "./asker-account.js";

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
