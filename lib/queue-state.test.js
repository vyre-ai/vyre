// @ts-check
// The state machine of a message typed while the assistant works: pure, no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transition, isFinal, isWaiting, describe, reduce, toUserMessage, STATES } from "./queue-state.js";

test("transition: sent to queued to picked-up; edited stays waiting; final states never move", () => {
  assert.equal(transition(null, "queued"), "queued");
  assert.equal(transition("sent", "queued"), "queued");
  assert.equal(transition("queued", "edited"), "edited");
  assert.equal(transition("edited", "edited"), "edited");
  assert.equal(transition("edited", "picked-up"), "picked-up");
  assert.equal(transition("queued", "cancelled"), "cancelled");
  // A late or repeated event never moves a message backwards or out of a final state.
  assert.equal(transition("picked-up", "queued"), "picked-up");
  assert.equal(transition("picked-up", "cancelled"), "picked-up");
  assert.equal(transition("cancelled", "picked-up"), "cancelled");
  assert.equal(transition("queued", "queued"), "queued");
  assert.deepEqual(STATES.filter(isFinal), ["picked-up", "cancelled"]);
  assert.deepEqual(STATES.filter(isWaiting), ["queued", "edited"]);
});

test("describe: each switchboard event is the state it puts its message in", () => {
  assert.equal(describe({ type: "thread.sent", payload: { uuid: "u", via: "steer" } })?.state, "queued");
  assert.equal(describe({ type: "thread.sent", payload: { uuid: "u" } })?.state, "picked-up");
  assert.equal(describe({ type: "thread.sent", payload: { uuid: "u", via: "restored" } })?.state, "picked-up");
  assert.equal(describe({ type: "thread.queued", payload: { uuid: "u", queued: 3 } })?.state, "queued");
  assert.equal(describe({ type: "thread.queued", payload: { uuid: "u", queued: 3, edited: true } })?.state, "edited");
  assert.equal(describe({ type: "thread.steered", payload: { uuid: "u" } })?.state, "picked-up");
  assert.equal(describe({ type: "thread.unqueued", payload: { uuid: "u", queued: 3 } })?.state, "cancelled");
  assert.equal(describe({ type: "thread.text", payload: {} }), null);
});

test("reduce: a log folds to one state per message, keeping its words, and replaying is safe", () => {
  const log = [
    { type: "thread.queued", payload: { uuid: "a", queued: 1, text: "first", queued_at: 100, step: 2 } },
    { type: "thread.queued", payload: { uuid: "a", queued: 1, text: "first, edited", edited: true } },
    { type: "thread.sent", payload: { uuid: "b", via: "steer", text: "steer me", queued_at: 110, step: 2 } },
    { type: "thread.queued", payload: { uuid: "c", queued: 2, text: "take back" } },
    { type: "thread.unqueued", payload: { uuid: "c", queued: 2 } },
    { type: "thread.steered", payload: { uuid: "b", step: 3, text: "steer me", queued_at: 110 } },
    { type: "thread.sent", payload: { uuid: "a", queued: 1, via: "turn", text: "first, edited" } },
  ];
  const r = reduce(log);
  assert.deepEqual([...r].map(([k, v]) => [k, v.state]), [["a", "picked-up"], ["b", "picked-up"], ["c", "cancelled"]]);
  assert.equal(r.get("a")?.queued_at, 100, "the first time stays");
  assert.equal(r.get("b")?.step, 3);
  assert.deepEqual([...reduce([...log, ...log])].map(([k, v]) => [k, v.state]), [["a", "picked-up"], ["b", "picked-up"], ["c", "cancelled"]]);
});

test("toUserMessage: the stream's user-message frame data, never for a cancelled message", () => {
  assert.deepEqual(toUserMessage({ type: "thread.queued", payload: { uuid: "u", text: "hi", queued_at: 5, step: 1 } }), { message: "u", text: "hi", state: "queued", queued_at: 5, step: 1 });
  assert.equal(toUserMessage({ type: "thread.queued", payload: { uuid: "u", text: "hi!", edited: true } })?.state, "queued");
  assert.deepEqual(toUserMessage({ type: "thread.steered", payload: { uuid: "u", text: "hi", queued_at: 5, step: 4 } }), { message: "u", text: "hi", state: "picked-up", queued_at: 5, step: 4 });
  assert.equal(toUserMessage({ type: "thread.unqueued", payload: { uuid: "u" } }), null);
  assert.equal(toUserMessage({ type: "thread.finished", payload: {} }), null);
});
