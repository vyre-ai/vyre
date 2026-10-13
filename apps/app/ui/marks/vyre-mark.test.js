import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { done, intro, markup, small, working } from "./vyre-mark.js";

const balanced = (s) => (s.match(/<g[ >]/g) || []).length === (s.match(/<\/g>/g) || []).length;

test("the markup stays balanced in every state", () => {
  for (const st of [intro(0), intro(0.5), intro(1), working(0), working(1200), done(0), done(0.5), done(1), {}]) assert.ok(balanced(markup(st)));
});
test("the icon is the site's: a card with a folded corner, no glass master, no violet ring", () => {
  const m = markup({ halo: 1 });
  assert.match(m, /clipPath id="card"/);
  assert.ok(!/g_vyre|grain/.test(m));
  assert.ok(m.includes("stroke=\"" + String.fromCharCode(35) + "F1EEE6\""), "the ring is ink");
  assert.equal(small(), small());
});
test("the icon is hidden at 0 and whole at 1", () => {
  assert.match(markup({ wire: 0 }), /<g opacity="0.000"/);
  assert.match(markup({ wire: 1 }), /<g opacity="1.000"/);
});
test("intro settles the icon in before its light is full", () => {
  assert.ok(intro(0.4).wire > 0.5 && intro(0.4).bead === 0);
  assert.deepEqual([intro(1).wire, intro(1).bead, intro(1).glow], [1, 1, 1]);
});
test("working breathes inside 55 to 100 percent, and done fades its halo out", () => {
  for (let ms = 0; ms < 2400; ms += 100) { const g = working(ms).glow; assert.ok(g >= 0.55 - 1e-9 && g <= 1 + 1e-9); }
  assert.ok(done(0).halo > done(0.9).halo && done(1).halo === 0);
});
