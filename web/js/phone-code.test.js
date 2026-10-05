// @ts-check
// "Add your phone": the ticket ring's own logic (web/js/phone-code.js), independent of tailnet's
// still-unbuilt relay.pair.ticket mint call — see docs/work/launch-surfaces.md "Add your phone".
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "../test/fake-dom.js";

install();
import { ticketLevels, ticketRingSvg, ticketPhase, countdown, playDance, idleAvatarSvg } from "./phone-code.js";

// tailnet's relay.pair.ticket returns `ticket` as base64url of 8 random bytes
// (core/relay/wire.js, TICKET_BYTES=8) — the shape these tests encode, not an arbitrary string.
const b64url = (/** @type {number[]} */ bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const TICKET_A = b64url([1, 2, 3, 4, 5, 6, 7, 8]);
const TICKET_B = b64url([8, 7, 6, 5, 4, 3, 2, 1]);

test("ticketLevels: 72 levels, each 0-3, deterministic for the same ticket", () => {
  const a = ticketLevels(TICKET_A);
  const b = ticketLevels(TICKET_A);
  assert.equal(a.length, 72);
  assert.ok(a.every(lv => Number.isInteger(lv) && lv >= 0 && lv <= 3));
  assert.deepEqual(a, b, "the same ticket always encodes to the same ring");
});

test("ticketLevels: two different tickets encode differently", () => {
  const a = ticketLevels(TICKET_A);
  const b = ticketLevels(TICKET_B);
  assert.notDeepEqual(a, b);
});

test("ticketLevels: the RAW ticket bytes are encoded, not a hash of them (the lead, 28 Sep)", () => {
  // Same first 8 bytes, different trailing padding-relevant tail: if this hashed the whole
  // string first (the old fingerprint8 behaviour), these would differ. Decoding to bytes and
  // truncating to 8 means they must encode identically.
  const a = ticketLevels(TICKET_A);
  const b = ticketLevels(b64url([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9]));
  assert.deepEqual(a, b, "the first 8 decoded bytes are what's encoded, not a digest of the input");
});

test("ticketLevels: a malformed ticket degrades to a ring that draws, never throws", () => {
  assert.doesNotThrow(() => ticketLevels("not valid base64url!!!"));
  assert.doesNotThrow(() => ticketLevels(""));
  assert.equal(ticketLevels("not valid base64url!!!").length, 72);
});

test("ticketRingSvg: an SVG with the right viewBox and a face group inside it", () => {
  const svg = ticketRingSvg(TICKET_A, { size: 280 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 600 600" width="280" height="280">/);
  assert.match(svg, /<g transform="translate\(/, "the face is wrapped and positioned, not left at its native size");
  assert.match(svg, /<g class="vyrecode-face">/, "the dance targets this inner group specifically");
  const ticks = svg.match(/<line /g) || [];
  assert.equal(ticks.length, 72, "one tick per level, ticksSunburst style");
});

test("idleAvatarSvg: the plain avatar, no ticks, no ticket bytes anywhere in it", () => {
  const svg = idleAvatarSvg({ size: 280 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 280 280" width="280" height="280">/);
  assert.doesNotMatch(svg, /<line /, "no ring ticks: this is the swapped-back idle state, not a ticket");
  assert.match(svg, /<circle /, "the face itself still draws (userAvatar's own gradient disc)");
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

// playDance: the avatar's dance, ui-ux's motion prototype ("goal done" — a hop plus confetti),
// not calm() drops it for a still bone dot. Not launch's own animation, but launch wires it.
test("playDance: not calm — a hop on .vyrecode-face, a confetti burst, then both are gone", async () => {
  const ring = document.createElement("div");
  const face = document.createElement("g");
  face.classList.add("vyrecode-face");
  ring.append(face);
  const before = Date.now();
  await playDance(ring, false);
  assert.ok(Date.now() - before >= 600, "the dance actually waits out its own animation");
  assert.equal(face.classList.contains("phone-code-ms-done"), false, "the hop class is removed after, not left on");
  assert.equal(ring.querySelectorAll(".phone-code-confetti-bit").length, 0, "confetti is cleaned up after, not left in the DOM");
  assert.equal(ring.querySelectorAll(".phone-code-done-flag").length, 0, "no reduced-motion flag when motion actually played");
});

test("playDance: calm (reduced motion) — no animation classes, no confetti, a still bone dot instead", async () => {
  const ring = document.createElement("div");
  const face = document.createElement("g");
  face.classList.add("vyrecode-face");
  ring.append(face);
  const before = Date.now();
  await playDance(ring, true);
  assert.ok(Date.now() - before < 100, "calm resolves immediately, no animation to wait out");
  assert.equal(face.classList.contains("phone-code-ms-done"), false);
  assert.equal(ring.querySelectorAll(".phone-code-confetti-bit").length, 0);
  assert.equal(ring.querySelectorAll(".phone-code-done-flag").length, 1, "the state survives as a still flag, never motion-only");
});

test("playDance: a ring with no .vyrecode-face (an unusual render) still resolves, decoration only", async () => {
  const ring = document.createElement("div");
  await playDance(ring, false);
});
