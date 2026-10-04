// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { haptic, PATTERNS } from "./haptics.js";

const store = (/** @type {string | null} */ v) => ({ getItem: () => v });

test("haptics: Android vibrates with the pattern for the kind, nothing for an unknown kind", () => {
  /** @type {any[]} */ const seen = [];
  const navigator = { userAgent: "Android", vibrate: (/** @type {any} */ p) => { seen.push(p); return true; } };
  assert.equal(haptic("tick", { navigator, store: store(null) }), "vibrate");
  assert.equal(haptic("success", { navigator, store: store(null) }), "vibrate");
  assert.equal(haptic("warning", { navigator, store: store(null) }), "vibrate");
  assert.deepEqual(seen, [PATTERNS.tick, PATTERNS.success, PATTERNS.warning]);
  assert.equal(haptic(/** @type {any} */ ("buzz"), { navigator, store: store(null) }), "none");
  assert.equal(seen.length, 3);
});

test("haptics: a hidden page, or the person turning them off, plays nothing", () => {
  let n = 0;
  const navigator = { vibrate: () => { n++; return true; } };
  assert.equal(haptic("tick", { navigator, document: { visibilityState: "hidden" }, store: store(null) }), "none");
  assert.equal(haptic("tick", { navigator, store: store("off") }), "none");
  assert.equal(n, 0);
});

test("haptics: iOS has no vibrate, so a hidden switch is clicked; a laptop does nothing and never throws", () => {
  /** @type {any[]} */ const appended = [];
  let clicks = 0;
  const makeEl = () => { /** @type {any} */ const el = { style: {}, setAttribute() {}, append() {}, isConnected: true, click() { clicks++; } }; return el; };
  const document = { visibilityState: "visible", createElement: makeEl, body: { append: (/** @type {any} */ e) => appended.push(e) } };
  const ios = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" };
  assert.equal(haptic("success", { navigator: ios, document, store: store(null) }), "switch");
  assert.equal(haptic("tick", { navigator: ios, document, store: store(null) }), "switch");
  assert.equal(appended.length, 1, "one hidden switch, reused");
  assert.equal(clicks, 2);
  assert.equal(haptic("tick", { navigator: { userAgent: "Macintosh" }, document, store: store(null) }), "none");
  assert.equal(haptic("tick", { navigator: undefined, document: undefined, store: store(null) }), "none");
  const throwing = { vibrate: () => { throw new Error("no"); } };
  assert.equal(haptic("tick", { navigator: throwing, store: store(null) }), "none");
});
