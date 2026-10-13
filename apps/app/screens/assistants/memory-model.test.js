// An agent's Memory pane: its rows, which are lessons, and the instruction a lesson becomes.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { memoryRows, lessonText, isPromoted, withLesson, sourceLine } from "./memory-model.js";

const W = (o) => ({ id: "mw_1", kind: "fact", text: "x", state: "live", at: 100, from: { kind: "agent", name: "juno", thread: null, seq: null }, projects: [], ...o });

test("rows are newest first, labelled by kind, and a correction is a Lesson without the lead-in", () => {
  const rows = memoryRows("juno", [W({ id: "a", at: 100, text: "Dana prefers email" }), W({ id: "b", at: 300, kind: "correction", text: "an agent reports the person corrected: office is in Austin", from: { kind: "agent", name: "juno", thread: "thr_9", seq: 2 } }), W({ id: "c", at: 200, kind: "decision", text: "Use the long form" })], []);
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.lesson]), [["b", "Lesson", true], ["c", "Decision", false], ["a", "Fact", false]]);
  assert.equal(rows[0].text, "office is in Austin");
  assert.equal(rows[0].href, "/u/chats/thr_9");
  assert.deepEqual(rows[0].forget, { tool: "memory.write.forget", input: { id: "b" } });
});

test("a forgotten write is not shown", () => {
  assert.equal(memoryRows("juno", [W({ state: "forgotten" })], []).length, 0);
});

test("a heard correction from this agent is a Lesson; another agent's is not; one already filed as a write is one row", () => {
  const heard = [
    { thread: "t1", seq: 1, at: 50, by: "mcp:agent:juno", summary: "Sam moved to Reno", undo: { tool: "memory.uncorrect", input: { fix: 4 } } },
    { thread: "t2", seq: 1, at: 60, by: "mcp:agent:rex", summary: "other", undo: {} },
    { thread: "t3", seq: 5, at: 70, by: "harness:agent:juno", summary: "filed too", undo: {} },
  ];
  const rows = memoryRows("juno", [W({ id: "w", kind: "correction", at: 71, text: "filed too", from: { kind: "agent", name: "juno", thread: "t3", seq: 5 } })], heard);
  assert.deepEqual(rows.map((r) => r.id), ["w", "heard:t1#1"]);
  assert.deepEqual(rows[1].forget, { tool: "memory.uncorrect", input: { fix: 4 } });
});

test("where it came from", () => {
  assert.deepEqual(sourceLine({ thread: "a b" }), { line: "From a chat", href: "/u/chats/a%20b" });
  assert.equal(sourceLine({ ref: "vyre://s/record/1" }).line, "From a file");
  assert.equal(sourceLine({ project: "acme" }).line, "In acme");
  assert.equal(sourceLine({}).line, "Added by hand");
});

test("a lesson is added under a new Lessons heading, then below the bullets already there, never twice", () => {
  const one = withLesson("You are Juno.\n", "an agent reports the person corrected: sign emails Dana");
  assert.equal(one, "You are Juno.\n\n## Lessons\n\n- sign emails Dana\n");
  const two = withLesson(one, "never CC the client");
  assert.equal(two, "You are Juno.\n\n## Lessons\n\n- sign emails Dana\n- never CC the client\n");
  assert.equal(withLesson(two, "Sign emails  Dana"), two);
  assert.equal(isPromoted(two, "sign emails Dana"), true);
  assert.equal(isPromoted("You are Juno.", "sign emails Dana"), false);
});

test("a Lessons section in the middle keeps the sections after it", () => {
  const doc = "# Juno\n\n## Lessons\n\n- a\n\n## Tools\n\nuse the vault\n";
  assert.equal(withLesson(doc, "b"), "# Juno\n\n## Lessons\n\n- a\n- b\n\n## Tools\n\nuse the vault\n");
  assert.equal(isPromoted(doc, "use the vault"), false, "text in another section is not a promoted lesson");
});

test("an empty lesson changes nothing", () => {
  assert.equal(withLesson("abc", "   "), "abc");
  assert.equal(lessonText("an agent reports the person corrected:   hi  there "), "hi there");
});
