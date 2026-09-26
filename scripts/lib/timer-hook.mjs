// @ts-check
// timer-hook — loaded into vyred via `node --import` so scripts/perf-check can see every
// recurring timer the process registers, including ones buried in a dependency it never
// imports itself. Wrapping the globals is the only way to be sure nothing is missed.
//
// Records every setInterval call (period + when) and every setTimeout call (period + when),
// timestamped, and dumps the raw list as JSON to VYRE_PERF_TIMERS_FILE on process exit.
// Aggregation happens in scripts/perf-check, not here, because the two timer kinds need
// different treatment and only the caller knows when its idle sampling window began:
//
//   - setInterval fires on its own forever once registered, so ANY setInterval call anywhere
//     in the process's life is a standing recurring timer for as long as the process runs —
//     core/watchers/index.js registers one at startup (TICK_MS = 15_000) that is still ticking
//     during idle, which is exactly the kind of thing this exists to catch.
//   - setTimeout is one-shot by construction. A debounce (core/memory/index.js's `soon`, 250ms)
//     re-arms the same period many times while events are still arriving — e.g. once per
//     transcript indexed during startup — which LOOKS like a tight poll loop by call count
//     alone but stops dead once things go quiet. Counting all-time setTimeout calls flagged
//     that debounce as a fake "250ms poll" purely because startup indexed hundreds of sessions
//     in a burst. So setTimeout is only worth flagging by how often it recurs DURING the idle
//     window the caller actually measured, which is why timestamps are kept instead of counts.
//
// This file ships in the repo (not a scratch temp file) so it can be read and reviewed like any
// other source: it is part of what scripts/perf-check measures with, not a throwaway.

import fs from "node:fs";

const out = process.env.VYRE_PERF_TIMERS_FILE;
if (out) {
  // Capped so a pathological loop cannot grow this without bound; either list overflowing its
  // cap is itself worth knowing about, so the cap is generous relative to anything expected.
  const CAP = 200_000;
  /** @type {{ period_ms: number, t: number }[]} */
  const intervalCalls = [];
  /** @type {{ period_ms: number, t: number }[]} */
  const timeoutCalls = [];

  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;

  globalThis.setInterval = function (fn, ms, ...args) {
    if (intervalCalls.length < CAP) intervalCalls.push({ period_ms: Number(ms) || 0, t: Date.now() });
    return realSetInterval.call(this, fn, ms, ...args);
  };

  globalThis.setTimeout = function (fn, ms, ...args) {
    if (timeoutCalls.length < CAP) timeoutCalls.push({ period_ms: Number(ms) || 0, t: Date.now() });
    return realSetTimeout.call(this, fn, ms, ...args);
  };

  const dump = () => {
    try { fs.writeFileSync(out, JSON.stringify({ setInterval: intervalCalls, setTimeout: timeoutCalls })); }
    catch { /* best effort: a failed dump should not stop vyred from exiting */ }
  };
  process.on("exit", dump);
  // Belt and suspenders: main.js's SIGTERM handler calls process.exit() itself, but dump early
  // too in case something ever short-circuits that path.
  process.on("SIGTERM", dump);
}
