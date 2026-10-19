// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRows } from "./records-table.js";

const cols = [{ id: "_title" }, { id: "role" }, { id: "org" }];
const rows = [
  { id: "1", cells: { role: { k: "choice", v: "Client" }, org: { k: "link", v: "u1", link: { title: "Northwind" } } } },
  { id: "2", cells: { role: { k: "choice", v: "Lead" }, org: { k: "link", v: "u2", link: { title: "Lumen" } } } },
  { id: "3", cells: { role: { k: "choice", v: "Client" } } },
  { id: "4", cells: {} },
];

test("rows group by a column in first-seen order, the empty ones under None", () => {
  const g = groupRows(rows, cols, "role");
  assert.deepEqual(g?.map((x) => [x.label, x.rows.map((r) => r.id)]), [["Client", ["1", "3"]], ["Lead", ["2"]], ["None", ["4"]]]);
});

test("a link groups by its title", () => {
  assert.deepEqual(groupRows(rows, cols, "org")?.map((x) => x.label), ["Northwind", "Lumen", "None"]);
});

test("no group, the title, or a column the table does not have means no groups", () => {
  assert.equal(groupRows(rows, cols, undefined), null);
  assert.equal(groupRows(rows, cols, "_title"), null);
  assert.equal(groupRows(rows, cols, "nope"), null);
});
