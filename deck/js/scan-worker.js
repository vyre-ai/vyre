// @ts-check
// Scan your avatar to pair your phone: the decode worker. A full rotation/scale/perspective
// search over one camera frame is roughly 1-2s of JS work (see decode-core2.js's own perf note);
// running it on the main thread would freeze the camera preview and the whole Deck UI for that
// long, every attempt. This module worker runs the search instead, off the main thread - the
// preview keeps redrawing and the rest of the page stays responsive while a scan is in flight.
//
// This alone does not hit the under-200ms/attempt target (team-lead's ask): it moves the SAME
// ~1-2s of work off the main thread, it does not make that work faster. The actual speed lever -
// a cheap localization pre-pass so the full search only has to refine near the code's real
// position/scale instead of a blind sweep - is a separate, larger algorithmic change, not built
// here; see scan.js's own perf note and team/archive/work-journals/pwa.md's "Next".
//
// Protocol: postMessage({ data: Uint8ClampedArray (transferred), width, height, geo }) ->
// postMessage({ ticket: number[] | null }) (a plain array, not a Uint8Array - structured clone
// handles it either way, but a plain array keeps this file's only export boundary simple).

import { decodeCore2 } from "../vyrecode/decode-core2.js";
import * as payload from "../vyrecode/payload.js";

/** Mirrors vyrecode2.js's levelsToBits (2 bits per mark) without importing the renderer. */
function levelsToBits(/** @type {number[]} */ levels) {
  const bits = [];
  for (const lv of levels) { bits.push((lv >> 1) & 1, lv & 1); }
  return bits;
}

self.onmessage = (/** @type {MessageEvent} */ e) => {
  const { data, width, height } = e.data;
  // A real ES module worker (unlike the toString()-injected test harness) can just use
  // decodeCore2()'s own live-import default geometry - no plain-data GEO object needed here.
  const core = decodeCore2();
  const getLum = (/** @type {number} */ x, /** @type {number} */ y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  const candidates = core.searchWithPerspective(getLum, width / 2, height / 2, {});
  for (const cand of candidates) {
    const bits = levelsToBits(cand.levels);
    const bytes = payload.bitsToBytes(bits);
    const recovered = payload.recoverId(bytes);
    if (recovered) { self.postMessage({ ticket: recovered.id8, rot: cand.rot, scale: cand.scale, correction: cand.correction }); return; }
  }
  self.postMessage({ ticket: null });
};
