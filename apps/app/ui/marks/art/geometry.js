// Single source of truth for the Vyre code's ring geometry (ADR 0033). Both halves that need
// these numbers - the renderer (vyrecode2.js, vendored by launch) and the decoder (pwa's
// decode-core2.js) - import this file rather than restating the numbers, after the first
// revision drifted out of sync by hand (team-lead, 28 Sep: "one shared constants module ...
// that both the renderer and the decoder import"). Vendor this file itself
// (web/vendor/vyrecode/geometry.js) alongside the others already vendored; do not copy its
// values into a second file.
//
// A 600x600 canvas is the fixed working space; renderCode2's own `size` param only scales the
// final output, never these units (see vyrecode2.js).

const CENTER = 300;
const FACE_D = 360; // 60% of the 600 canvas
const FACE_R = FACE_D / 2;
const RINGS = 2;
const PER_RING = 36; // 2 * 36 = 72 marks * 2 bits = 144 bits
const ANGLE_STEP = 360 / PER_RING;
const LEVELS = 4; // 2 bits per mark

// Revision 2a (28 Sep): pwa's decoder found the first pass's outer margin too thin (clips at
// 120% scale, limits perspective correction) and the two rings bleeding into each other. Root
// cause was the orientation marker, not the ticks - it reached further from centre than any
// tick did, so the margin arithmetic that only checked tick reach undercounted the real outer
// edge. Fixed by pulling the rings in tight against the face and tightening the marker to
// match, rather than shrinking the face or enlarging the canvas.
const RING_R = [FACE_R + 8, FACE_R + 8 + 34]; // [188, 222]

// ticksSunburst is the shipped style (the lead's pick, what pwa built the decoder against).
// dotsPalette and dashesRounded remain visual-only alternatives with the same mark positions and
// bit convention, but a smaller radial excursion than ticks at every level, so they were never
// the binding constraint on the outer margin and don't need their own reach constants here.
const TICK_LEN_BASE = 6;
const TICK_LEN_STEP = 6;
function tickLength(level) { return TICK_LEN_BASE + level * TICK_LEN_STEP; } // 6, 12, 18, 24
// pwa's per-mark error diagnostic (28 Sep): blur is the dominant, near-linear failure mode
// (18/38/56 errors at blur 2/4/6px, vs 5-6 for any rotation and 3 for noise), and it got
// dramatically worse than round 5's original prototype, which passed all 3 blur levels clean.
// That timing lines up with 2a's margin fix shrinking the ticks (8-29px -> 6-24px) more than
// with palette softness alone - a thin, short stroke loses proportionally more of its signal to
// a fixed-radius blur kernel than a wider one does, independent of colour contrast. Widened
// 4.5 -> 6 (matching dashesRounded's own stroke) as the first, geometry-only lever to test,
// before touching the palette (team-lead asked pwa not to) or the lengths (which would eat back
// into 2a's margin fix). Re-verified the margin/gap invariant still holds at this width.
const TICK_STROKE_WIDTH = 6;
const TICK_CAP_RADIUS = TICK_STROKE_WIDTH / 2; // a round line-cap extends the reach by half the stroke
function tickReach(level) { return tickLength(level) + TICK_CAP_RADIUS; }

// The disguised orientation marker: 3 dots ascending in size at 12 o'clock, sitting just
// outside RING_R[1]. Load-bearing for the outer-margin math (see the revision note above), never
// load-bearing for decode itself (rotation+scale search and Reed-Solomon do that work).
const MARKER_COUNT = 3;
const MARKER_OFFSET_BASE = 8;
const MARKER_OFFSET_STEP = 6;
const MARKER_RADIUS_BASE = 2;
const MARKER_RADIUS_STEP = 1;
function markerOffset(k) { return MARKER_OFFSET_BASE + k * MARKER_OFFSET_STEP; }
function markerRadius(k) { return MARKER_RADIUS_BASE + k * MARKER_RADIUS_STEP; }
function markerReach() {
  const k = MARKER_COUNT - 1;
  return markerOffset(k) + markerRadius(k);
}

/** The farthest any drawn mark reaches from centre - the true outer edge, not RING_R[1] alone. */
function outerReach() {
  return RING_R[1] + Math.max(tickReach(LEVELS - 1), markerReach());
}

/** Validates the two invariants a future geometry change must preserve. Throws with a specific
 * reason rather than letting a bad change ship silently. Call this after editing any constant
 * above, in both the renderer and the decoder. */
function validateGeometry({ canvasR = CENTER, minMarginPct = 0.08, minGapClearance = 4 } = {}) {
  const margin = canvasR - outerReach();
  const marginPct = margin / (canvasR * 2);
  if (marginPct < minMarginPct) {
    throw new Error(`Vyre-code outer margin ${margin}px (${(marginPct * 100).toFixed(1)}% of ` +
      `diameter) is below the ${(minMarginPct * 100).toFixed(0)}% minimum.`);
  }
  const gapClearance = (RING_R[1] - RING_R[0]) - tickReach(LEVELS - 1);
  if (gapClearance < minGapClearance) {
    throw new Error(`Vyre-code ring-gap clearance ${gapClearance}px is below the ` +
      `${minGapClearance}px minimum - ring 0's longest mark reaches too close to ring 1's base.`);
  }
  return { margin, marginPct, gapClearance };
}

export {
  CENTER, FACE_D, FACE_R, RINGS, PER_RING, ANGLE_STEP, LEVELS, RING_R,
  TICK_LEN_BASE, TICK_LEN_STEP, tickLength, TICK_STROKE_WIDTH, TICK_CAP_RADIUS, tickReach,
  MARKER_COUNT, MARKER_OFFSET_BASE, MARKER_OFFSET_STEP, MARKER_RADIUS_BASE, MARKER_RADIUS_STEP,
  markerOffset, markerRadius, markerReach,
  outerReach, validateGeometry,
};
