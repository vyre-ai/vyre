// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { withMe, withOwner } from "./me.js";

test("$me becomes the caller wherever it stands in a filter, and nothing else changes", () => {
  assert.deepEqual(withMe({ field: "owner", op: "eq", value: "$me" }, "per_a"), { field: "owner", op: "eq", value: "person:per_a" });
  assert.deepEqual(withMe({ and: [{ field: "owner", op: "ne", value: "$me" }, { field: "kind", op: "in", value: ["call", "$me"] }] }, "per_a"), { and: [{ field: "owner", op: "ne", value: "person:per_a" }, { field: "kind", op: "in", value: ["call", "person:per_a"] }] });
  assert.deepEqual(withMe({ field: "name", op: "eq", value: "me" }, "per_a"), { field: "name", op: "eq", value: "me" });
  assert.equal(withMe(undefined, "per_a"), undefined);
});

test("a new note, communication or event is owned by the person who makes it, whatever the body says", () => {
  const fields = [{ name: "owner" }];
  assert.equal(withOwner("record-note", fields, { body: "x", owner: "person:someone_else" }, "per_a").owner, "person:per_a");
  assert.equal(withOwner("event", fields, { title: "x" }, "per_a").owner, "person:per_a");
  assert.deepEqual(withOwner("deal", fields, { name: "x" }, "per_a"), { name: "x" }, "other types are left alone");
  assert.deepEqual(withOwner("event", [], { title: "x" }, "per_a"), { title: "x" }, "a type without the field is left alone");
});
