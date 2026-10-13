// @ts-check
// gc-hook - loaded into vyred via `node --expose-gc --import` so scripts/perf-check can read what
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

// TEMPORARY diagnostics (work/rc3/perf22): a memory timeline for the first 40 s.
if (process.env.VYRE_PERF_TRACE) {
  const t0 = Date.now();
  const mb = n => Math.round(n / 1024 / 1024);
  const iv = setInterval(() => {
    const m = process.memoryUsage();
    try { fs.appendFileSync(process.env.VYRE_PERF_TRACE, `${((Date.now() - t0) / 1000).toFixed(1)}s rss=${mb(m.rss)} heapTotal=${mb(m.heapTotal)} heapUsed=${mb(m.heapUsed)} ext=${mb(m.external)} ab=${mb(m.arrayBuffers)}\n`); } catch {}
    if (Date.now() - t0 > 40000) clearInterval(iv);
  }, 500);
  iv.unref();
}

if (process.env.VYRE_PERF_TRACE) {
  const f = process.env.VYRE_PERF_TRACE + ".events";
  const T0 = Date.now();
  const note = line => { try { fs.appendFileSync(f, `${(Date.now() / 1000).toFixed(2)} ${line}\n`); } catch {} };
  let prev = process.cpuUsage();
  const civ = setInterval(() => {
    const c = process.cpuUsage(prev); prev = process.cpuUsage();
    const ms = Math.round((c.user + c.system) / 1000);
    if (ms >= 25) note(`CPU ${ms}ms in 250ms`);
  }, 250);
  civ.unref();
  for (const name of ["setTimeout", "setInterval"]) {
    const real = globalThis[name];
    globalThis[name] = function (fn, ms, ...a) {
      if (Number(ms) > 1000 && !/statusline|seal\/client/.test(new Error().stack || "")) { const st = (new Error().stack || "").split("\n").slice(2, 5).map(x => x.trim().replace(/^at /, "").replace(/.*\/vyre\//, "")).join(" < "); note(`${name} ${ms}ms ${st}`); }
      return real.call(this, fn, ms, ...a);
    };
  }
}

if (process.env.VYRE_PERF_IDLEPROF) {
  const { Session } = await import("node:inspector");
  process.on("SIGHUP", () => {
    const s = new Session(); s.connect();
    s.post("Profiler.enable", () => s.post("Profiler.setSamplingInterval", { interval: 200 }, () => s.post("Profiler.start", () => {
      setTimeout(() => s.post("Profiler.stop", (err, { profile }) => { fs.writeFileSync(process.env.VYRE_PERF_IDLEPROF, JSON.stringify(profile)); }), 14000);
    })));
  });
}
