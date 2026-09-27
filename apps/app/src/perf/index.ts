// The perf meter (ADR 0027, section 6): one instance for the whole app, DOM-free.
//
// Screens mark through `perf`, which does nothing unless the meter is on (?perf=1 on the web), so
// the marks cost one boolean test when it is off. `afterPaint` runs a function in the next frame,
// which is when the change a screen just made is on screen.
import { createMeter } from "../../perf/meter.js";

export { BAR, createMeter, percentile } from "../../perf/meter.js";
export type Meter = ReturnType<typeof createMeter>;

export const meter: Meter = createMeter();

/** On for this page: ?perf=1 on the web. Native has no page URL; its feed lands with the native build. */
export const perfOn: boolean = (() => {
  try {
    const loc = (globalThis as { location?: { search?: string } }).location;
    return typeof loc?.search === "string" && new URLSearchParams(loc.search).get("perf") === "1";
  } catch {
    return false;
  }
})();

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * In the next frame, with the time its callbacks run: the change just made is laid out and goes
 * to paint now. The time is read in the callback, not the frame's own timestamp, which is when
 * the frame began and can precede a mark taken in the same frame.
 */
export function afterPaint(f: (t: number) => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => f(now()));
  else setTimeout(() => f(now()), 16);
}

/** The screens' marks, each a no-op when the meter is off. */
export const perf = {
  on: perfOn,
  now,
  mark(name: string, t?: number) {
    if (perfOn) meter.mark(name, t);
  },
  /** From a mark to now (or the frame time given). */
  measure(name: string, start: string, t?: number) {
    if (!perfOn) return;
    if (t !== undefined) {
      meter.mark(name + ".end", t);
      meter.measure(name, start, name + ".end");
    } else meter.measure(name, start);
  },
  record(name: string, value: number) {
    if (perfOn) meter.record(name, value);
  },
  gap(name: string, t?: number) {
    if (perfOn) meter.gap(name, t);
  },
  endGap(name: string) {
    if (perfOn) meter.endGap(name);
  },
};
