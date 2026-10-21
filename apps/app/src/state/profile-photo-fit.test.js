import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { centreCrop } from "./profile-photo-fit.js";

test("a wide picture keeps a square from the centre of its short side", () => {
  assert.deepEqual(centreCrop(1000, 400), { originX: 300, originY: 0, width: 400, height: 400 });
});

test("a tall picture keeps a square from the centre of its short side", () => {
  assert.deepEqual(centreCrop(400, 1000), { originX: 0, originY: 300, width: 400, height: 400 });
});

test("a square picture stays as it is", () => {
  assert.deepEqual(centreCrop(512, 512), { originX: 0, originY: 0, width: 512, height: 512 });
});

test("an odd width is floored and the square stays inside the picture", () => {
  assert.deepEqual(centreCrop(1001, 400), { originX: 300, originY: 0, width: 400, height: 400 });
  assert.deepEqual(centreCrop(100.9, 40.2), { originX: 30, originY: 0, width: 40, height: 40 });
});

test("a missing or empty size is a one pixel square and does not throw", () => {
  assert.deepEqual(centreCrop(0, 0), { originX: 0, originY: 0, width: 1, height: 1 });
  assert.deepEqual(centreCrop(Number.NaN, -4), { originX: 0, originY: 0, width: 1, height: 1 });
});
