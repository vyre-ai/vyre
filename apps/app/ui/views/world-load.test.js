// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { filtersKey, listQuery } from "./world-load.js";

test("without a filter a type is read whole, as before", () => {
  assert.deepEqual(listQuery("deal", undefined), {});
  assert.deepEqual(listQuery("deal", { note: { field: "owner", op: "eq", value: "$me" } }), {});
  assert.deepEqual(listQuery("note", { note: undefined }), {});
});

test("a named type gets its filter", () => {
  const f = { field: "owner", op: "eq", value: "$me" };
  assert.deepEqual(listQuery("note", { note: f }), { filter: f });
});

test("the key changes with the filters and not with their order", () => {
  const a = { field: "owner", op: "eq", value: "$me" };
  assert.equal(filtersKey(undefined), "[]");
  assert.equal(filtersKey({ note: a, event: undefined }), filtersKey({ note: a }));
  assert.notEqual(filtersKey({ note: a }), filtersKey({ event: a }));
});
