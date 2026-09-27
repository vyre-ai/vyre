// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/app/src/agent-stream/text-reveal.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS, one pacer per
// streaming text with injected time, a steady display rate plus a hard bound on how far the reveal may lag.
//
// Paced reveal for streaming text. Deltas arrive in lumps (the Switchboard coalesces partial text),
// and painting each lump as it lands reads as jagged. So an arrival only moves the target; what is
// shown grows at a steady rate, faster while it is behind, and is never more than maxLagMs behind
// what had arrived. Done shows everything. Pure: the caller passes the time, there are no timers,
// so a view drives it from its frame clock and a test from plain numbers. Shared core: no DOM and
// no Node APIs.

/** Characters a second at a steady reveal: a fast reader's pace, well under any model's. */
export const PACE_CPS = 90;
/** The reveal is never further behind what arrived than this. */
export const PACE_MAX_LAG_MS = 250;
/** A frame's elapsed time is capped, so a stalled tab does not jump on its own (the lag bound still applies). */
const MAX_STEP_MS = 250;

/**
 * @typedef {{
 *   push(targetLength: number, now: number): void,
 *   done(): void,
 *   visible(now: number): number,
 *   settled(now: number): boolean,
 * }} Pacer
 */

/**
 * A pacer for one streaming text.
 * - push(targetLength, now): the text is now this long. A shorter length (the text was replaced)
 *   pulls the reveal back to it.
 * - done(): nothing more is coming; visible() is the whole target from now on.
 * - visible(now): how many characters to show at `now`. Never goes down unless the target shrank.
 * - settled(now): everything that arrived is shown.
 * @param {{ cps?: number, maxLagMs?: number }} [opts]
 * @returns {Pacer}
 */
export function createPacer({ cps = PACE_CPS, maxLagMs = PACE_MAX_LAG_MS } = {}) {
  let target = 0, shown = 0, finished = false;
  /** @type {number|null} */ let last = null;
  /** @type {[number, number][]} arrivals not yet certainly shown: [length, at] */
  let arrivals = [];

  /** @param {number} now */
  function advance(now) {
    if (finished) { shown = target; return; }
    if (last === null) { last = now; return; }
    const elapsed = Math.min(Math.max(now - last, 0), MAX_STEP_MS);
    last = Math.max(last, now);
    const backlog = target - shown;
    if (backlog <= 0) return;
    // Steady rate, or the backlog drained over maxLagMs when that is faster: behind means faster.
    const step = Math.max((cps * elapsed) / 1000, maxLagMs > 0 ? (backlog * elapsed) / maxLagMs : backlog);
    shown = Math.min(target, shown + step);
    // The hard bound: whatever had arrived maxLagMs ago is shown now.
    const cutoff = now - maxLagMs;
    let floor = 0, k = 0;
    while (k < arrivals.length && arrivals[k][1] <= cutoff) { floor = Math.max(floor, arrivals[k][0]); k++; }
    if (k) arrivals = arrivals.slice(k);
    shown = Math.min(target, Math.max(shown, floor));
  }

  return {
    push(targetLength, now) {
      const n = Math.max(0, Math.floor(Number(targetLength) || 0));
      advance(now);
      if (n < target) { shown = Math.min(shown, n); arrivals = arrivals.filter(a => a[0] <= n); }
      target = n;
      if (n > shown) arrivals.push([n, now]);
    },
    done() { finished = true; shown = target; arrivals = []; },
    visible(now) { advance(now); return Math.floor(shown); },
    settled(now) { advance(now); return shown >= target; },
  };
}
