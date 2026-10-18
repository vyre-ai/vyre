import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { GRID, GRID_PHONE, INTENSITY, MAX_WAVES, buildDots, calmAround, createField, lookOf, shock, stepField } from "./field-core.js";

const run = (F, dots, ms, W = 400, H = 300) => { let tm = 0; for (let t = 0; t < ms; t += 16) { tm += 16; stepField(F, dots, { dt: 16, tm, W, H }); } return tm; };
const moved = (dots) => dots.reduce((m, d) => Math.max(m, Math.hypot(d.ox, d.oy)), 0);

test("the grid has one dot per cell, and a phone's is lighter", () => {
  assert.equal(buildDots(220, 110).length, 10 * 5);
  assert.ok(buildDots(1000, 800, GRID_PHONE).length < buildDots(1000, 800, GRID).length);
});

test("the form steps are calmer than the welcome screen", () => {
  assert.equal(INTENSITY.welcome, 1);
  assert.equal(INTENSITY.form, 0.38);
});

test("the intensity eases to its target, and does not jump", () => {
  const F = createField(); const dots = buildDots(200, 100);
  F.target = INTENSITY.form;
  stepField(F, dots, { dt: 16, tm: 0, W: 200, H: 100 });
  assert.ok(F.intensity < 1 && F.intensity > INTENSITY.form);
  run(F, dots, 4000);
  assert.ok(Math.abs(F.intensity - INTENSITY.form) < 0.01);
});

test("a click's shockwave pushes the dots on its ring, then every dot settles home", () => {
  const F = createField(); F.target = 0; F.intensity = 0; const dots = buildDots(400, 300);
  shock(F, 200, 150, 0.6);
  run(F, dots, 700);
  assert.ok(moved(dots) > 1, "the ring moved dots");
  run(F, dots, 6000);
  assert.ok(moved(dots) < 0.5, "the springs brought them home");
  assert.equal(F.waves.length, 0, "the wave is gone");
});

test("only five waves at once", () => {
  const F = createField(); for (let i = 0; i < 9; i++) shock(F, i, i);
  assert.equal(F.waves.length, MAX_WAVES);
});

test("the cursor pushes the dots near it away and leaves the far ones alone", () => {
  const F = createField(); F.target = 0; F.intensity = 0; const dots = buildDots(400, 300);
  F.pointer.on = true; F.pointer.x = 100; F.pointer.y = 100;
  run(F, dots, 160);
  const near = dots.filter((d) => Math.hypot(d.bx - 100, d.by - 100) < 60);
  const far = dots.filter((d) => Math.hypot(d.bx - 100, d.by - 100) > 200);
  assert.ok(near.some((d) => Math.hypot(d.ox, d.oy) > 0.5));
  assert.ok(far.every((d) => Math.hypot(d.ox, d.oy) < 0.01));
  for (const d of near) { const away = (d.bx - 100) * d.ox + (d.by - 100) * d.oy; assert.ok(away >= -1e-9, "pushed away from the cursor, not toward it"); }
});

test("dots inside the calm ellipse are dimmer than dots outside it", () => {
  const F = createField(); const inside = { bx: 200, by: 150, ox: 0, oy: 0, vx: 0, vy: 0 }; const outside = { bx: 10, by: 10, ox: 0, oy: 0, vx: 0, vy: 0 };
  F.calm = calmAround({ left: 100, top: 75, width: 200, height: 150 }, { left: 0, top: 0 });
  assert.ok(lookOf(F, inside, 0).a < lookOf(F, outside, 0).a);
  assert.ok(lookOf(F, inside, 0).r < lookOf(F, outside, 0).r);
});

test("a dot with energy is bigger than the same dot at rest", () => {
  const F = createField(); F.intensity = 0.38;
  const rest = { bx: 40, by: 40, ox: 0, oy: 0, vx: 0, vy: 0 }, stirred = { bx: 40, by: 40, ox: 12, oy: 0, vx: 3, vy: 0 };
  assert.ok(lookOf(F, stirred, 1000).r > lookOf(F, rest, 1000).r);
});

test("the calm ellipse is centred on the content and never smaller than 200 by 160", () => {
  const c = calmAround({ left: 300, top: 120, width: 100, height: 60 }, { left: 0, top: 20 });
  assert.deepEqual([c.x, c.y, c.w, c.h], [350, 130, 200, 160]);
});
