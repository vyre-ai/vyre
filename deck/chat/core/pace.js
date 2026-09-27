// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/app/src/agent-stream/text-reveal.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS, one pacer per
// streaming text with injected time and lengths (no grapheme clamp: the view slices the text itself).
//
// Paced reveal for streaming text. Deltas arrive in lumps (the Switchboard coalesces partial text),
// and painting each lump as it lands reads as jagged. So an arrival only moves the target, and the
// reveal rate comes from the backlog: each frame shows ceil(backlog * elapsed / horizon)
// characters (at least one, so the tail always finishes), which drains any backlog over about
// `horizonMs` (150 ms) and speeds up when the model runs ahead. The reveal moves at most once per
// 60 Hz frame, even on a faster display, carrying the frame remainder forward. A frame's elapsed
// time is capped at 250 ms, so a stalled tab does not jump on its own. Done shows everything. Pure:
// the caller passes the time, there are no timers, so a view drives it from its frame clock and a
// test from plain numbers. Shared core: no DOM and no Node APIs.

/** Backlog is drained over this horizon. */
export const PACE_HORIZON_MS = 150;
/** The reveal moves at most once per 60 Hz frame. */
export const PACE_FRAME_MS = 1000 / 60;
/** @deprecated kept for callers of the earlier pacer: the horizon plays the part of the lag bound. */
export const PACE_MAX_LAG_MS = PACE_HORIZON_MS;
/** @deprecated the earlier steady rate; the reveal now follows the backlog alone. */
export const PACE_CPS = 90;
/** A frame's elapsed time is capped, so a stalled tab does not produce a wild step. */
const MAX_ELAPSED_MS = 250;

/**
 * Characters to reveal on this frame: proportional to the backlog, at least one.
 * @param {number} backlog @param {number} elapsedMs @param {number} [horizonMs]
 */
export function revealStep(backlog, elapsedMs, horizonMs = PACE_HORIZON_MS) {
  if (backlog <= 0) return 0;
  if (horizonMs <= 0) return backlog;
  const elapsed = Math.min(Math.max(elapsedMs, 0), MAX_ELAPSED_MS);
  if (elapsed <= 0) return 0;
  if (elapsed >= horizonMs) return backlog;
  return Math.min(backlog, Math.max(1, Math.ceil((backlog * elapsed) / horizonMs)));
}

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
 * @param {{ horizonMs?: number, frameMs?: number, maxLagMs?: number, cps?: number }} [opts]
 *   maxLagMs: the earlier name for horizonMs, still read; cps: ignored (the rate follows the backlog).
 * @returns {Pacer}
 */
export function createPacer(opts = {}) {
  const horizon = opts.horizonMs ?? opts.maxLagMs ?? PACE_HORIZON_MS;
  const frameMs = opts.frameMs ?? PACE_FRAME_MS;
  let target = 0, shown = 0, finished = false;
  /** When the last frame moved the reveal (with the remainder carried forward), or null before the first. */
  /** @type {number|null} */ let frameAt = null;

  /** @param {number} now */
  function advance(now) {
    if (finished) { shown = target; return; }
    const elapsed = frameAt === null ? frameMs : now - frameAt;
    if (elapsed < frameMs) return;                       // the 60 Hz cap
    frameAt = now - (elapsed % frameMs);
    shown = Math.min(target, shown + revealStep(target - shown, elapsed, horizon));
  }

  return {
    push(targetLength, now) {
      const n = Math.max(0, Math.floor(Number(targetLength) || 0));
      if (frameAt === null) frameAt = now;                // the first arrival starts the clock
      if (n < target) shown = Math.min(shown, n);
      target = n;
    },
    done() { finished = true; shown = target; },
    visible(now) { advance(now); return shown; },
    settled(now) { advance(now); return shown >= target; },
  };
}
