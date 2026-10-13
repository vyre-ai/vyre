// @ts-check
// gc-nudge - give the garbage collector a hand during a startup pass that allocates a lot and frees it at once.
// V8 lets the old generation grow a long way before it collects, so the first read of a large history left vyred's resident size 15 to 20 MB above where it settles
// (perf-check's startup peak, 200 MB). A pass that works in batches calls collectIfHeavy() between them: when the heap has grown a good way past where the last
// collection left it, it collects once. It never runs more than once a second and does nothing where a collection cannot be had.

import v8 from "node:v8";
import vm from "node:vm";

const GROWTH = 24 * 1024 * 1024;
const EVERY_MS = 1000;

/** @type {(() => void) | null | undefined} */ let collect;
let floor = 0;
let last = 0;

/** @returns {(() => void) | null} */
function getCollector() {
  if (collect !== undefined) return collect;
  try {
    const g = /** @type {any} */ (globalThis).gc;
    if (typeof g === "function") collect = g;
    else { v8.setFlagsFromString("--expose-gc"); collect = vm.runInNewContext("gc"); }
  } catch { collect = null; }
  if (typeof collect !== "function") collect = null;
  return collect;
}

/** Collect when the heap is well past where the last collection left it. Returns true when it did. */
export function collectIfHeavy() {
  const now = Date.now();
  if (now - last < EVERY_MS) return false;
  const used = v8.getHeapStatistics().used_heap_size;
  if (floor && used - floor < GROWTH) return false;
  if (!floor) { floor = used; return false; }
  const gc = getCollector();
  if (!gc) return false;
  gc();
  last = Date.now();
  floor = v8.getHeapStatistics().used_heap_size;
  return true;
}
