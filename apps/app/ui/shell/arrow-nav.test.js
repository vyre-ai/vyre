import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { arrowTarget } from "./arrow-nav.js";

test("down and up step one row and stop at the ends; from nothing they start at the ends", () => {
  assert.equal(arrowTarget("ArrowDown", 0, 3), 1);
  assert.equal(arrowTarget("ArrowDown", 2, 3), 2);
  assert.equal(arrowTarget("ArrowUp", 2, 3), 1);
  assert.equal(arrowTarget("ArrowUp", 0, 3), 0);
  assert.equal(arrowTarget("ArrowDown", -1, 3), 0);
  assert.equal(arrowTarget("ArrowUp", -1, 3), 2);
});

test("Home and End go to the ends; other keys and an empty list do nothing", () => {
  assert.equal(arrowTarget("Home", 2, 5), 0);
  assert.equal(arrowTarget("End", 0, 5), 4);
  assert.equal(arrowTarget("a", 1, 5), null);
  assert.equal(arrowTarget("ArrowDown", 0, 0), null);
});
