// The FINAL Vyre code layout's decoder: 2 rings x 36 marks x 2 bits (four tick lengths), the
// beauty-pass geometry from vyrecode2.js (round5). Ported from round4/round5's decode-core.js,
// which sampled a single bit per dot as a disk luminance average; this layout instead reads a
// TICK LENGTH per mark (0..3, four discrete lengths) and adds perspective (tilt) correction via
// an ellipse fit on the ring/tint boundary, which is the piece round5's prototype scoped out
// (it passed 14/17, failing only the 3 perspective scenarios).
//
// Geometry (RING_R, tick lengths, CENTER/FACE_R) comes from deck/vendor/vyrecode/geometry.js -
// app-design's own single source, shared with their renderer - not restated here by hand: an
// earlier hand-copied version already drifted out of sync once (the ring-gap/margin finding
// below), which is exactly the failure mode a shared import removes. See defaultGeometry().
//
// Exported as a function so the SAME source can be serialized into a <script> the browser runs
// (Function.prototype.toString), same technique as decode-core.js - which is why decodeCore2
// takes the geometry as a plain-data argument (numbers only, no imported functions) rather than
// closing over the geometry module: a toString()'d function can't carry an ES import with it
// into a freshly-evaluated page, but a plain object built from one, JSON-serialized by the
// caller, works in either context. defaultGeometry() below is the one place that reads the
// live geometry module, for callers in a normal module graph (deck/js/scan.js); test/harness.js
// calls it once in Node and injects the resulting plain object alongside the toString()'d source.

import * as geo from "../vendor/vyrecode/geometry.js";

/** The plain-data geometry decodeCore2() needs, read once from the shared geometry.js. Callers
 * that can't use a live import (the toString()-injected harness) build the same shape by hand
 * from their own copy of the numbers instead - see test/harness.js. */
function defaultGeometry() {
  return {
    CENTER: geo.CENTER,
    FACE_R: geo.FACE_R,
    RING_R: geo.RING_R,
    TINT_MARGIN: 40, // vyrecode2.js's own hardcoded tint-disc margin past RING_R[1] - decorative
                      // background, not part of geometry.js's content-reach invariant, so it
                      // isn't exported there; kept here as the one place both sides agree on it
    LEVELS: [0, 1, 2, 3].map(geo.tickLength), // e.g. [6, 12, 18, 24]
    CAP_RADIUS: geo.TICK_CAP_RADIUS, // the round line-cap's own overshoot past the nominal length
  };
}

function decodeCore2(g) {
  const geometry = g || defaultGeometry();
  const CENTER = geometry.CENTER;
  const FACE_R = geometry.FACE_R;
  const RINGS = 2, PER_RING = 36;
  const ANGLE_STEP = 360 / PER_RING;
  const RING_R = geometry.RING_R;
  const TINT_R = RING_R[1] + geometry.TINT_MARGIN; // the tint disc's own edge, a strong, reliable boundary
  const LEVELS = geometry.LEVELS; // tick lengths for level 0..3 (ticksSunburst's own formula)
  const MAX_OFFSET = LEVELS[LEVELS.length - 1]; // the longest tick's own nominal length
  // A round line-cap always overshoots the nominal length by its own radius, at every level
  // (see sampleMarkLength's own comment) - subtracted from the raw read before quantizing.
  // Found by testing: app-design's stroke-width widening (4.5 -> 6, ADR 0043 2e) grew this
  // overshoot (2.25 -> 3) just enough, against LEVELS' own tight 6px spacing, to flip several
  // marks a level high even at pristine - not a blur-robustness win once this is corrected for,
  // it was an uncorrected systematic bias.
  const CAP_RADIUS = geometry.CAP_RADIUS ?? 2.25;

  /** Small-disk area average, same technique as round4's sampleDot (degrades gracefully under
   * blur instead of an edge read, which blur destroys first). */
  function areaSample(getLum, x, y, patch) {
    let sum = 0, n = 0;
    for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
      const lum = getLum(x + gx * patch * 0.5, y + gy * patch * 0.5);
      if (lum === null) continue;
      sum += lum; n++;
    }
    return n === 0 ? null : sum / n;
  }

  // The ring gap (RING_R[1]-RING_R[0]) was originally tight against the longest tick's own
  // reach (round5's first-pass geometry: level 3's 29px line plus its round line-cap, ~31.25px,
  // against a 35px gap): sampling a mark's own trailing offsets as "background" (decode-core.js's
  // median-split trick) picked up the NEXT ring's own anchor round-cap, which bleeds inward by
  // half its stroke width - a real, found-by-testing artifact of that geometry, not a sampling
  // bug. Fixed by never trusting the tail of a mark's own profile for "background": ink and
  // background are each read from an independent reference point instead (see
  // sampleMarkLength). app-design's revised geometry (RING_R=[188,222], ticks 6/12/18/24)
  // widens the clearance to 7.75px, but this independent-reference fix stays regardless - it
  // costs nothing when the margin is generous, and the margin can tighten again in a future
  // revision.
  /**
   * One mark's tick length, in the ORIGINAL (pre-scale) coordinate units vyrecode2.js drew it
   * in. `ink` is read at the anchor itself (every level's line starts there, so it is always
   * ink); `bg` is read at the SAME radius band but rotated half a slot angularly (a position no
   * mark ever draws into, in this ring or the other one) - two independent reference reads,
   * not one profile's own two ends, so a bright/dark neighbour at the SAME angle (the ring-gap
   * bleed above) can never contaminate the threshold. Then walks outward along the mark's own
   * ray to find where it stops being on the ink side of that threshold.
   */
  function sampleMarkLength(getLum, cx, cy, rot, scale, i) {
    const ring = Math.floor(i / PER_RING), slot = i % PER_RING;
    const angleDeg = slot * ANGLE_STEP + rot;
    const rad = (angleDeg - 90) * Math.PI / 180;
    const r = RING_R[ring] * scale;
    const ax = cx + Math.cos(rad) * r, ay = cy + Math.sin(rad) * r;
    const patch = 2.3 * scale;
    const midOffset = MAX_OFFSET * 0.55;
    const midRad = (angleDeg + ANGLE_STEP / 2 - 90) * Math.PI / 180;
    const ink = areaSample(getLum, ax, ay, patch);
    const bg = areaSample(getLum, cx + Math.cos(midRad) * (r + midOffset * scale), cy + Math.sin(midRad) * (r + midOffset * scale), patch);
    if (ink === null || bg === null || Math.abs(ink - bg) < 3) return null; // no usable contrast
    const darker = ink < bg;
    const threshold = (ink + bg) / 2;
    // Absolute offsets, NOT scaled to the current geometry's own max tick length: this only
    // needs enough resolution to tell the 4 known lengths apart somewhere under ~28.5px, and
    // going past the shorter ticks' own reach into pure background is fine (still well inside
    // the ring gap) - confirmed by testing: scaling this down with a shorter max tick actually
    // cost blur/scale robustness for no gain, since blur is a real-pixel-space effect that
    // doesn't shrink just because the drawn ticks did.
    const offsets = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 28.5];
    const profile = offsets.map(o => areaSample(getLum, ax + Math.cos(rad) * o * scale, ay + Math.sin(rad) * o * scale, patch));
    if (profile.some(v => v === null)) return null;
    let lastInk = -1;
    for (let k = 0; k < offsets.length; k++) {
      const isInk = darker ? profile[k] < threshold : profile[k] > threshold;
      if (isInk) lastInk = k; else break;
    }
    if (lastInk < 0) return 0;
    // linear interpolation between lastInk and the next sample for sub-step precision
    let lenEstimate = offsets[lastInk];
    if (lastInk + 1 < offsets.length) {
      const a = profile[lastInk], b = profile[lastInk + 1];
      const t = (threshold - a) / (b - a || 1e-6);
      if (t > 0 && t < 1) lenEstimate = offsets[lastInk] + t * (offsets[lastInk + 1] - offsets[lastInk]);
    }
    // The round line-cap always extends visible ink CAP_RADIUS past the tick's own nominal
    // length, at every level equally - subtract it so lenEstimate lines up with LEVELS' own
    // nominal values instead of reading systematically long.
    return Math.max(0, lenEstimate - CAP_RADIUS);
  }

  function lengthToLevel(len) {
    let best = 0, bestD = Infinity;
    for (let lv = 0; lv < LEVELS.length; lv++) { const d = Math.abs(len - LEVELS[lv]); if (d < bestD) { bestD = d; best = lv; } }
    return best;
  }

  /** Searches candidate rotations/scales (an affine model), reading all 72 marks' tick lengths
   * and quantizing to levels -> 144 bits (levelsToBits). Same "never truncate mid-tie" fix as
   * decode-core.js: 36 rotations tie exactly by construction, so topK must cover the whole tie. */
  function search(getLum, cx, cy, opts = {}) {
    // A continuous, arbitrary camera-frame rotation is not restricted to a nice multiple of the
    // 10deg mark spacing, and each mark's patch is only a couple of pixels wide, so a coarse
    // step (round4/round5's 2deg, fine for a per-dot disk read) leaves gaps a ray-walk can fall
    // clean through - confirmed by testing: rot=37deg decodes with 1 mark error, its rotStep-2
    // neighbour rot=38 decodes with 65/72 wrong. 0.5deg keeps every candidate within a quarter
    // of a mark's own patch radius of the true angle.
    const rotStep = opts.rotStep || 0.5;
    const scales = opts.scales || [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];
    const results = [];
    for (const scale of scales) {
      for (let rot = 0; rot < 360; rot += rotStep) {
        const levels = new Array(RINGS * PER_RING);
        let confidence = 0, bad = 0;
        for (let i = 0; i < levels.length; i++) {
          const len = sampleMarkLength(getLum, cx, cy, rot, scale, i);
          if (len === null) { bad++; levels[i] = 0; continue; }
          levels[i] = lengthToLevel(len);
          confidence += 1 / (1 + Math.min(...LEVELS.map(lv => Math.abs(len - lv))));
        }
        if (bad > levels.length / 2) continue;
        results.push({ rot, scale, levels, confidence });
      }
    }
    // No top-K pruning: unlike decode-core.js's dot search, this ray-walk's confidence isn't
    // a reliable ranking signal on its own (a wrong scale can, by chance, still land its
    // background probe on a real neighbouring mark and read as a falsely "clean" bimodal
    // profile) - the caller's RS/CRC check is what actually decides real from spurious, so it
    // needs every candidate available to try, not just the top-scoring ones. Sorted so a
    // caller that tries them in order still checks the likeliest first.
    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  // ---- perspective (tilt) correction, from the tint disc's own boundary --------------------
  /**
   * Finds the tint-disc edge along `angleCount` rays from the given centre, by sampling a
   * radial luminance profile around the expected radius (TINT_R * roughly the working scale
   * range) and locating the last strong ink/background transition - the same kind of adaptive,
   * no-fixed-threshold read as sampleMarkLength, just at one ring instead of many.
   * @returns {Array<[number, number]>} boundary points in image (x, y)
   */
  function findTintBoundary(getLum, cx, cy, roughScale) {
    const angleCount = 64;
    const pts = [];
    // pal.tint is deliberately a SOFT wash close to pal.ground (a whisper of hue, not a flat
    // block - see vyrecode2.js's paletteFor), so scanning for the single biggest jump anywhere
    // along a long ray actually finds a MARK's own (much higher-contrast) edge most of the
    // time, not the tint/ground edge - found by testing: a wide r-range fit an ellipse to the
    // marks' own ring, not the tint disc, and calibration got worse the wider the range was
    // opened. Fixed by scanning from a known-background anchor (well outside the whole code)
    // INWARD, and taking the first place the reading stops matching that anchor and STAYS
    // changed for a couple more samples (persistence) - that is specifically the outermost
    // edge, wherever it lands, not whichever edge happens to have the strongest contrast.
    // TINT_R sits only 15px inside the 600px canvas's own edge (vyrecode2.js's own margin), so
    // there is very little true background visible past it even before any distortion -
    // confirmed by testing: a wide rMax (following through a distorted disc's own worst-case
    // growth) mostly samples off-canvas (null) at every angle, since the disc already reaches
    // nearly to the frame. Kept tight and close to TINT_R itself instead.
    const rMin = TINT_R * roughScale * 0.75, rMax = TINT_R * roughScale * 1.05;
    const steps = 32;
    for (let a = 0; a < angleCount; a++) {
      const theta = (a / angleCount) * Math.PI * 2;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const profile = [];
      for (let s = 0; s <= steps; s++) {
        const r = rMin + (rMax - rMin) * (s / steps);
        profile.push(getLum(cx + cos * r, cy + sin * r)); // null: off-canvas (tilt pushes the far edge out)
      }
      let bgRef = null;
      for (let s = steps; s >= steps - 3 && s >= 0; s--) if (profile[s] !== null) { bgRef = profile[s]; break; }
      if (bgRef === null) continue;
      let edgeIdx = -1;
      for (let s = steps - 1; s >= 1; s--) {
        if (profile[s] === null || profile[s - 1] === null) continue;
        const dev = Math.abs(profile[s] - bgRef), devPrev = Math.abs(profile[s - 1] - bgRef);
        if (dev > 4.5 && devPrev > 4.5) { edgeIdx = s; break; } // first = outermost, scanning in from the background side
      }
      if (edgeIdx < 0) continue;
      const r = rMin + (rMax - rMin) * (edgeIdx / steps);
      pts.push([cx + cos * r, cy + sin * r]);
    }
    return pts;
  }

  /** Least-squares general conic fit (x^2 + Bxy + Cy^2 + Dx + Ey + F = 0, A normalized to 1),
   * i.e. the classic "fit an ellipse to these boundary points" step of an ellipse-based tilt
   * correction (the same first step a fiducial-marker reader like RUNE-tag uses to recover a
   * tilted circle's pose from its projected ellipse). */
  function fitEllipse(pts) {
    if (pts.length < 12) return null;
    // Solve x^2 = -(Bxy + Cy^2 + Dx + Ey + F) via normal equations (5 unknowns).
    const rows = pts.map(([x, y]) => [x * y, y * y, x, y, 1]);
    const b = pts.map(([x]) => -(x * x));
    const n = 5;
    const ATA = Array.from({ length: n }, () => new Array(n).fill(0));
    const ATb = new Array(n).fill(0);
    for (let k = 0; k < rows.length; k++) {
      for (let i = 0; i < n; i++) {
        ATb[i] += rows[k][i] * b[k];
        for (let j = 0; j < n; j++) ATA[i][j] += rows[k][i] * rows[k][j];
      }
    }
    const sol = solveLinear(ATA, ATb);
    if (!sol) return null;
    const [B, C, D, E, F] = sol;
    // Conic matrix [[1, B/2],[B/2, C]] -> eigen-decompose for axis angle + lengths.
    const a11 = 1, a12 = B / 2, a22 = C;
    const trace = a11 + a22, det = a11 * a22 - a12 * a12;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const l1 = trace / 2 + disc, l2 = trace / 2 - disc; // eigenvalues
    if (l1 <= 0 || l2 <= 0) return null;
    const phi = 0.5 * Math.atan2(2 * a12, a11 - a22); // rotation of the major axis
    // Centre from D,E,F (partial derivatives = 0), via the 2x2 system
    // [[2A,B],[B,2C]] [cx,cy]^T = [-D,-E]^T (A = 1 here).
    const M = [[2, B], [B, 2 * C]];
    const rhs = [-D, -E];
    const centre = solveLinear(M, rhs);
    if (!centre) return null;
    const [ecx, ecy] = centre;
    // Semi-axis lengths from the eigenvalues and the constant term evaluated at the centre.
    const constAtCentre = 1 * ecx * ecx + B * ecx * ecy + C * ecy * ecy + D * ecx + E * ecy + F;
    const k = -constAtCentre;
    if (k <= 0) return null;
    const semiMajor = Math.sqrt(k / l2), semiMinor = Math.sqrt(k / l1);
    if (!isFinite(semiMajor) || !isFinite(semiMinor) || semiMinor <= 0) return null;
    return { cx: ecx, cy: ecy, phi, semiMajor: Math.max(semiMajor, semiMinor), semiMinor: Math.min(semiMajor, semiMinor) };
  }

  function solveLinear(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-9) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      const pv = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= pv;
      for (let r = 0; r < n; r++) if (r !== col) { const f = M[r][col]; for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]; }
    }
    return M.map(row => row[n]);
  }

  /** Applies the inverse rotateX(theta)+perspective(f) un-projection (CSS's own compositing
   * model, inverted in closed form - see team/archive/work-journals/pwa.md) to one point, in the ellipse-centred,
   * axis-aligned frame described by (cx, cy, phi). */
  function unproject(x, y, cx, cy, phi, theta, f) {
    const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi), cosT = Math.cos(theta), tanT = Math.tan(theta);
    const dx = x - cx, dy = y - cy;
    const xr = dx * cosPhi + dy * sinPhi, yr = -dx * sinPhi + dy * cosPhi;
    const k = 1 + (yr * tanT) / f;
    const X = xr / k, Y = yr / (k * cosT);
    const ux = X * cosPhi - Y * sinPhi, uy = X * sinPhi + Y * cosPhi;
    return [ux + cx, uy + cy];
  }

  /**
   * Builds a coordinate-correcting function from the fitted ellipse. A naive ar = cos(theta)
   * (the ellipse's own axis ratio) badly OVER-estimates the tilt once perspective(f) is
   * anywhere near comparable to the code's own radius (confirmed by testing: a real 15deg
   * rotateX fits an ellipse of ratio 0.6, which is acos(0.6) = 53deg, more than 3x too steep) -
   * the foreshortening from a finite f skews the ellipse's shape well past pure cos(theta). So
   * instead of guessing, this CALIBRATES theta and f together: it knows the boundary points
   * came from a true circle of radius TINT_R, so it grid-searches (theta, f, and the sign of
   * theta - CSS's rotateX direction isn't recoverable from the ellipse alone) for whichever
   * pair, once applied to the boundary points via unproject(), leaves them landing on a circle
   * of that exact radius with the least variance - i.e. it fits the projection model itself to
   * the one shape it has ground truth for, rather than reading the tilt off the shape by eye.
   * Returns a list of { name, mapXY }; "none" (identity) is always included so a correction that
   * overshoots on an already-good frame never makes things worse.
   */
  function perspectiveCandidates(ellipse, boundary) {
    const candidates = [{ name: "none", mapXY: (x, y) => [x, y] }];
    if (!ellipse || !boundary || boundary.length < 8) return candidates;
    const ar = ellipse.semiMinor / ellipse.semiMajor;
    if (ar > 0.97) return candidates; // near-circular: no meaningful tilt, affine search covers it
    const { cx, cy, phi } = ellipse;
    let best = null;
    for (const sign of [1, -1]) {
      for (let thetaDeg = 3; thetaDeg <= 45; thetaDeg += 3) {
        for (const f of [500, 650, 800, 950, 1100, 1300, 1600]) {
          const theta = sign * thetaDeg * Math.PI / 180;
          const radii = boundary.map(([x, y]) => {
            const [ux, uy] = unproject(x, y, cx, cy, phi, theta, f);
            return Math.hypot(ux - cx, uy - cy);
          });
          const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
          const variance = radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length;
          // score: agreement with a constant radius (variance) AND that radius being close to
          // the code's own known TINT_R (mean) - both must hold for a real fit, not just any
          // circle.
          const score = variance + (mean - TINT_R) ** 2 * 0.3;
          if (!best || score < best.score) best = { score, theta, f };
        }
      }
    }
    if (!best || best.score > (TINT_R * 0.12) ** 2) return candidates; // no confident fit
    candidates.push({ name: `t${(best.theta * 180 / Math.PI).toFixed(0)}f${best.f}`, mapXY: (x, y) => unproject(x, y, cx, cy, phi, best.theta, best.f) });
    return candidates;
  }

  /** Runs the full pipeline: ellipse-fit boundary detection at a rough scale, then the normal
   * rotation/scale search once per perspective candidate (including "none"), returning every
   * candidate's levels sorted by confidence, tagged with which correction produced it. */
  function searchWithPerspective(getLum, cx, cy, opts = {}) {
    const roughScale = 1.0;
    const boundary = findTintBoundary(getLum, cx, cy, roughScale);
    const ellipse = fitEllipse(boundary);
    const candidates = perspectiveCandidates(ellipse, boundary);
    const all = [];
    for (const cand of candidates) {
      const wrappedLum = (x, y) => { const [ux, uy] = cand.mapXY(x, y); return getLum(ux, uy); };
      const results = search(wrappedLum, cx, cy, opts);
      for (const r of results) all.push({ ...r, correction: cand.name });
    }
    all.sort((a, b) => b.confidence - a.confidence);
    return all;
  }

  return { search, searchWithPerspective, sampleMarkLength, lengthToLevel, findTintBoundary, fitEllipse, perspectiveCandidates,
    RINGS, PER_RING, ANGLE_STEP, RING_R, TINT_R, LEVELS, CENTER, FACE_R };
}

export { decodeCore2 };
