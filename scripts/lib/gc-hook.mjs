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
