// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLayout, hasLayout, holdsCondition, layoutRows, toggleName, moveName, withKey, hasMine, ownLayout } from "./layout.js";
import { listColumns, viewDefOf } from "./logic.js";
import { tableFromRecords } from "./records-table.js";

// a type name that has no entry in view-defs.js, so the test follows its own fields and not a shipped type's columns
const def = { name: "widget", label: "Widget", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "value", kind: "money", label: "Value" }, { name: "owner", kind: "text", label: "Owner" }, { name: "close", kind: "date", label: "Close" }] };

test("a layout lies over the view: its columns and sort replace the view's, the rest stays", () => {
  const vd = { plural: "Deals", titleField: "name", list: { columns: ["owner"], sort: "name" }, board: { groupBy: "stage", card: [] } };
  const out = applyLayout(vd, { columns: ["value", "close"], sort: { field: "value", dir: "desc" } });
  assert.deepEqual(out.list, { columns: ["value", "close"], sort: "value", sortDir: "desc" });
  assert.equal(out.board, vd.board);
  assert.equal(applyLayout(vd, {}), vd);
  assert.equal(applyLayout(vd, undefined), vd);
  assert.equal(applyLayout(vd, { filters: [] }), vd, "only columns and sort change the view");
  assert.equal(hasLayout({}), false);
  assert.equal(hasLayout({ columns: ["a"] }), true);
});

test("conditions: equal, not, contains, in, comparisons, empty", () => {
  const d = { name: "Northwind phase 2", value: { amount: 24000, currency: "USD" }, owner: "Dana", tags: ["a", "b"] };
  assert.equal(holdsCondition(d, { field: "owner", op: "eq", value: "dana" }), true);
  assert.equal(holdsCondition(d, { field: "owner", op: "ne", value: "Sam" }), true);
  assert.equal(holdsCondition(d, { field: "name", op: "contains", value: "PHASE" }), true);
  assert.equal(holdsCondition(d, { field: "owner", op: "in", value: ["Sam", "Dana"] }), true);
  assert.equal(holdsCondition(d, { field: "value", op: "gt", value: 8000 }), true);
  assert.equal(holdsCondition(d, { field: "value", op: "lt", value: 8000 }), false);
  assert.equal(holdsCondition(d, { field: "value", op: "gte", value: 24000 }), true);
  assert.equal(holdsCondition(d, { field: "tags", op: "eq", value: "b" }), true, "a list holds when any of it does");
  assert.equal(holdsCondition(d, { field: "close", op: "empty" }), true);
  assert.equal(holdsCondition(d, { field: "owner", op: "notempty" }), true);
  assert.equal(holdsCondition(d, { field: "close", op: "gt", value: 1 }), false, "no value never compares");
});

test("rows are kept only when every condition holds", () => {
  const rows = [{ data: { owner: "Dana", value: 100 } }, { data: { owner: "Sam", value: 900 } }, { data: { owner: "Dana", value: 900 } }];
  assert.equal(layoutRows(rows, [{ field: "owner", op: "eq", value: "Dana" }, { field: "value", op: "gt", value: 500 }]).length, 1);
  assert.equal(layoutRows(rows, []).length, 3);
  assert.equal(layoutRows(rows, undefined).length, 3);
});

test("the column list: turn one on or off, move one, and an end stays", () => {
  assert.deepEqual(toggleName(["a", "b"], "b"), ["a"]);
  assert.deepEqual(toggleName(["a"], "c"), ["a", "c"]);
  assert.deepEqual(moveName(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveName(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(moveName(["a", "b"], "x", 1), ["a", "b"]);
});

test("a key is replaced, or dropped when it says nothing; reset has something to do only when a key is the person's", () => {
  assert.deepEqual(withKey({ columns: ["a"] }, "sort", { field: "a", dir: "asc" }), { columns: ["a"], sort: { field: "a", dir: "asc" } });
  assert.deepEqual(withKey({ columns: ["a"] }, "columns", []), {});
  assert.equal(hasMine({ columns: "space", sort: "mine" }), true);
  assert.equal(hasMine({ columns: "space" }), false);
  assert.equal(hasMine(undefined), false);
});

test("the table follows the layout: its columns in its order, its sort, its filters", () => {
  const rows = [{ id: "1", urn: "u/deal/1", data: { name: "A", value: 100, owner: "Dana" } }, { id: "2", urn: "u/deal/2", data: { name: "B", value: 900, owner: "Sam" } }];
  const t = tableFromRecords(def, rows, { layout: { columns: ["owner", "value"], sort: { field: "value", dir: "desc" }, filters: [{ field: "owner", op: "eq", value: "Sam" }] } });
  assert.deepEqual(t.content.columns.map((/** @type {any} */ c) => c.id).slice(0, 3), ["_title", "owner", "value"]);
  assert.equal(t.content.rows.length, 1);
  assert.equal(t.props.sort, "value");
  assert.equal(t.props.desc, true);
  assert.equal(listColumns(def, viewDefOf(def)).length > 0, true);
});

test("saving a scope writes only the keys that scope owns, plus the one that changed", () => {
  const layout = { columns: ["a", "b"], sort: { field: "a", dir: "asc" }, group_by: "stage" };
  const source = { columns: "space", sort: "mine", group_by: "space" };
  assert.deepEqual(ownLayout(layout, source, "mine", "columns", ["b"]), { sort: { field: "a", dir: "asc" }, columns: ["b"] }, "the Space's group_by is not copied into mine");
  assert.deepEqual(ownLayout(layout, source, "space", "columns", ["z"]), { columns: ["z"], group_by: "stage" }, "mine's sort is not copied into the Space's");
  assert.deepEqual(ownLayout(layout, source, "mine", "sort", undefined), {}, "a key set to nothing is dropped");
  assert.deepEqual(ownLayout(undefined, undefined, "mine", "columns", ["a"]), { columns: ["a"] });
});
