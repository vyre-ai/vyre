// Type-level edits: put a field in or out of a list, reorder inside its group, write groups back onto fields, read a stored rule.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { putField, moveField, regroup, parseRule } from "./typeedit.js";

const F = [{ name: "a", label: "A", kind: "text", group: "X" }, { name: "b", label: "B", kind: "text" }, { name: "c", label: "C", kind: "text", group: "X" }, { name: "d", label: "D", kind: "text", group: "Y" }];

test("putField replaces by name or appends", () => {
  assert.deepEqual(putField(F, { name: "b", label: "B2", kind: "text" }, "b").map((f) => f.label), ["A", "B2", "C", "D"]);
  assert.equal(putField(F, { name: "e", label: "E", kind: "text" }).at(-1).name, "e");
});

test("a field moves past the nearest field of its own group, and stops at the group's edge", () => {
  assert.deepEqual(moveField(F, "a", 1).map((f) => f.name), ["c", "b", "a", "d"]);
  assert.equal(moveField(F, "a", -1), F);
  assert.equal(moveField(F, "d", 1), F);
});

test("groups written back: a field takes the group its row says, none removes the key", () => {
  const rows = [{ name: "a", group: "X2" }, { name: "b" }, { name: "c" }, { name: "d", group: "Y" }];
  const out = regroup(F, rows);
  assert.equal(out[0].group, "X2");
  assert.equal("group" in out[2], false);
  assert.equal(out[3].group, "Y");
});

test("a stored rule reads back into a pick, anything else stays an expression", () => {
  assert.deepEqual(parseRule('plan == "Trust"'), { field: "plan", op: "is", value: "Trust" });
  assert.deepEqual(parseRule('plan != "Will"'), { field: "plan", op: "is_not", value: "Will" });
  assert.deepEqual(parseRule("not empty(trust_name)"), { field: "trust_name", op: "filled" });
  assert.equal(parseRule("a > 3 and b"), null);
  assert.equal(parseRule(""), null);
});
