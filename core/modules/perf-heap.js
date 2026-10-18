// @ts-check
// perf-heap: a measurement for scripts/perf-check, off unless VYRE_PERF_MODULE_HEAP names a file and the process was started with --expose-gc. Around each module's load and start it forces a GC and appends one line,
// { module, before, after } in MB, so the heap a module keeps once it is up can be read in start order. Nothing else changes; without the variable this file is never called.
import fs from "node:fs";

/** @returns {number | null} heapUsed in MB right after a full GC, or null when this is not a measuring run */
export function heapMark() {
  const gc = /** @type {(() => void) | undefined} */ (globalThis.gc);
  if (!process.env.VYRE_PERF_MODULE_HEAP || typeof gc !== "function") return null;
  gc(); gc();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
}

/** @param {string} module @param {number | null} before */
export function heapNote(module, before) {
  const file = process.env.VYRE_PERF_MODULE_HEAP, after = heapMark();
  if (!file || before === null || after === null) return;
  try { fs.appendFileSync(file, JSON.stringify({ module, before, after }) + "\n"); } catch { /* a measurement, never a stop */ }
}
