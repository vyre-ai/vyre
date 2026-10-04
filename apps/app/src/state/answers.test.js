// @ts-check
// The approve swipe's answers (answers.ts): held for the Undo window, then through the outbox;
// Undo only while unsent; a refusal brings the row back with its reason. Time and delivery are
// fakes, so every step is exact.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./answers.ts");

/** A need, as needs-model.ts makes it. @param {string} id */
const need = id => /** @type {any} */ ({ id, source: "ask", ref: id.slice(4), kind: "permission", title: "Run a command", detail: "npm test",
  mono: true, agent: "kit", project: "Harlow Legal", thread: "t1", at: 1, presence: { required: false, covered: false, since: null } });

/** Fake timers and a delivery that resolves when the test says. */
function world() {
  let now = 1000;
  /** @type {Map<number, { at: number, f: () => void }>} */
  const timers = new Map();
  let seq = 0;
  /** @type {{ need: any, decision: string, resolve: (o: any) => void }[]} */
  const sent = [];
  let changes = 0;
  /** @type {any[]} */
  const done = [];
  const deps = {
    undoMs: 4000,
    now: () => now,
    setTimer: (/** @type {() => void} */ f, /** @type {number} */ ms) => { const id = ++seq; timers.set(id, { at: now + ms, f }); return id; },
    clearTimer: (/** @type {any} */ t) => { timers.delete(t); },
    deliver: (/** @type {any} */ n, /** @type {string} */ d) => new Promise(resolve => sent.push({ need: n, decision: d, resolve })),
    onChange: () => { changes++; },
    onDone: (/** @type {any} */ n) => { done.push(n.id); },
  };
  /** @param {number} ms */
  const advance = ms => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.f(); }
  };
  return { deps, sent, done, advance, timers, get changes() { return changes; } };
}

const tick = () => new Promise(r => setImmediate(r));

test("answers: a commit hides the row at once and reaches the outbox only when Undo is over", { skip: !strip }, async () => {
  const { createAnswers, visibleNeeds } = await load();
  const w = world();
  const a = createAnswers(w.deps);
  const list = [need("ask:a1"), need("ask:a2")];
  assert.equal(a.commit(list[0], "approve"), true);
  assert.deepEqual(visibleNeeds(list, a.hidden()).map(n => n.id), ["ask:a2"], "collapsed on commit, before any send");
  assert.equal(a.latestHeld()?.id, "ask:a1");
  assert.equal(w.sent.length, 0, "nothing sent inside the Undo window");
  w.advance(3999);
  assert.equal(w.sent.length, 0);
  w.advance(1);
  assert.equal(w.sent.length, 1, "sent when the 4 s window closes");
  assert.equal(a.get("ask:a1")?.phase, "sending");
  assert.equal(a.undo("ask:a1"), false, "no Undo once it is in the outbox");
  assert.equal(a.latestHeld(), null, "the toast goes when Undo can no longer work");
  w.sent[0].resolve({ ok: true });
  await tick();
  assert.equal(a.get("ask:a1")?.phase, "done");
  assert.deepEqual(w.done, ["ask:a1"]);
  assert.ok(a.hidden().has("ask:a1"), "stays gone until its event takes it off the list");
  a.prune(["ask:a2"]);
  assert.equal(a.get("ask:a1"), undefined);
});

test("answers: Undo inside the window brings the row back and sends nothing", { skip: !strip }, async () => {
  const { createAnswers, visibleNeeds } = await load();
  const w = world();
  const a = createAnswers(w.deps);
  const n = need("ask:a1");
  a.commit(n, "reject");
  w.advance(2000);
  assert.equal(a.undo("ask:a1"), true);
  assert.deepEqual(visibleNeeds([n], a.hidden()).map(x => x.id), ["ask:a1"]);
  assert.equal(w.timers.size, 0, "its timer is gone");
  w.advance(10_000);
  assert.equal(w.sent.length, 0);
});

test("answers: a refusal brings the row back with the box's reason", { skip: !strip }, async () => {
  const { createAnswers } = await load();
  const w = world();
  const a = createAnswers(w.deps);
  a.commit(need("ask:a1"), "approve");
  // Undo closed early: flush sends now and waits for the box, which the test answers.
  void a.flush("ask:a1");
  assert.equal(w.sent.length, 1);
  w.sent[0].resolve({ ok: false, reason: "the thread stopped" });
  await tick();
  assert.equal(a.get("ask:a1")?.phase, "refused");
  assert.equal(a.hidden().has("ask:a1"), false);
  assert.equal(a.refused().get("ask:a1"), "the thread stopped");
  assert.equal(a.commit(need("ask:a1"), "reject"), true, "a refused row can be answered again");
  assert.equal(a.get("ask:a1")?.phase, "held");
});

test("answers: a second swipe on a row mid-answer is ignored; flushAll sends every held answer", { skip: !strip }, async () => {
  const { createAnswers } = await load();
  const w = world();
  const a = createAnswers(w.deps);
  assert.equal(a.commit(need("ask:a1"), "approve"), true);
  assert.equal(a.commit(need("ask:a1"), "reject"), false);
  a.commit(need("ask:a2"), "reject");
  void a.flushAll();
  await tick();
  assert.deepEqual(w.sent.map(s => [s.need.id, s.decision]), [["ask:a1", "approve"], ["ask:a2", "reject"]]);
  assert.equal(w.timers.size, 0);
});

test("answers: an entry the outbox holds for a proof comes back with why; late answers do not revive it", { skip: !strip }, async () => {
  const { createAnswers } = await load();
  const w = world();
  const a = createAnswers(w.deps);
  a.commit(need("ask:a1"), "approve");
  w.advance(4000);
  a.refuse("ask:a1", "Needs Face ID on this device");
  assert.equal(a.refused().get("ask:a1"), "Needs Face ID on this device");
  a.dismiss("ask:a1");
  assert.equal(a.size, 0);
  w.sent[0].resolve({ ok: true });
  await tick();
  assert.equal(a.size, 0, "an answer that settles after its row was dismissed changes nothing");
  assert.deepEqual(w.done, []);
});
