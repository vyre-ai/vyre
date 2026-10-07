// @ts-check
// Pure logic of the motion kit: the springs come from the tokens, reduced motion follows the person AND the system, the stagger is capped,
// the swipe model offers only what a card has. node:test, no React.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { springConfig, springs, resolveReducedMotion, staggerDelay, entrance, pressScale, skeletonPlan, pressFeel, holdDuration, swipeActions, revealWidth } from "./logic.js";
import { HAPTICS, HAPTIC_NAMES } from "./haptic-map.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const motion = JSON.parse(fs.readFileSync(path.join(REPO, "lib/theme/tokens.json"), "utf8")).v2.motion;

test("springs: damping ratio and stiffness in the tokens become a reanimated damping coefficient (2 * ratio * sqrt(k), mass 1)", () => {
  const d = springConfig(motion, "spatial", "default");
  assert.equal(d.stiffness, 380);
  assert.equal(d.mass, 1);
  assert.ok(Math.abs(d.damping - 2 * 0.8 * Math.sqrt(380)) < 1e-9);
  assert.equal(d.overshootClamping, false, "0.8 is underdamped: it may overshoot a little");
  const f = springConfig(motion, "spatial", "fast");
  assert.ok(Math.abs(f.damping - 2 * 0.6 * Math.sqrt(800)) < 1e-9);
});

test("springs: effects springs are critically damped, so they never overshoot (colour and opacity)", () => {
  for (const speed of ["fast", "default", "slow"]) {
    const c = springConfig(motion, "effects", speed);
    assert.equal(c.overshootClamping, true);
    assert.ok(Math.abs(c.damping - 2 * Math.sqrt(c.stiffness)) < 1e-9);
  }
});

test("springs: slower means softer, and every token spring is resolved", () => {
  const s = springs(motion);
  assert.deepEqual(Object.keys(s).sort(), ["effects.default", "effects.fast", "effects.slow", "spatial.default", "spatial.fast", "spatial.slow"]);
  assert.ok(s["spatial.fast"].stiffness > s["spatial.default"].stiffness && s["spatial.default"].stiffness > s["spatial.slow"].stiffness);
  assert.throws(() => springConfig(motion, "spatial", /** @type {any} */ ("nope")));
});

test("reduced motion: on when the person set it OR the system asks; neither turns the other off", () => {
  assert.equal(resolveReducedMotion({ person: true, os: false }), true);
  assert.equal(resolveReducedMotion({ person: false, os: true }), true);
  assert.equal(resolveReducedMotion({ person: true, os: true }), true);
  assert.equal(resolveReducedMotion({ person: false, os: false }), false);
  assert.equal(resolveReducedMotion({}), false);
  assert.equal(resolveReducedMotion({ person: null, os: undefined }), false);
});

test("reduced motion: nothing moves, a fade stays, the hold stays", () => {
  assert.deepEqual(entrance(true), { dy: 0, scale: 1 });
  assert.ok(entrance(false).dy > 0 && entrance(false).scale < 1);
  assert.equal(pressScale(true, 0.9), 1);
  assert.equal(pressScale(false, 0.9), 0.9);
  assert.equal(skeletonPlan(motion, true).shimmer, false);
  assert.equal(skeletonPlan(motion, false).shimmer, true);
  assert.equal(holdDuration(motion), 600);
});

test("stagger: one step per item (24 ms), capped at the eighth so a long list does not wait", () => {
  assert.equal(staggerDelay(motion, 0), 0);
  assert.equal(staggerDelay(motion, 1), 24);
  assert.equal(staggerDelay(motion, 8), 8 * 24);
  assert.equal(staggerDelay(motion, 40), 8 * 24);
  assert.equal(staggerDelay(motion, -3), 0);
});

test("swipe: right is Mark done, left is Reassign and Open; only what the card has", () => {
  const full = swipeActions(["send", "edit", "reassign", "done", "open"]);
  assert.deepEqual(full.leading.map((a) => a.id), ["done"]);
  assert.deepEqual(full.trailing.map((a) => a.id), ["reassign", "open"]);
  const bare = swipeActions(["approve", "open"]);
  assert.deepEqual(bare.leading, [], "no Mark done unless the card can do it");
  assert.deepEqual(bare.trailing.map((a) => a.id), ["open"], "no Reassign unless the card can do it; Open always");
});

test("swipe: every action has a visible label, and its haptic is a known one; done is the approval", () => {
  const all = [...swipeActions(["done", "reassign"]).leading, ...swipeActions(["done", "reassign"]).trailing];
  for (const a of all) { assert.ok(a.label.length > 0); assert.ok(HAPTIC_NAMES.includes(a.haptic)); }
  assert.equal(all.find((a) => a.id === "done")?.haptic, "approve");
  assert.equal(revealWidth(2), 160);
});

test("haptics: four moments, none for the web to play", () => {
  assert.deepEqual(HAPTIC_NAMES.sort(), ["approve", "selection", "stage", "warn"]);
  assert.equal(HAPTICS.approve.kind, "notification");
  assert.equal(HAPTICS.selection.kind, "selection");
});

test("Android presses ripple (no scale, no pressed fill); other platforms spring and fill; no colour keeps the spring", () => {
  assert.deepEqual(pressFeel("android", "#00000022"), { ripple: { color: "#00000022", foreground: true }, scale: false, pressedFill: false });
  assert.deepEqual(pressFeel("ios", "#00000022"), { ripple: null, scale: true, pressedFill: true });
  assert.deepEqual(pressFeel("web", "#00000022"), { ripple: null, scale: true, pressedFill: true });
  assert.deepEqual(pressFeel("android", undefined), { ripple: null, scale: true, pressedFill: true });
});
