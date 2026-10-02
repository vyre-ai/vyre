// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, highFiveLine } from "./delight.js";

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

test("delight: allowed only in a real terminal with none of the off-switches set", () => {
  assert.equal(allowed({ env: {}, stream: TTY }), true);
  assert.equal(allowed({ json: true, env: {}, stream: TTY }), false);
  assert.equal(allowed({ env: { CI: "1" }, stream: TTY }), false);
  assert.equal(allowed({ env: { NO_COLOR: "1" }, stream: TTY }), false);
  assert.equal(allowed({ env: { VYRE_REDUCED_MOTION: "1" }, stream: TTY }), false);
  assert.equal(allowed({ env: { PREFERS_REDUCED_MOTION: "1" }, stream: TTY }), false);
  assert.equal(allowed({ env: {}, stream: PIPE }), false);
  assert.equal(allowed({ env: {}, stream: undefined }), false);
});

test("delight: high-five prints a line only in a real terminal, a plain glyph otherwise", () => {
  const a = highFiveLine({ env: {}, stream: TTY, rand: () => 0 });
  const b = highFiveLine({ env: {}, stream: TTY, rand: () => 0.99 });
  assert.notEqual(a, "\\o/");
  assert.notEqual(b, "\\o/");
  assert.equal(highFiveLine({ env: { CI: "1" }, stream: TTY }), "\\o/");
  assert.equal(highFiveLine({ env: {}, stream: PIPE }), "\\o/");
});
