// Tool steps as collapsed runs: three in a row fold into one line, anything between ends a run, a teammate's steps never fold, and the words say what is running or how many ran.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupToolRuns, runWords } from "./tool-runs.js";

const row = (/** @type {string} */ key, kind = "tool") => ({ type: /** @type {"item"} */ ("item"), key, kind });
const items = (/** @type {Record<string, any>} */ o) => (/** @type {string} */ k) => o[k] ?? null;

test("runs: three or more steps in a row are one row, keyed by the first so it holds as it grows", () => {
  const it = items({ a: {}, b: {}, c: {}, d: {} });
  const out = groupToolRuns([row("u", "user"), row("a"), row("b"), row("c"), row("d"), row("t", "text")], it);
  assert.deepEqual(out.map((r) => [r.key, r.kind]), [["u", "user"], ["r:a", "toolrun"], ["t", "text"]]);
  assert.deepEqual(out[1].keys, ["a", "b", "c", "d"]);
  assert.equal(groupToolRuns([row("a"), row("b"), row("c")], it)[0].key, "r:a");
  assert.equal(groupToolRuns([row("a"), row("b"), row("c"), row("d")], it)[0].key, "r:a", "the key does not move when a step arrives");
});

test("runs: two steps stay two lines; text, a block or a user message between ends a run; a teammate's steps never fold", () => {
  const it = items({ a: {}, b: {}, c: {}, d: {}, e: { via: "r_1" }, f: { via: "r_1" }, g: { via: "r_1" } });
  assert.deepEqual(groupToolRuns([row("a"), row("b")], it).map((r) => r.kind), ["tool", "tool"]);
  assert.deepEqual(groupToolRuns([row("a"), row("b"), row("x", "text"), row("c"), row("d")], it).map((r) => r.kind), ["tool", "tool", "text", "tool", "tool"]);
  assert.deepEqual(groupToolRuns([row("a"), row("b"), row("blk", "block"), row("c"), row("d"), row("e")], it).map((r) => r.kind), ["tool", "tool", "block", "tool", "tool", "tool"]);
  assert.deepEqual(groupToolRuns([row("e"), row("f"), row("g")], it).map((r) => r.kind), ["tool", "tool", "tool"], "a teammate's steps stay under their hand-off");
  assert.deepEqual(groupToolRuns([], it), []);
});

test("run words: Ran N steps when done, with what failed; what is running and the count so far while it runs", () => {
  const s = (/** @type {string} */ status, summary = "") => ({ status, summary });
  assert.deepEqual(runWords([s("completed"), s("completed"), s("completed"), s("completed")]), { title: "Ran 4 steps", running: false, failed: 0 });
  assert.equal(runWords([s("completed"), s("failed"), s("completed")]).title, "Ran 3 steps, 1 failed");
  assert.deepEqual(runWords([s("completed", "Looking up invoices"), s("completed"), s("running", "Drafting three reminders")]), { title: "Drafting three reminders · 3 steps so far", running: true, failed: 0 });
  assert.equal(runWords([s("running")]).title, "Working · 1 step so far");
});
