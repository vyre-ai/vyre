import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_W, FLING, release } from "./swipe.js";

test("swipe: the same numbers as the pwa", () => {
  assert.equal(ACTION_W, 100);
  assert.equal(FLING, 0.5);
});

test("swipe: a released swipe commits past 100 or on a fling, else stays open or closes", () => {
  assert.equal(release(120, 0), "commit-right");
  assert.equal(release(60, 0.8), "commit-right");
  assert.equal(release(60, 0), "open-right");
  assert.equal(release(20, 0), "close");
  assert.equal(release(-101, 0), "commit-left");
  assert.equal(release(-50, -0.9), "commit-left");
  assert.equal(release(-50, 0.9), "open-left");
  assert.equal(release(0, 3), "close");
});

test("swipe: the edges, 100 and 40 inclusive, a fling needs more than 24", () => {
  assert.equal(release(100, 0), "commit-right");
  assert.equal(release(99, 0), "open-right");
  assert.equal(release(40, 0), "open-right");
  assert.equal(release(39, 0), "close");
  assert.equal(release(-100, 0), "commit-left");
  assert.equal(release(-40, 0), "open-left");
  assert.equal(release(-39, 0), "close");
  assert.equal(release(24, 2), "close");
  assert.equal(release(25, 0.5), "commit-right");
  assert.equal(release(-25, -0.5), "commit-left");
  assert.equal(release(30, 0.49), "close");
});

test("swipe: a fling back toward the rest does not commit", () => {
  assert.equal(release(80, -2), "open-right");
  assert.equal(release(-80, 2), "open-left");
  assert.equal(release(30, -2), "close");
});
