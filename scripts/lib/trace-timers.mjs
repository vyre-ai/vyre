// Preloaded by scripts/test-counts.mjs (--import): remembers where each timer was made, and on SIGUSR2 (sent when a test file has not ended in its time limit) writes the creation stacks of the timers
// still alive to stderr. A file that passes all its tests and keeps the process open is nearly always an interval or a long timeout nobody cleared; this names the line that made it.
// It watches with an async hook and replaces nothing: timers, promisify forms and function names stay what a test expects.
import { createHook } from "node:async_hooks";

/** @type {Map<number, { resource: any, err: Error }>} */
const live = new Map();
createHook({
  init(id, type, _trigger, resource) { if (type === "Timeout") live.set(id, { resource, err: new Error() }); },
  destroy(id) { live.delete(id); },
}).enable();

process.on("SIGUSR2", () => {
  const out = [];
  for (const { resource, err } of live.values()) {
    if (!resource || (typeof resource.hasRef === "function" && !resource.hasRef())) continue;
    const frames = String(err.stack || "").split("\n").slice(2).filter(l => !l.includes("trace-timers.mjs") && !l.includes("node:internal")).slice(0, 4).map(l => l.trim());
    out.push(`  timer(${resource._idleTimeout}${resource._repeat ? ", repeating" : ""}) made at ${frames.join(" <- ") || "(no frame)"}`);
  }
  process.stderr.write(`\n----- live timers in process ${process.pid} (${out.length}):\n${out.slice(0, 12).join("\n")}\n`);
});
