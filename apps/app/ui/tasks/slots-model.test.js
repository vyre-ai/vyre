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
