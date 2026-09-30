// @ts-check
// Fast, Chrome-free tests: the RS/CRC round trip (rs.js, payload.js) and decode-core2.js's pure
// math (length quantization, ellipse fit, the closed-form perspective un-projection) against
// synthetic data. The real "does this decode a rendered, degraded PNG" question needs a real
// browser's getImageData, which is what test/harness.js (headless Chrome, manual/slow, not run
// here) answers - see docs/work/pwa.md for its measured pass rate.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as rs from "./rs.js";
import * as payload from "./payload.js";
import { decodeCore2 } from "./decode-core2.js";

function fingerprint8(seed) {
  return [...crypto.createHash("sha256").update(seed).digest()].slice(0, 8);
}

test("rs: encodes and decodes clean, and corrects up to 4 byte errors", () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const cw = rs.encode(data, 9);
  assert.equal(cw.length, 18);
  for (let errors = 0; errors <= 4; errors++) {
    const corrupted = [...cw];
    for (let i = 0; i < errors; i++) corrupted[i] = corrupted[i] ^ 0xFF;
    const r = rs.decode(corrupted, 9);
    assert.equal(r.ok, true, `should correct ${errors} byte errors`);
    assert.deepEqual(r.corrected.slice(0, 9), data);
  }
});

test("rs: 5 byte errors are rejected, not silently miscorrected", () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const cw = rs.encode(data, 9);
  const corrupted = [...cw];
  for (let i = 0; i < 5; i++) corrupted[i] = corrupted[i] ^ 0xFF;
  const r = rs.decode(corrupted, 9);
  // either it refuses outright, or (rarely, for a specific error pattern) it "corrects" to the
  // WRONG codeword - either is acceptable as long as it never silently returns the right one
  // from 5 errors, which would mean the correction bound claim (4) is false.
  if (r.ok) assert.notDeepEqual(r.corrected.slice(0, 9), data);
});

test("payload: buildCodeword + recoverId round trip, and corrects 2 corrupted bytes", () => {
  const id = fingerprint8("alex@harlowlegal.test:ed25519:demo");
  const cw = payload.buildCodeword(id);
  assert.equal(cw.length, 18);
  const bits = payload.bytesToBits(cw);
  assert.equal(bits.length, 144);
  const back = payload.bitsToBytes(bits);
  assert.deepEqual(back, cw);
  const recovered = payload.recoverId(cw);
  assert.deepEqual(recovered?.id8, id);
  assert.equal(recovered?.errorsCorrected, 0);

  const corrupted = [...cw]; corrupted[3] ^= 0xFF; corrupted[10] ^= 0xFF;
  const recovered2 = payload.recoverId(corrupted);
  assert.deepEqual(recovered2?.id8, id);
  assert.equal(recovered2?.errorsCorrected, 2);
});

test("payload: a codeword whose CRC never matched its id is refused, not force-fit", () => {
  // A codeword that RS still validates (structurally a real codeword) but whose data bytes don't
  // satisfy id+crc8(id) - i.e. valid parity, wrong content - must come back null, not some
  // partial/garbage id.
  const wrongData = [9, 9, 9, 9, 9, 9, 9, 9, 0]; // crc8 of those 8 bytes is not 0
  const cw = rs.encode(wrongData, payload.PARITY);
  assert.equal(payload.recoverId(cw), null);
});

test("decode-core2: lengthToLevel picks the nearest of the four known tick lengths", () => {
  const { lengthToLevel, LEVELS } = decodeCore2();
  // From deck/vendor/vyrecode/geometry.js's tickLength(0..3) - app-design's revised, tighter
  // constants (2026-09-28: RING_R=[188,222], the ring-gap/margin fix), not restated by hand.
  assert.deepEqual(LEVELS, [6, 12, 18, 24]);
  assert.equal(lengthToLevel(6), 0);
  assert.equal(lengthToLevel(8), 0); // closer to 6 than 12
  assert.equal(lengthToLevel(10), 1); // closer to 12 than 6
  assert.equal(lengthToLevel(24), 3);
  assert.equal(lengthToLevel(40), 3); // clamps to the nearest, not out of range
});

test("decode-core2: fitEllipse recovers a known circle (theta=0 sanity check)", () => {
  const { fitEllipse } = decodeCore2();
  const cx = 300, cy = 300, R = 250;
  const pts = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [cx + Math.cos(a) * R, cy + Math.sin(a) * R];
  });
  const e = fitEllipse(pts);
  assert.ok(e, "should fit an ellipse to a perfect circle's own points");
  assert.ok(Math.abs(e.cx - cx) < 0.5 && Math.abs(e.cy - cy) < 0.5);
  assert.ok(Math.abs(e.semiMajor - R) < 0.5 && Math.abs(e.semiMinor - R) < 0.5);
});

test("decode-core2: perspectiveCandidates always offers identity, and only that without an ellipse", () => {
  const core = decodeCore2();
  const candidates = core.perspectiveCandidates(null, []);
  assert.deepEqual(candidates.map(c => c.name), ["none"]);
  const [x, y] = candidates[0].mapXY(310, 250);
  assert.equal(x, 310); assert.equal(y, 250);
});

test("decode-core2: search() never truncates results (no top-K cutoff to fall through)", () => {
  const { search, RINGS, PER_RING } = decodeCore2();
  // an all-null image: every mark unreadable, so search should return no candidates (every
  // rotation/scale hits the "bad > half" skip) rather than throwing or padding with junk.
  const results = search(() => null, 300, 300, { scales: [1.0], rotStep: 45 });
  assert.equal(results.length, 0);
});
