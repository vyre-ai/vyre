// @ts-check
// A TEST-ONLY renderer for the Vyre code's ring geometry (2 rings x 36 marks x 2 bits, the
// ticksSunburst style), so decode-core2.js has something to decode without depending on the
// person's face or palette. app-design owns the real, on-brand renderer (the "beauty pass",
// round5/vyrecode2.js on their branch); this fixture exists only so pwa's decoder tests and the
// pass-rate harness don't need that file or its avatar dependencies. Reconcile the two once
// app-design's renderer merges - the physical geometry (RING_R, PER_RING, LEVELS, angle
// convention) here must always match decode-core2.js's own constants exactly, since that's the
// only contract between a renderer and this decoder.
const CENTER = 300;
const FACE_D = 360, FACE_R = FACE_D / 2;
const PER_RING = 36;
const ANGLE_STEP = 360 / PER_RING;
const RING_R = [FACE_R + 30, FACE_R + 65]; // must match decode-core2.js's RING_R
const LEVELS = [8, 15, 22, 29]; // tick lengths for level 0..3, must match decode-core2.js's LEVELS

/** Two bits at position i (0..143) -> one of 4 levels for mark floor(i/2). Mirrors the real
 * renderer's bitsToLevels so a payload.js codeword maps onto marks the same way either side. */
function bitsToLevels(bits) {
  const levels = [];
  for (let i = 0; i < bits.length; i += 2) levels.push((bits[i] << 1) | bits[i + 1]);
  return levels;
}
function levelsToBits(levels) {
  const bits = [];
  for (const lv of levels) { bits.push((lv >> 1) & 1, lv & 1); }
  return bits;
}

/** Renders a plain (no face, flat two-tone) test disc for `levels` (a 72-length array of 0-3). */
function renderFixture(levels, { theme = "dark", size = 600 } = {}) {
  const ground = theme === "dark" ? "#0E0D0C" : "#F4F1EA";
  const tint = theme === "dark" ? "#161513" : "#FBFAF6"; // a flat neutral here is fine: the test
  const mark = theme === "dark" ? "#B9A98A" : "#6B5A3A";  // fixture doesn't need the avatar's own
  const markDeep = theme === "dark" ? "#F1EEE6" : "#141311"; // hue, only the same contrast shape
  const marks = levels.map((level, i) => {
    const ring = Math.floor(i / PER_RING), slot = i % PER_RING;
    const angleDeg = slot * ANGLE_STEP;
    const r = RING_R[ring];
    const rad = (angleDeg - 90) * Math.PI / 180;
    const x = CENTER + Math.cos(rad) * r, y = CENTER + Math.sin(rad) * r;
    const len = 8 + level * 7;
    const x2 = x + Math.cos(rad) * len, y2 = y + Math.sin(rad) * len;
    const fill = level >= 2 ? markDeep : mark;
    return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="${fill}" stroke-width="4.5" stroke-linecap="round" opacity="${level === 0 ? 0.55 : 1}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CENTER * 2} ${CENTER * 2}" width="${size}" height="${size}">
    <rect width="${CENTER * 2}" height="${CENTER * 2}" fill="${ground}"/>
    <circle cx="${CENTER}" cy="${CENTER}" r="${RING_R[1] + 40}" fill="${tint}"/>
    ${marks}
    <circle cx="${CENTER}" cy="${CENTER - RING_R[1] - 14}" r="2.5" fill="${markDeep}"/>
    <circle cx="${CENTER}" cy="${CENTER - RING_R[1] - 23}" r="3.8" fill="${markDeep}"/>
    <circle cx="${CENTER}" cy="${CENTER - RING_R[1] - 32}" r="5.1" fill="${markDeep}"/>
  </svg>`;
}

export { renderFixture, bitsToLevels, levelsToBits, PER_RING, ANGLE_STEP, RING_R, CENTER, LEVELS };
