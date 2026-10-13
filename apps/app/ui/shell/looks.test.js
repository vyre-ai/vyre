import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { LOOKS, LOOK_NAMES, lookOf, DEFAULT_LOOK } from "./looks.js";

test("three looks, each with a one line description and a row that is a comfortable target", () => {
  assert.deepEqual(LOOK_NAMES, ["quiet", "studio", "glass"]);
  for (const k of LOOK_NAMES) { assert.ok(LOOKS[k].line.length > 20); assert.ok(LOOKS[k].rowH >= 36); assert.ok(LOOKS[k].rail >= 232); assert.ok(!/—/.test(LOOKS[k].line)); }
});

test("an unknown look is the default", () => {
  assert.equal(lookOf("nope"), LOOKS[DEFAULT_LOOK]);
  assert.equal(lookOf(undefined), LOOKS[DEFAULT_LOOK]);
  assert.equal(lookOf("glass"), LOOKS.glass);
});
