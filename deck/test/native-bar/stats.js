// @ts-check
// Pure helpers for the native bar harness: percentiles, the coefficient of variation, a seeded
// random source and the bursty stream plan. No DOM, no Node APIs, so node:test runs them without
// Chrome. A test helper, not part of the product.

/**
 * The p-th percentile (nearest rank, p in 0..100) of a list of numbers, or null for an empty list.
 * @param {number[]} xs @param {number} p
 */
export function percentile(xs, p) {
  const v = xs.filter(x => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length, Math.max(1, rank)) - 1];
}

/** @param {number[]} xs */
export const p95 = xs => percentile(xs, 95);

/** @param {number[]} xs */
export function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Coefficient of variation: population standard deviation over the mean. Null for an empty list
 * or a zero mean (nothing moved, so there is no rate to vary).
 * @param {number[]} xs
 */
export function cv(xs) {
  const m = mean(xs);
  if (m == null || m === 0) return null;
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / m;
}

/**
 * Paseo's streaming gate over a rAF sampler: `samples` is one {t, len} per frame of the live row's
 * text length. Characters per frame are the differences between frames (zeros included: a frame
 * that shows nothing new is part of the rhythm). Gaps are the times between frames that changed
 * what is visible.
 * @param {{ t: number, len: number }[]} samples
 */
export function streamGate(samples) {
  const perFrame = [], gaps = [];
  let lastChange = null;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].len - samples[i - 1].len;
    perFrame.push(Math.max(0, d));
    if (d > 0) { if (lastChange != null) gaps.push(samples[i].t - lastChange); lastChange = samples[i].t; }
  }
  return { frames: perFrame.length, cv: cv(perFrame), p95Gap: p95(gaps), maxGap: gaps.length ? Math.max(...gaps) : null, updates: gaps.length + (lastChange != null ? 1 : 0) };
}

/**
 * Frame intervals to p95 and dropped frames at 60 Hz: an interval of k frame lengths dropped k-1.
 * @param {number[]} stamps rAF timestamps, in order
 */
export function frameStats(stamps, hz = 60) {
  const dts = [];
  for (let i = 1; i < stamps.length; i++) dts.push(stamps[i] - stamps[i - 1]);
  const f = 1000 / hz;
  const dropped = dts.reduce((a, dt) => a + Math.max(0, Math.round(dt / f) - 1), 0);
  return { frames: dts.length, p95: p95(dts), max: dts.length ? Math.max(...dts) : null, dropped };
}

/** A seeded random source (mulberry32): the same seed gives the same stream every run. @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ("the Northwind Bakery menu lists sourdough rye and a seasonal tart alex asked juno to check every price "
  + "before the site update goes out kit reviews the copy and the tests run on the box each morning").split(" ");

/**
 * The reply a burst turn streams: prose, a list, a code fence and a table, long enough for about
 * six seconds at 50 ms batches. The first line carries `marker` so the harness can find the row.
 * @param {number} seed @param {string} marker
 */
export function burstText(seed, marker) {
  const r = rng(seed);
  const words = n => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
  const para = () => { const s = words(18 + Math.floor(r() * 30)); return s[0].toUpperCase() + s.slice(1) + "."; };
  const out = [`${marker} Here is the plan for the Northwind Bakery menu.`, ""];
  for (let section = 0; section < 9; section++) {
    out.push(`## Part ${section + 1}`, "", para(), "", para(), "");
    out.push("- " + words(6), "- " + words(8), "- " + words(5), "");
    out.push("```js", `const prices = { sourdough: 6.5, rye: 5.75, tart: ${5 + section} };`, "for (const [name, usd] of Object.entries(prices)) {",
      "  console.log(name.padEnd(12), usd.toFixed(2));", "}", "```", "");
    out.push("| Item | Price | Note |", "|---|---|---|", `| Sourdough | 6.50 | ${words(3)} |`, `| Rye | 5.75 | ${words(3)} |`, `| Tart | ${5 + section}.00 | ${words(3)} |`, "");
    out.push(para(), "");
  }
  out.push(`Done with ${marker}.`);
  return out.join("\n");
}

/**
 * Cut `text` the way the box sends it: 50 ms batches of 20 to 400 characters (mostly small, now and
 * then a lump), with a short stall about once a second. Returns [{ wait, text }], wait in ms
 * before that batch.
 * @param {string} text @param {number} seed
 */
export function burstPlan(text, seed) {
  const r = rng(seed ^ 0x9e3779b9);
  const out = [];
  let i = 0, n = 0;
  while (i < text.length) {
    const lump = r() < 0.12;
    const size = lump ? 200 + Math.floor(r() * 201) : 20 + Math.floor(r() * 61);
    const stall = n > 0 && n % 20 === 0 ? 100 + Math.floor(r() * 80) : 0;
    out.push({ wait: n === 0 ? 0 : 50 + stall, text: text.slice(i, i + size) });
    i += size; n++;
  }
  return out;
}

/**
 * p95 over `total` events when only those at or over `threshold` were reported (the Event Timing
 * API drops entries under its durationThreshold, 16 ms at the least). Every unreported event was
 * under the threshold, so the top values are all reported: the p95 is exact when more than 5 % of
 * events were reported, and otherwise only known to be under the threshold.
 * @param {number[]} reported values at or over threshold @param {number} total @param {number} threshold
 * @returns {{ value: number|null, under: boolean }} under: the p95 is below threshold (value is null then)
 */
export function thresholdP95(reported, total, threshold) {
  const top = reported.filter(x => x >= threshold).sort((a, b) => a - b);
  if (total <= 0) return { value: null, under: false };
  const rank = Math.ceil(0.95 * total); // 1-based, nearest rank
  const below = total - top.length;     // all under threshold, and all ranked first
  if (rank <= below) return { value: null, under: true };
  return { value: top[rank - below - 1], under: false };
}
