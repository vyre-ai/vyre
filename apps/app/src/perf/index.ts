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

// After the paint: a task posted from a frame callback runs once that frame has painted, which
// is nearer the paint than the next frame's callback. One channel, one queue.
const later: ((t: number) => void)[] = [];
let channel: MessageChannel | null = null;
function post(f: (t: number) => void) {
  later.push(f);
  if (later.length > 1) return;
  if (!channel && typeof MessageChannel === "function") {
    channel = new MessageChannel();
    channel.port1.onmessage = run;
  }
  if (channel) channel.port2.postMessage(0);
  else setTimeout(run, 0);
}
function run() {
  const t = now();
  for (const f of later.splice(0)) f(t);
}

/**
 * Called from a frame callback (the session store's frame): `f` runs with the time just after
 * this frame painted what the callback changed. Nothing when the meter is off.
 */
export function thisPaint(f: (t: number) => void): void {
  if (perfOn) post(f);
}

/** From an event handler (a key, a tap): `f` runs with the time just after the next paint. Nothing when the meter is off. */
export function nextPaint(f: (t: number) => void): void {
  if (!perfOn) return;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => post(f));
  else setTimeout(() => post(f), 16);
}

/** A session was asked for (a tap in Chats or Needs): open.session.* is measured from here. */
let opening: number | null = null;
export function sessionOpening(): void {
  if (perfOn) opening = now();
}
/** The time a session open started: the tap, when it was within the last 2 s, else now. */
export function takeOpening(): number {
  const t = now();
  const o = opening;
  opening = null;
  return o !== null && t - o < 2000 ? o : t;
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
