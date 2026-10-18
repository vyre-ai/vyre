// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanLayout, effective } from "./layout.js";

test("a layout keeps only what it knows and checks each part", () => {
  const l = cleanLayout({ columns: ["name", "email", "name"], sort: { field: "name" }, group_by: "stage", filters: [{ field: "stage", op: "ne", value: "Lost" }, { field: "email", op: "empty" }], header_fields: { client: ["phone", "email"] }, related: [{ type: "task", via: "contact" }], field_groups: [{ name: "Contact", fields: ["email", "phone"] }], junk: 1 });
  assert.deepEqual(l.columns, ["name", "email"]);
  assert.deepEqual(l.sort, { field: "name", dir: "asc" });
  assert.deepEqual(l.filters, [{ field: "stage", op: "ne", value: "Lost" }, { field: "email", op: "empty" }]);
  assert.deepEqual(l.related, [{ type: "task", via: "contact", label: "task" }]);
  assert.ok(!("junk" in l));
});

test("bad parts are refused in words", () => {
  assert.throws(() => cleanLayout([]), /A layout is an object/);
  assert.throws(() => cleanLayout({ columns: ["Bad Name"] }), /columns is a list/);
  assert.throws(() => cleanLayout({ sort: { field: "x", dir: "up" } }), /sort is/);
  assert.throws(() => cleanLayout({ filters: [{ field: "x", op: "like", value: 1 }] }), /op one of/);
  assert.throws(() => cleanLayout({ filters: [{ field: "x", op: "gt" }] }), /needs a value/);
  assert.throws(() => cleanLayout({ filters: [{ field: "x", op: "in", value: "a" }] }), /that is a list/);
  assert.throws(() => cleanLayout({ field_groups: [{ name: "A", fields: [] }, { name: "a", fields: [] }] }), /its own name/);
  assert.throws(() => cleanLayout({ related: [{ type: "task" }] }), /A related list is/);
});

test("a person's layout lies over the Space's, key by key, and says which is which", () => {
  const e = effective({ columns: ["name"], sort: { field: "name", dir: "asc" } }, { columns: ["name", "email"] });
  assert.deepEqual(e.layout, { columns: ["name", "email"], sort: { field: "name", dir: "asc" } });
  assert.deepEqual(e.source, { columns: "mine", sort: "space" });
  assert.deepEqual(effective(undefined, undefined), { layout: {}, source: {} });
});
