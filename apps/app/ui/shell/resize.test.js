import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { clampWidth, readWidth, writeWidth, keyStep, dragWidth, snapsShut, rawWidth, OPEN_AFTER, SNAP_SLACK } from "./resize.js";

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test("a width stays between the least and the most", () => {
  assert.equal(clampWidth(100, 240, 480), 240);
  assert.equal(clampWidth(900, 240, 480), 480);
  assert.equal(clampWidth(300.4, 240, 480), 300);
  assert.equal(clampWidth(NaN, 240, 480), 240);
});

test("a width is remembered per key on this device; a blocked or empty store gives nothing", () => {
  const s = mem();
  assert.equal(readWidth(s, "rail"), null);
  writeWidth(s, "rail", 400);
  writeWidth(s, "panel", 300);
  assert.equal(readWidth(s, "rail"), 400);
  assert.equal(readWidth(s, "panel"), 300);
  writeWidth(s, "rail", null);
  assert.equal(readWidth(s, "rail"), null);
  assert.equal(readWidth(null, "rail"), null);
  assert.equal(readWidth({ getItem() { throw new Error("blocked"); } }, "rail"), null);
  s.setItem("vyre.width.rail", "junk");
  assert.equal(readWidth(s, "rail"), null);
});

test("arrow keys move the edge 16, shift 64, Home and End go to the ends, Enter resets", () => {
  const o = { min: 240, max: 480, def: 336 };
  assert.equal(keyStep("ArrowRight", 300, o), 316);
  assert.equal(keyStep("ArrowLeft", 300, o), 284);
  assert.equal(keyStep("ArrowRight", 300, { ...o, shift: true }), 364);
  assert.equal(keyStep("ArrowRight", 478, o), 480);
  assert.equal(keyStep("Home", 300, o), 240);
  assert.equal(keyStep("End", 300, o), 480);
  assert.equal(keyStep("Enter", 300, o), 336);
  assert.equal(keyStep("a", 300, o), null);
});

test("dragging an edge on the right grows with the pointer; on the left it shrinks", () => {
  const o = { min: 240, max: 480 };
  assert.equal(dragWidth(300, 10, "right", o), 310);
  assert.equal(dragWidth(300, 10, "left", o), 290);
  assert.equal(dragWidth(300, 500, "right", o), 480);
});

test("a drag past the least width snaps a foldable pane shut; a drag out of a folded edge opens it", () => {
  assert.equal(snapsShut(170, 180), false, "a little under the least is still the least");
  assert.equal(snapsShut(180 - SNAP_SLACK - 1, 180), true);
  assert.equal(rawWidth(300, -200, "right"), 100);
  assert.equal(rawWidth(300, 50, "left"), 250);
  assert.ok(OPEN_AFTER > 0 && OPEN_AFTER < 100);
});
