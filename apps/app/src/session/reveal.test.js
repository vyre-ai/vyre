// @ts-check
// The session screen's reveal over chat's own pacer (deck/chat/core/pace.js), on plain numbers:
// one frame clock for every streaming reply, seeded text not revealed again, the first token
// named once, a finished reply drained at the pace, and even characters per frame.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacer } from "../../../../deck/chat/core/pace.js";
import { cv } from "../../../../lib/perf/meter.js";
import { createReveal } from "./reveal.js";

const F = 1000 / 60;
const make = () => createReveal({ createPacer });

test("reveal: a reply streams in over frames, its first token named once", () => {
  const r = make();
  r.push("m:a:0", 30, 0);
  assert.equal(r.shown("m:a:0"), 0);
  const first = r.frame(F);
  assert.equal(first.changed.length, 1);
  assert.equal(first.changed[0].first, true);
  assert.equal(first.changed[0].arrived, 0);
  assert.ok(first.changed[0].shown > 0 && first.changed[0].shown < 30, "not all at once");
  assert.equal(first.active, true);
  let t = F;
  for (let i = 0; i < 100; i++) {
    const f = r.frame((t += F));
    for (const c of f.changed) assert.equal(c.first, false);
    if (!f.active) break;
  }
  assert.equal(r.shown("m:a:0"), 30);
});

test("reveal: text already on screen is not revealed again", () => {
  const r = make();
  r.seed("m:a:0", 500);
  r.push("m:a:0", 520, 1000);
  const f = r.frame(1000 + F);
  assert.ok((r.shown("m:a:0") ?? 0) >= 500, "starts from what showed");
  assert.equal(f.changed[0]?.first ?? false, false, "not a first token");
});

test("reveal: a finished reply drains its backlog at the pace, then leaves", () => {
  const r = make();
  r.push("m:a:0", 10, 0);
  r.frame(F);
  r.push("m:a:0", 400, 2 * F);
  r.finish("m:a:0");
  const f = r.frame(3 * F);
  assert.ok((r.shown("m:a:0") ?? 400) < 400, "the lump is not shown in one frame");
  assert.equal(f.changed.some((c) => c.done), false);
  let t = 3 * F, done = false;
  for (let i = 0; i < 60 && !done; i++) done = r.frame((t += F)).changed.some((c) => c.done);
  assert.equal(done, true);
  assert.equal(r.has("m:a:0"), false);
  assert.equal(r.shown("m:a:0"), undefined, "shows the whole text once it left the pacer");
});

test("reveal: two replies advance on one frame", () => {
  const r = make();
  r.push("m:a:0", 50, 0);
  r.push("m:b:0", 50, 0);
  const f = r.frame(F);
  assert.deepEqual(f.changed.map((c) => c.key).sort(), ["m:a:0", "m:b:0"]);
  assert.equal(f.samples.length, 2);
});

test("reveal: bursty arrivals give an even paint (chars per frame CV under 2)", () => {
  const r = make();
  const samples = [];
  let len = 0;
  // 6 s of lumps: 40 to 160 characters every 90 to 300 ms, as the Switchboard coalesces them.
  let next = 0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 6000; t += F) {
    if (t >= next) {
      len += 40 + Math.floor(rnd() * 120);
      r.push("m:a:0", len, t);
      next = t + 90 + rnd() * 210;
    }
    samples.push(...r.frame(t).samples);
  }
  const v = cv(samples);
  assert.ok(v !== null && v < 2, `cv ${v}`);
});
