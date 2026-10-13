import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isTagsField, tagsOf, withTag, withoutTag, tally, suggest, tagChip, tagOfChip, tagWords, stored } from "./model.js";
import { matches } from "../fields/logic.js";

test("only the text field named tags is a tags field", () => {
  assert.equal(isTagsField({ name: "tags", kind: "text" }), true);
  assert.equal(isTagsField({ name: "tags", kind: "number" }), false);
  assert.equal(isTagsField({ name: "notes", kind: "text" }), false);
  assert.equal(isTagsField(null), false);
});

test("adding and removing keep one spelling and no repeats", () => {
  let t = withTag("", "#Trust");
  t = withTag(t, "estate plan");
  t = withTag(t, "trust");
  assert.deepEqual(tagsOf(t), ["trust", "estate-plan"]);
  assert.deepEqual(tagsOf(withoutTag(t, "trust")), ["estate-plan"]);
  assert.equal(withoutTag(withoutTag(t, "trust"), "estate-plan"), "");
  assert.throws(() => withTag("", "bad!word"), /lower-case letters/);
  assert.equal(stored(["a", "a", "B"]), '["a","b"]');
});

test("tally counts across rows, most used first", () => {
  const rows = [{ data: { tags: '["b","a"]' } }, { data: { tags: '["a"]' } }, { data: {} }, { data: { tags: "not json" } }];
  assert.deepEqual(tally(rows), [{ tag: "a", count: 2 }, { tag: "b", count: 1 }]);
});

test("suggest hides what is on the thing and puts prefix matches first", () => {
  assert.deepEqual(suggest(["alpha", "beta", "delta"], ["beta"], ""), ["alpha", "delta"]);
  assert.deepEqual(suggest(["alpha", "plan-a", "plan"], [], "pl"), ["plan-a", "plan"]);
  assert.deepEqual(suggest(["alpha"], [], "zz"), []);
});

test("the filter chip finds the whole tag only, and reads back as words", () => {
  const c = tagChip("Trust");
  assert.deepEqual(c, { field: "tags", op: "contains", operand: '"trust"' });
  assert.equal(tagOfChip(c), "trust");
  assert.equal(tagWords(c), "Tagged #trust");
  assert.equal(tagOfChip({ field: "name", op: "contains", operand: "x" }), null);
  assert.equal(tagWords({ field: "tags", op: "contains", operand: "plain" }), null);
  const holds = (stored_) => matches("text", c.op, c.operand, stored_);
  assert.equal(holds('["trust","estate"]'), true);
  assert.equal(holds('["trusted"]'), false);
});
