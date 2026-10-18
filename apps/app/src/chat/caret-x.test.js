// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { popoverLeft } from "./caret-x.js";

const mono = (s) => s.length * 8;

test("the popover opens where the trigger was typed", () => {
  assert.equal(popoverLeft("hello @ju", 6, mono, 600, 300), 48);
  assert.equal(popoverLeft("/new", 0, mono, 600, 300), 0);
});

test("only the last line counts, and it never runs off the right edge", () => {
  assert.equal(popoverLeft("one\ntwo #r", 8, mono, 600, 300), 32);
  assert.equal(popoverLeft("x".repeat(60) + " @a", 61, mono, 600, 300), 300, "kept inside the box");
});

test("a wrapped line offsets from the last row; no measure or no room means the left edge", () => {
  assert.equal(popoverLeft("y".repeat(100) + " @", 101, mono, 400, 100), 8);
  assert.equal(popoverLeft("a @", 2, () => { throw new Error("no canvas"); }, 600, 300), 0);
  assert.equal(popoverLeft("a @", 2, mono, 0, 300), 0);
});
