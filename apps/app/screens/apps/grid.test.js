// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnsFor, tileWidth } from "./grid.js";

test("three across on a wide page, two on a tablet, one on a phone", () => {
  assert.equal(columnsFor(1000), 3);
  assert.equal(columnsFor(720), 3);
  assert.equal(columnsFor(500), 2);
  assert.equal(columnsFor(358), 1);
  assert.equal(columnsFor(0), 1);
});

test("tiles are equal and never wrap early", () => {
  assert.equal(tileWidth(1000, 3, 12), 325);
  assert.equal(3 * 325 + 2 * 12 <= 1000, true);
  assert.equal(tileWidth(358, 1, 12), 358);
  assert.equal(tileWidth(0, 1, 12), "100%");
});
