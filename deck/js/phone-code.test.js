// @ts-check
// "Add your phone": the ticket ring's own logic (deck/js/phone-code.js), independent of tailnet's
// still-unbuilt relay.pair.ticket mint call — see docs/work/launch-surfaces.md "Add your phone".
import test from "node:test";
import assert from "node:assert/strict";
import { ticketLevels, ticketRingSvg, ticketPhase, countdown } from "./phone-code.js";

test("ticketLevels: 72 levels, each 0-3, deterministic for the same ticket id", async () => {
  const a = await ticketLevels("relay://pair/abc123");
  const b = await ticketLevels("relay://pair/abc123");
  assert.equal(a.length, 72);
  assert.ok(a.every(lv => Number.isInteger(lv) && lv >= 0 && lv <= 3));
  assert.deepEqual(a, b, "the same ticket id always encodes to the same ring");
});

test("ticketLevels: two different tickets encode differently", async () => {
  const a = await ticketLevels("relay://pair/abc123");
  const b = await ticketLevels("relay://pair/def456");
  assert.notDeepEqual(a, b);
});

test("ticketRingSvg: an SVG with the right viewBox and a face group inside it", async () => {
  const svg = await ticketRingSvg("relay://pair/abc123", { size: 280 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 600 600" width="280" height="280">/);
  assert.match(svg, /<g transform="translate\(/, "the face is wrapped and positioned, not left at its native size");
  const ticks = svg.match(/<line /g) || [];
  assert.equal(ticks.length, 72, "one tick per level, ticksSunburst style");
});

test("ticketPhase: live, then the last 30s reads expiring, then expired at zero", () => {
  const minted = 1_000_000;
  const ttl = 5 * 60_000;
  assert.equal(ticketPhase(minted, ttl, minted).phase, "live");
  assert.equal(ticketPhase(minted, ttl, minted + ttl - 31_000).phase, "live");
  assert.equal(ticketPhase(minted, ttl, minted + ttl - 30_000).phase, "expiring");
  assert.equal(ticketPhase(minted, ttl, minted + ttl - 1).phase, "expiring");
  assert.equal(ticketPhase(minted, ttl, minted + ttl).phase, "expired");
  assert.equal(ticketPhase(minted, ttl, minted + ttl + 60_000).phase, "expired");
});

test("ticketPhase: msLeft never goes negative", () => {
  const r = ticketPhase(0, 1000, 999_999);
  assert.equal(r.msLeft, 0);
  assert.equal(r.phase, "expired");
});

test("countdown: m:ss, never negative, always two digits of seconds", () => {
  assert.equal(countdown(5 * 60_000), "5:00");
  assert.equal(countdown(4 * 60_000 + 59_000), "4:59");
  assert.equal(countdown(3_000), "0:03");
  assert.equal(countdown(0), "0:00");
  assert.equal(countdown(-1), "0:00");
});
