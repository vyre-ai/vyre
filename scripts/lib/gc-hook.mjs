// @ts-check
// gc-hook — loaded into vyred via `node --expose-gc --import` so scripts/perf-check can read what
// vyred really holds once idle. RSS alone can't tell a live heap from pages V8 and the allocator
// kept after the startup indexing pass, and how much they keep depends on the host: the same
// commit read 185 or 255 MB on two GitHub runners. So on SIGUSR2 this runs a full GC, then writes
// process.memoryUsage() (MB) to VYRE_PERF_GC_FILE. Nothing happens without that variable.

import fs from "node:fs";

const out = process.env.VYRE_PERF_GC_FILE;
const gc = /** @type {(() => void) | undefined} */ (globalThis.gc);
if (out && gc) {
  const mb = n => Math.round(n / 1024 / 1024 * 10) / 10;
  process.on("SIGUSR2", () => {
    // Twice, a turn apart: the first pass can leave objects whose finalizers free more.
    gc();
    setImmediate(() => {
      gc();
      const m = process.memoryUsage();
      try {
        fs.writeFileSync(out, JSON.stringify({ rss: mb(m.rss), heapTotal: mb(m.heapTotal), heapUsed: mb(m.heapUsed), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers) }));
      } catch { /* best effort: perf-check reports a missing snapshot */ }
    });
  });
}

// The startup heap peak: what vyred itself holds at its fullest in its first STARTUP_S seconds, read right after each garbage collection (the live heap, not the pages V8 and the allocator
// reserve around it). RSS over the same window varies by 60 MB between runs of identical code; this does not. Written once, at the end of the window, to VYRE_PERF_HEAPPEAK_FILE.
import { PerformanceObserver } from "node:perf_hooks";
import v8 from "node:v8";
const peakOut = process.env.VYRE_PERF_HEAPPEAK_FILE;
if (peakOut) {
  const STARTUP_S = 30, mbOf = (/** @type {number} */ n) => Math.round(n / 1024 / 1024 * 10) / 10;
  let peak = 0, collections = 0;
  const obs = new PerformanceObserver(() => {
    if (process.uptime() > STARTUP_S) return;
    collections++;
    peak = Math.max(peak, v8.getHeapStatistics().used_heap_size);
  });
  obs.observe({ entryTypes: ["gc"] });
  const done = setTimeout(() => {
    obs.disconnect();
    try { fs.writeFileSync(peakOut, JSON.stringify({ heapUsedPeak: mbOf(peak), collections })); } catch { /* perf-check reports a missing file */ }
  }, Math.max(0, STARTUP_S * 1000 - process.uptime() * 1000) + 500);
  done.unref();
}
