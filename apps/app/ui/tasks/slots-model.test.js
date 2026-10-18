import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stateStrip, stateWord, slotsOf, reviewWords, nowLine, holderWords } from "./slots-model.js";

const names = (kind, id) => ({ assistant: "Assistant", engineer: "Engineer", ana: "Ana", admins: "Admins" })[id] ?? id;

test("states read in the owner's words and the strip swaps in changes requested or declined", () => {
  assert.deepEqual(["ready", "working", "in_review", "needs_check", "done", "changes_requested", "declined"].map(stateWord), ["To do", "Doing", "In review", "Awaiting approval", "Done", "Changes requested", "Declined"]);
  assert.deepEqual(stateStrip("changes_requested"), ["ready", "working", "changes_requested", "needs_check", "done"]);
  assert.deepEqual(stateStrip("declined"), ["ready", "working", "in_review", "needs_check", "declined"]);
});

test("a task shows only the slots it has, groups and roles as 'the Admins'", () => {
  const t = { doer: { kind: "agent", id: "assistant" }, checker: { kind: "role", id: "admins" } };
  assert.deepEqual(slotsOf(t, names).map((s) => [s.key, s.who]), [["doer", "Assistant"], ["approver", "the Admins"]]);
  assert.deepEqual(slotsOf({ doer: { kind: "person", id: "ana" }, reviewer: { kind: "agent", id: "engineer" } }, names).map((s) => s.key), ["doer", "reviewer"]);
  assert.equal(holderWords({ role: "owners" }, names), "the owners");
});

test("a review says how many items hold and marks an agent's ticks; a skipped review says why", () => {
  const t = { review: { by: { kind: "agent", id: "engineer" }, type: "agent", result: "pass", checklist: [{ skill: "k5", item: "A", ok: true }, { skill: "k9", item: "B", ok: false }] }, review_note: "Link 404s" };
  const r = reviewWords(t, names);
  assert.equal(r.line, "Engineer checked it: 1 of 2 items hold (ticked by an agent)");
  assert.deepEqual(r.items.map((x) => x.ok), [true, false]);
  assert.equal(r.note, "Link 404s");
  assert.equal(reviewWords({ review_skipped: { why: "No one else to check this", members: 1 } }, names).skipped, "No one else to check this");
});

test("the Now line says what is ready and who did what", () => {
  const t = { title: "Launch email draft", state: "needs_check", doer: { kind: "agent", id: "assistant" }, output: { kind: "draft" }, review: { by: { kind: "agent", id: "engineer" }, type: "agent", result: "pass", checklist: [] } };
  assert.deepEqual(nowLine(t, names, "me"), { title: "Launch email draft is ready for your approval", sub: "Assistant drafted it, Engineer checked it against the checklist." });
});

test("the reviewer's checklist is read from the task and a pass needs every item answered", async () => {
  const { checklistOf, reviewGate, reviewInput } = await import("./slots-model.js");
  const task = { slots: { reviewer: { holder: { kind: "person", id: "ana" }, checklist: [{ skill: "voice", item: "Plain words" }, { skill: "voice", item: "No jargon" }] } } };
  const list = checklistOf(task);
  assert.equal(list.length, 2);
  assert.deepEqual(checklistOf({}), []);
  assert.equal(reviewGate(list, {}, "").pass, false);
  assert.match(reviewGate(list, { "voice:Plain words": true }, "").why, /1 item still/);
  const all = { "voice:Plain words": true, "voice:No jargon": true };
  assert.equal(reviewGate(list, all, "").pass, true);
  const miss = { "voice:Plain words": true, "voice:No jargon": false };
  assert.equal(reviewGate(list, miss, "").pass, false, "a missed item blocks a pass without a note");
  assert.equal(reviewGate(list, miss, "Fine for an internal note").pass, true);
  assert.equal(reviewGate([], {}, "").pass, true, "no skills, nothing to tick");
  assert.equal(reviewGate([], {}, "").changes, false, "changes need a note");
  assert.deepEqual(reviewInput("pass", list, all, " ok "), { result: "pass", checklist: [{ skill: "voice", item: "Plain words", ok: true }, { skill: "voice", item: "No jargon", ok: true }], note: "ok" });
  assert.deepEqual(reviewInput("changes", [], {}, "Shorter"), { result: "changes", note: "Shorter" });
});
