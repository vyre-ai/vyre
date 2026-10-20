import test from "node:test";
import assert from "node:assert/strict";
import { filesKey, packRows, pickRows, ROWS_KEPT, MAX_AGE_MS } from "./files-keep.js";

test("a kept folder comes back, per Space and place", () => {
  assert.notEqual(filesKey("a", "space"), filesKey("b", "space"));
  assert.notEqual(filesKey("a", "space"), filesKey("a", "space:Projects"));
  const rows = [{ key: "space:a", name: "a" }];
  assert.deepEqual(pickRows(packRows(rows, 1000), 2000), rows);
});

test("an empty folder is kept too, so it draws its empty state at once", () => {
  assert.deepEqual(pickRows(packRows([], 1000), 2000), []);
});

test("an old, missing or foreign copy is not shown", () => {
  assert.equal(pickRows(packRows([{}], 0), MAX_AGE_MS + 1), null);
  assert.equal(pickRows(undefined), null);
  assert.equal(pickRows({ v: 99, at: 1, rows: [] }, 2), null);
  assert.equal(pickRows({ v: 1, at: 1, rows: "x" }, 2), null);
});

test("only a screen of rows is kept", () => {
  assert.equal(packRows(Array.from({ length: ROWS_KEPT + 50 }, (_, i) => ({ i }))).rows.length, ROWS_KEPT);
});
