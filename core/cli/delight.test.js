// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, fortune, highFiveLine } from "./delight.js";

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

test("delight: fortune is empty far more often than not, and never off-gate", () => {
  assert.equal(fortune({ env: { CI: "1" }, stream: TTY, rand: () => 0 }), "");
  assert.equal(fortune({ env: {}, stream: PIPE, rand: () => 0 }), "");
  assert.equal(fortune({ env: {}, stream: TTY, odds: 200, rand: () => 0.5 }), "");
});

test("delight: fortune wins only inside its odds, and is a fixed line for a given minute", () => {
  const now = 120_000; // exactly minute 2
  const line = fortune({ env: {}, stream: TTY, odds: 10, rand: () => 0, now });
  assert.equal(typeof line, "string");
  assert.ok(line.length > 0);
  assert.equal(fortune({ env: {}, stream: TTY, odds: 10, rand: () => 0, now }), line, "same minute, same line");
  assert.notEqual(fortune({ env: {}, stream: TTY, odds: 10, rand: () => 0, now: now + 60_000 }), line);
});

test("delight: fortune never mentions a name, path or anything from real data", () => {
  for (let m = 0; m < 20; m++) {
    const line = fortune({ env: {}, stream: TTY, odds: 1, rand: () => 0, now: m * 60_000 });
    assert.ok(!/[\\/~@]/.test(line), `no path-like or handle-like character in: ${line}`);
  }
});

test("delight: high-five prints a line only in a real terminal, a plain glyph otherwise", () => {
  const a = highFiveLine({ env: {}, stream: TTY, rand: () => 0 });
  const b = highFiveLine({ env: {}, stream: TTY, rand: () => 0.99 });
  assert.notEqual(a, "\\o/");
  assert.notEqual(b, "\\o/");
  assert.equal(highFiveLine({ env: { CI: "1" }, stream: TTY }), "\\o/");
  assert.equal(highFiveLine({ env: {}, stream: PIPE }), "\\o/");
});
