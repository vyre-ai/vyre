import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { WIRE, done, intro, markup, working } from "./vyre-mark.js";

const balanced = (s) => (s.match(/<g[ >]/g) || []).length === (s.match(/<\/g>/g) || []).length;

test("the markup stays balanced in every state", () => {
  for (const st of [intro(0), intro(0.5), intro(1), working(0), working(1200), done(0), done(0.5), done(1), {}]) assert.ok(balanced(markup(st)));
});
test("the wire is hidden at 0 and whole at 1", () => {
  assert.match(markup({ wire: 0 }), new RegExp(`stroke-dashoffset="${WIRE.toFixed(1)}"`));
  assert.match(markup({ wire: 1 }), /stroke-dashoffset="0.0"/);
});
test("intro draws the wire before the bead lights", () => {
  assert.ok(intro(0.4).wire > 0.5 && intro(0.4).bead === 0);
  assert.deepEqual([intro(1).wire, intro(1).bead, intro(1).glow], [1, 1, 1]);
});
test("working breathes inside 55 to 100 percent, and done fades its halo out", () => {
  for (let ms = 0; ms < 2400; ms += 100) { const g = working(ms).glow; assert.ok(g >= 0.55 - 1e-9 && g <= 1 + 1e-9); }
  assert.ok(done(0).halo > done(0.9).halo && done(1).halo === 0);
});
