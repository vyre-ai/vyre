// Preloaded by scripts/test-counts.mjs (--import): remembers where each timer was made, and on SIGUSR2 (sent when a test file has not ended in its time limit) writes the creation stacks of the timers
// still alive to stderr. A file that passes all its tests and keeps the process open is nearly always an interval or a long timeout nobody cleared; this names the line that made it.
const live = new Map();
for (const name of ["setTimeout", "setInterval"]) {
  const orig = /** @type {any} */ (globalThis)[name];
  /** @type {any} */ (globalThis)[name] = function (/** @type {any} */ fn, /** @type {any} */ ms, /** @type {any[]} */ ...rest) {
    const t = orig.call(this, fn, ms, ...rest);
    try { live.set(t, { name, ms, err: new Error() }); } catch { /* never in the way */ }
    return t;
  };
}
process.on("SIGUSR2", () => {
  const out = [];
  for (const [t, info] of live) {
    if (!t || t._destroyed || (typeof t.hasRef === "function" && !t.hasRef())) continue;
    const frames = String(info.err.stack || "").split("\n").slice(2).filter(l => !l.includes("trace-timers.mjs") && !l.includes("node:internal")).slice(0, 4).map(l => l.trim());
    out.push(`  ${info.name}(${info.ms}) made at ${frames.join(" <- ") || "(no frame)"}`);
  }
  process.stderr.write(`\n----- live timers in process ${process.pid} (${out.length}):\n${out.slice(0, 12).join("\n")}\n`);
});
