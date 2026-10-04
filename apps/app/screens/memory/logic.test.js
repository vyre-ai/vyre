import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, edit, forget, group, restore, subjectOf, visible } from "./logic.js";

const F = (id, sp, subj, kind, text = id) => ({ id, sp, subj, kind, text, src: { kind: "chat", label: "x" }, by: "kit", when: "Today", used: 1 });
const facts = [F("a", "harlow", "jane", "person"), F("b", "harlow", "jane", "person"), F("c", "mine", "sam", "person"), F("d", "harlow", "estate", "project")];
const subjects = { jane: "Jane Doe", sam: "Sam", estate: "Doe estate plan" };

test("a space scope reads only its own facts", () => {
  assert.equal(visible(facts, "all").length, 4);
  assert.deepEqual(visible(facts, "mine").map((f) => f.id), ["c"]);
});

test("grouping keeps one section per subject and space, in order", () => {
  const g = group(facts, "person");
  assert.deepEqual(g.map((x) => [x.subj, x.sp, x.facts.length]), [["jane", "harlow", 2], ["sam", "mine", 1]]);
});

test("forget removes one fact and undo puts it back in place", () => {
  const { facts: after, undo } = forget(facts, "b");
  assert.equal(after.length, 3);
  assert.deepEqual(restore(after, undo).map((f) => f.id), ["a", "b", "c", "d"]);
  assert.equal(forget(facts, "zzz").undo, null);
});

test("edit changes the text and ignores an empty edit", () => {
  assert.equal(edit(facts, "a", "  New  ").find((f) => f.id === "a").text, "New");
  assert.equal(edit(facts, "a", "   ").find((f) => f.id === "a").text, "a");
});

test("the answer cites each fact, and stops at the space boundary", () => {
  assert.equal(subjectOf(subjects, "j"), null);
  const ok = answer(facts, subjects, "Jane", "all");
  assert.equal(ok.kind, "ok");
  assert.deepEqual(ok.items.map((i) => i.n), [1, 2]);
  assert.equal(answer(facts, subjects, "Jane", "mine").kind, "boundary");
  assert.equal(answer(facts, subjects, "Nobody", "all").kind, "none");
});
