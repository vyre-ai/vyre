import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ageOf, ordered, stateOf, subOf, wordOf } from "./chat-model.js";

const T = (o = {}) => ({ id: "t", name: "Probate intake", agent: "juno", project: null, status: "working", asks: 0, last: 1000, model: "sonnet", ...o });

test("a session needing the person comes first, then failed, running and done", () => {
  assert.equal(stateOf(T({ asks: 2 })), "needs-you");
  assert.equal(stateOf(T({ status: "stopped", stopped_reason: "crashed" })), "failed");
  assert.equal(stateOf(T()), "running");
  assert.equal(stateOf(T({ status: "stopped", stopped_reason: "idle" })), "done");
  const l = ordered([T({ id: "a", status: "stopped", last: 9 }), T({ id: "b", asks: 1, last: 1 }), T({ id: "c", last: 5 })]);
  assert.deepEqual(l.map((t) => t.id), ["b", "c", "a"]);
});

test("the words say what the session is doing", () => {
  assert.equal(wordOf(T({ asks: 1 })), "1 waiting on you");
  assert.equal(wordOf(T({ status: "stopped", stopped_reason: "idle" })), "idle");
  assert.equal(subOf(T({ projectName: "Juniper estate" })), "running · juno · Juniper estate · sonnet");
});

test("the age is the biggest whole unit", () => {
  assert.equal(ageOf(0, 30_000), "now");
  assert.equal(ageOf(0, 5 * 60_000), "5m");
  assert.equal(ageOf(0, 3 * 3_600_000), "3h");
  assert.equal(ageOf(0, 2 * 86_400_000), "2d");
});
