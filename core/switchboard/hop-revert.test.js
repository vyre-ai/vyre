// The next person's turn is judged only after a hop back has finished; past the wait it is refused, never judged on the hop's state (asker-account.js revertSettled).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { hopRefusal, revertSettled, runQueuedOver } from "./asker-account.js";
import { closeToAddedModules } from "../../lib/first-party-door.js";
import fs from "node:fs";
import { Switchboard } from "./index.js";

const LOCK = Symbol("lock");

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
    reverting: new Map(), draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, emit() {}, record: () => ({ project: null }), deps: { log() {} },
    write() { throw new Error("lent: the words may not go into a process on a computer"); },
    dropQueuedChatTurn: (/** @type {string} */ id) => drained.push("notice"),   // the room is told the words were not sent
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  Switchboard.prototype.drainRun.call(sb, "t", null, [{ id: 1, text: "x", surface: "s", uuid: "u", at: 1 }], null, LOCK);   // (logged and told, not thrown into whatever ended the turn)
  assert.equal(sb.draining.has("t"), false, "the lock is released");
  assert.deepEqual(drained, ["notice", "t"], "the room is told, and the rows behind it are drained again");
});

test("a hop whose turn ended before sendOnce resolved still drains the row behind it", async () => {
  /** @type {any[]} */ const drained = [];
  const st = { turn: null, stopping: false };
  const sb = /** @type {any} */ ({
    reverting: new Map(), draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", st]]),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => ({}), sendOnce: async () => { /* the hop's whole turn ran and ended here: its turnEnded returned at the lock */ },
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 2, text: "A-ONE", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_ada", over: { provider: "claude", account: "x", person: "per_ada" } }, () => ({ changes: 1 }), 1, LOCK);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sb.draining.has("t"), false);
  assert.deepEqual(drained, ["t"], "the thread is idle with no hop pending, so the next row is drained");
});

test("runQueuedOver past the revert wait puts the row back instead of judging it on the hop's state", async () => {
  /** @type {any[]} */ const ran = []; /** @type {any[]} */ const drained = [];
  const sb = /** @type {any} */ ({
    reverting: new Map([["t", new Promise(() => {})]]), revertWaitMs: 30, draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", { turn: null }]]),
    db: { prepare: (/** @type {string} */ q) => ({ run: (/** @type {any[]} */ ...a) => { ran.push([q.slice(0, 90), a]); return { changes: 1 }; } }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => { throw new Error("must not be judged"); }, sendOnce: async () => { throw new Error("must not run"); },
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 3, text: "B-TWO", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_bob", over: { provider: "claude", account: "y", person: "per_bob" } }, () => ({ changes: 1 }), 1, LOCK);
  await new Promise(r => setTimeout(r, 120));
  assert.ok(ran.some(r => /delivered_at = NULL/.test(r[0])), "the row is put back in the queue");
  assert.deepEqual(drained, [], "and nothing is drained or run on the wrong base");
  assert.equal(sb.draining.has("t"), false, "the lock is released");
});

test("while a hop back swaps the process nothing drains; the row behind a hop whose turn ended first is written after the revert, not during", async () => {
  /** @type {any[]} */ const drained = [];
  let finish; const revert = new Promise(r => { finish = r; });
  const sb = /** @type {any} */ ({ reverting: new Map([["t", revert]]), draining: new Map(), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]), record: () => ({ project: null }), db: { prepare: () => ({ all: () => { drained.push("read-queue"); return []; } }) } });
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
    reverting: new Map([["t", revert]]), revertWaitMs: 20, draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]),
    db: { prepare: (/** @type {string} */ q) => ({ run: () => { sql.push(q.slice(0, 50)); return { changes: 1 }; } }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => { throw new Error("must not be judged"); }, sendOnce: async () => { throw new Error("must not run"); },
    drainQueued: (/** @type {string} */ id) => drained.push(id),
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  void revert.finally(() => sb.reverting.delete("t"));   // turnEnded's own cleanup runs first
  runQueuedOver(sb, "t", [{ id: 9, text: "B-TWO", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_bob", over: { provider: "claude", account: "y", person: "per_bob" } }, () => ({ changes: 1 }), 1, LOCK);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(drained, [], "past the wait and the revert still going: nothing runs");
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(drained, ["t"], "when the revert is over, thrown or not, the put-back row is drained");
});

test("a queued row whose hop needs no move (sendOnce answers null) still delivers its words, under their asker", async () => {
  /** @type {any[]} */ const calls = [];
  const sb = /** @type {any} */ ({
    reverting: new Map(), draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, emit() {}, record: () => ({ project: null }),
    onceTarget: async () => ({}), sendOnce: async () => null,
    deliverRow: async (/** @type {string} */ id, /** @type {any} */ r, /** @type {any} */ kt) => { calls.push([id, r.text, kt.asker]); },
    drainQueued() {}, reverting_: 0,
  });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 4, text: "C-ONE", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_carol", over: { provider: "claude", account: "same", person: "per_carol" } }, () => ({ changes: 1 }), 1, LOCK);
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
  /** @type {any[]} */ const events = []; /** @type {any[]} */ const sql = []; /** @type {string[]} */ const resumed = []; /** @type {boolean[]} */ const liveAtResume = []; let stops = 0, tries = 0;
  const hopProcess = { writes: [] };
  const sb = /** @type {any} */ ({
    endHop: Switchboard.prototype.endHop, once: new Map([["t", { to: "codex", back: { provider: "claude", account: "bobs", model: "opus", person: "per_bob" }, sent: "x", reply: "" }]]), carry: new Map(), switches: new Set(), reverting: new Map(), closing: false,
    live: new Map([["t", { turn: null, stopping: false, hopProcess }]]), deps: { log() {} },
    record: () => ({ project: null, provider: "codex", account: "carols" }),
    db: { prepare: (/** @type {string} */ q) => ({ get: () => ({ opts: JSON.stringify({ account: "carols", person: "per_carol", origin: "x" }) }), run: (/** @type {any[]} */ ...a) => { sql.push([q.slice(0, 40), a]); return { changes: 1 }; } }) },
    emit: (/** @type {string} */ type, /** @type {any} */ p) => events.push([type, p.text]),
    switchProvider: async () => { tries++; throw new Error("no process"); },
    stop: async () => { stops++; sb.live.delete("t"); },
    launch: async (/** @type {any} */ o) => { resumed.push(o.resume); liveAtResume.push(sb.live.has("t")); },
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
  assert.deepEqual([opts.account, opts.person], ["bobs", "per_bob"], "nothing recorded says the thread is on the member's account");
  assert.equal(stops, 1, "the hop's process is stopped");
  assert.equal(sb.live.has("t"), false, "no live process");
  assert.ok(events.some(e => e[0] === "thread.provider"), "the app's provider chip follows the base");
  assert.equal(sb.carry.has("t"), true, "what the hop answered is kept for the resume to pass on");
  assert.equal(sb.reverting.has("t"), false, "the revert mark is released before the resume");
  assert.equal(events.filter(e => e[0] === "thread.text").length, 1, "the room is told once");
  assert.match(String(events.find(e => e[0] === "thread.text")[1]), /session stopped while switching back/);
  assert.deepEqual(resumed, ["t"], "a row already waiting starts the thread again on its base, as a restart would");
  assert.deepEqual(liveAtResume, [false], "and the thread is not live when the resume runs: nothing of the hop is left to write into");
  assert.deepEqual(hopProcess.writes, [], "and no queued words went into the hop's process");
});

test("a switch back that can never succeed (account removed) is not retried: straight to the dormant path", async () => {
  let tries = 0; /** @type {any[]} */ const events = [];
  const sb = /** @type {any} */ ({
    endHop: Switchboard.prototype.endHop, once: new Map([["t", { to: "codex", back: { provider: "claude", account: "bobs", model: null, person: "per_bob" }, sent: "x", reply: "" }]]), carry: new Map(), switches: new Set(), reverting: new Map(), closing: true,
    live: new Map(), deps: { log() {} }, record: () => ({ project: null }),
    db: { prepare: () => ({ get: () => ({ opts: "{}" }), run: () => ({ changes: 1 }) }) },
    emit: (/** @type {string} */ type) => events.push(type), stop: async () => {},
    switchProvider: async () => { tries++; throw Object.assign(new Error("that account was removed"), { code: "account_removed" }); },
  });
  sb.resumeWaiting = Switchboard.prototype.resumeWaiting;
  await Switchboard.prototype.revertOnce.call(sb, "t");
  assert.equal(tries, 1, "no retry for a failure that cannot change");
  assert.ok(events.includes("thread.text"), "and the room is told");
});

test("a late hand-over never releases the lock of a newer drain (the owner token)", () => {
  /** @type {string[]} */ const drained = [];
  const mine = Symbol("first"), theirs = Symbol("second");
  const sb = /** @type {any} */ ({ draining: new Map([["t", theirs]]), reverting: new Map(), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]), record: () => ({ project: null }), drainQueued: (/** @type {string} */ id) => drained.push(id) });
  sb.drainDone = Switchboard.prototype.drainDone;
  sb.drainDone("t", true, mine);
  assert.equal(sb.draining.get("t"), theirs, "the newer drain keeps its lock");
  assert.deepEqual(drained, [], "and nothing is drained again behind its back");
  sb.drainDone("t", true, theirs);
  assert.equal(sb.draining.has("t"), false, "its owner releases it");
  assert.deepEqual(drained, ["t"], "and the rows behind it are drained");
});

test("a lost mark releases only its own lock and drains nothing; the revert's own drain plus the finally take the lock for the same rows once", async () => {
  /** @type {string[]} */ const drained = [];
  const mine = Symbol("a"), winner = Symbol("b");
  const sb = /** @type {any} */ ({ draining: new Map([["t", winner]]), reverting: new Map(), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]), record: () => ({ project: null }), drainQueued: (/** @type {string} */ id) => drained.push(id) });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 5, text: "B-TWO", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_bob", over: { provider: "claude", account: "y", person: "per_bob" } }, () => ({ changes: 0 }), 1, mine);
  assert.equal(sb.draining.get("t"), winner, "the winner's lock is untouched");
  assert.deepEqual(drained, [], "nothing is drained again: the winner is in flight");
  // the revert's own turnEnded drain takes the lock; turnEnded's finally then asks to drain again with no token: it must not take it a second time
  let takes = 0;
  const sb2 = /** @type {any} */ ({ draining: new Map(), reverting: new Map(), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]), record: () => ({ project: null }), deps: { kernelSession: true }, canonTurn: (/** @type {any} */ x) => x, assertAsker: () => { takes++; return new Promise(() => {}); }, db: { prepare: () => ({ all: () => [{ id: 1, kturn: JSON.stringify({ chat: "c", asker: "per_ada" }), text: "A", surface: "s", uuid: "u", at: 1 }] }) } });
  sb2.drainDone = Switchboard.prototype.drainDone; sb2.drainQueued = Switchboard.prototype.drainQueued;
  sb2.drainQueued("t", sb2.live.get("t"), null);
  sb2.drainDone("t", true);
  sb2.drainQueued("t", sb2.live.get("t"), null);
  assert.equal(takes, 1, "the same rows are taken once");
  assert.equal(sb2.draining.size, 1, "and the lock is still held by the drain that took it");
});

test("a queued hop that fails after it was announced ends the announced turn first and then shows its notice, in fixed words", async () => {
  /** @type {string[]} */ const order = []; /** @type {string[]} */ const words = [];
  const sb = /** @type {any} */ ({ reverting: new Map(), draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]), record: () => ({ project: null }),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, onceTarget: async () => ({}),
    emit: (/** @type {string} */ type, /** @type {any} */ p) => { order.push(type); if (type === "thread.text") words.push(p.text); },
    endAnnouncedTurn: () => order.push("end-announced"), drainQueued() {},
    sendOnce: async (/** @type {any} */ _i, /** @type {any} */ _t, /** @type {any} */ _s, /** @type {any} */ _o, /** @type {any} */ o) => { o.onClaim(); throw Object.assign(new Error("account 7f3a9c is not yours / path /srv/x"), { code: "denied" }); } });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 7, text: "A-ONE", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_ada", over: { provider: "claude", account: "x", person: "per_ada" } }, () => ({ changes: 1 }), 1, LOCK);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(order, ["thread.sent", "end-announced", "thread.text"], "announced, then ended, then the notice");
  assert.doesNotMatch(words[0], /7f3a9c|\/srv/, "no account id or path reaches the room");
});

test("hopRefusal names the next step for each cause and never a lookup's own message", () => {
  for (const code of ["busy", "denied", "account_required", "account_unavailable", "account_removed", "not_found", "unavailable", undefined, "weird"]) {
    const text = hopRefusal(code);
    assert.match(text, /Nothing was sent/, code);
    assert.match(text, /again|Pick|Open AI accounts|add one/, `${code}: says what to do`);
  }
});

test("threads.notice is closed to added modules and capped in the Switchboard's start", async () => {
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = { tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d) };
  closeToAddedModules(ctx, { only: ["threads.notice"] });
  ctx.tool("threads.notice", { run: async () => "said" });
  await assert.rejects(async () => tools.get("threads.notice").run({}, { caller: "module:added", firstParty: false }), { code: "not_declared" });
  assert.equal(await tools.get("threads.notice").run({}, { caller: "module:agents", firstParty: true }), "said");
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /closeToAddedModules\(ctx, \{ only: \["threads\.notice"\] \}\)/, "the Switchboard's start closes it");
  assert.match(src, /\.slice\(0, 300\)/, "and the text is one line of at most 300 characters");
});

test("a queued hop past the revert wait is put back once and dropped in words the second time", async () => {
  /** @type {string[]} */ const sql = []; /** @type {string[]} */ const texts = [];
  const sb = /** @type {any} */ ({ reverting: new Map([["t", new Promise(() => {})]]), revertWaitMs: 20, draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", { turn: null }]]), record: () => ({ project: null }),
    db: { prepare: (/** @type {string} */ q) => ({ run: () => { sql.push(q.slice(0, 70)); return { changes: 1 }; } }) },
    emit: (/** @type {string} */ type, /** @type {any} */ p) => { if (type === "thread.text") texts.push(p.text); }, drainQueued() {} });
  sb.drainDone = Switchboard.prototype.drainDone;
  const row = { id: 11, text: "B-TWO", surface: "s", uuid: "u", at: 1 }, kt = { chat: "c", asker: "per_bob", over: { provider: "claude", account: "y", person: "per_bob" } };
  runQueuedOver(sb, "t", [row], kt, () => ({ changes: 1 }), 1, LOCK);
  await new Promise(r => setTimeout(r, 80));
  assert.ok(sql.some(q => /delivered_at = NULL/.test(q)), "the first time the row is put back in the queue");
  assert.deepEqual(texts, [], "and nothing is said yet");
  sb.draining.set("t", LOCK);
  runQueuedOver(sb, "t", [row], kt, () => ({ changes: 1 }), 1, LOCK);
  await new Promise(r => setTimeout(r, 80));
  assert.ok(sql.some(q => /via = 'dropped'/.test(q)), "the second time the row is dropped");
  assert.equal(texts.length, 1, "and the room is told");
  assert.match(texts[0], /could not be started.*Send it again/);
});

test("a queued hop in a team Space chat carries the Space with it: the hop's kernel session opens in that Space's kernel, where the reply looks for it", async () => {
  /** @type {any} */ let seen = null;
  const sb = /** @type {any} */ ({ reverting: new Map(), draining: new Map([["t", LOCK]]), once: new Map(), live: new Map([["t", { turn: null, stopping: false }]]), record: () => ({ project: null }),
    db: { prepare: () => ({ run: () => ({ changes: 1 }) }) }, onceTarget: async () => ({}), emit() {}, endAnnouncedTurn() {}, drainQueued() {}, deliverRow: async () => {},
    sendOnce: async (/** @type {any} */ _i, /** @type {any} */ _t, /** @type {any} */ _s, /** @type {any} */ _o, /** @type {any} */ o) => { seen = o.kernelTurn; return { sent: true }; } });
  sb.drainDone = Switchboard.prototype.drainDone;
  runQueuedOver(sb, "t", [{ id: 7, text: "A-ONE", surface: "s", uuid: "u", at: 1 }], { chat: "c", asker: "per_ada", space: "spc_aaaaaaaaaaaa", over: { provider: "claude", account: "x", person: "per_ada" } }, () => ({ changes: 1 }), 1, LOCK);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(seen, { chat: "c", asker: "per_ada", space: "spc_aaaaaaaaaaaa" });
});
