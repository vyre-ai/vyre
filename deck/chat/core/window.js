// @ts-check
// Windowed rendering for long sessions: the pure part. A session of 2,000 turns is about 14,000
// rows; mounting them all costs memory and every layout pass. Above THRESHOLD rows only the rows
// within the viewport plus a margin are mounted, and each unmounted stretch is one spacer as tall
// as the rows it stands for.
//
// Heights: every row's slot (its height plus the gap after it) is kept by key. A row never
// measured is estimated (by kind when the caller says, else a flat estimate) and replaced by its
// measurement once it is mounted. Offsets are prefix sums over slots, in the model's coordinates:
// 0 is the top of the first windowed row.
//
// Anchoring: a view that is detached (reading history) keeps its reading position exactly across
// any change: rows loaded above, estimates replaced by measurements, rows mounted or unmounted.
// captureAnchor() names the row at the top of the viewport and how far into it the viewport
// starts; restoreAnchor() gives the scroll position that puts that row there again, from the new
// offsets. A view stuck at the bottom has no anchor: it follows the tail (tailScroll()).
//
// Shared core: no DOM and no Node APIs. The DOM glue is deck/chat/window-view.js.

/** At or below this many rows everything is mounted. */
export const THRESHOLD = 100;
/** Mounted rows are capped, whatever the viewport and margin allow. */
export const MAX_MOUNTED = 120;
/** How far past the viewport, above and below, rows stay mounted (px). */
export const MARGIN = 800;
/** A row not measured yet. */
export const ESTIMATE = 56;
/** Within this of the bottom counts as at the bottom (px). */
export const STICKY_SLACK = 40;

/**
 * @typedef {{
 *   get(key: string, kind?: string): number,
 *   set(key: string, px: number): number,
 *   measured(key: string): boolean,
 *   prune(keep: Iterable<string>): void,
 *   readonly size: number,
 * }} Heights
 */

/**
 * A height cache. `estimates` gives a first guess per kind (a day rule is short, a tool run is a
 * line, a reply is a paragraph); anything else is `estimate`.
 * @param {{ estimate?: number, estimates?: Record<string, number> }} [opts]
 * @returns {Heights}
 */
export function createHeights({ estimate = ESTIMATE, estimates = {} } = {}) {
  /** @type {Map<string, number>} */
  const known = new Map();
  return {
    get(key, kind) {
      const v = known.get(key);
      if (v !== undefined) return v;
      return kind && estimates[kind] !== undefined ? estimates[kind] : estimate;
    },
    /** Returns how much the slot changed (0 for the same height). */
    set(key, px) {
      if (!(px >= 0) || !isFinite(px)) return 0;
      const was = known.get(key);
      known.set(key, px);
      return was === undefined ? 0 : px - was;
    },
    measured: key => known.has(key),
    prune(keep) {
      const k = new Set(keep);
      for (const key of known.keys()) if (!k.has(key)) known.delete(key);
    },
    get size() { return known.size; },
  };
}

/**
 * Prefix sums of the rows' slots: offs[i] is the top of row i, offs[n] the total.
 * @param {readonly string[]} keys @param {Heights} heights @param {readonly (string|undefined)[]} [kinds]
 * @returns {Float64Array}
 */
export function offsets(keys, heights, kinds) {
  const offs = new Float64Array(keys.length + 1);
  for (let i = 0; i < keys.length; i++) offs[i + 1] = offs[i] + heights.get(keys[i], kinds?.[i]);
  return offs;
}

/**
 * The row that holds `y` (the last row whose top is at or above it), clamped to the rows.
 * @param {Float64Array} offs @param {number} y
 */
export function indexAt(offs, y) {
  const n = offs.length - 1;
  if (n <= 0) return 0;
  if (y <= 0) return 0;
  if (y >= offs[n]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Which rows to mount: [start, end). At or below `threshold` rows, all of them. Else the rows that
 * meet [scrollTop - margin, scrollTop + viewport + margin], at most `max`, kept around the
 * viewport (the rows on screen are never the ones cut).
 * @param {{ offs: Float64Array, scrollTop: number, viewport: number, margin?: number, threshold?: number, max?: number }} o
 * @returns {{ start: number, end: number, windowed: boolean }}
 */
export function windowRange({ offs, scrollTop, viewport, margin = MARGIN, threshold = THRESHOLD, max = MAX_MOUNTED }) {
  const n = offs.length - 1;
  if (n <= threshold) return { start: 0, end: n, windowed: false };
  const view = Math.max(0, viewport || 0);
  const top = Math.max(0, Math.min(scrollTop || 0, Math.max(0, offs[n] - view)));
  let start = indexAt(offs, top - margin);
  let end = Math.min(n, indexAt(offs, top + view + margin) + 1);
  if (end - start > max) {
    // Keep the rows on screen, then share what is left between above and below.
    const a = indexAt(offs, top), b = Math.min(n, indexAt(offs, top + view) + 1);
    const seen = b - a;
    if (seen >= max) { start = a; end = a + max; }
    else {
      const spare = max - seen;
      let up = Math.min(a - start, Math.floor(spare / 2));
      const down = Math.min(end - b, spare - up);
      up = Math.min(a - start, spare - down);
      start = a - up; end = b + down;
    }
  }
  return { start, end, windowed: true };
}

/**
 * The scroll position of the bottom: the whole height less the viewport.
 * @param {Float64Array} offs @param {number} viewport
 */
export function tailScroll(offs, viewport) {
  return Math.max(0, offs[offs.length - 1] - Math.max(0, viewport || 0));
}

/**
 * The scroll position that shows row `index` (align "center", "start" or "end").
 * @param {Float64Array} offs @param {number} index @param {number} viewport @param {"center"|"start"|"end"} [align]
 */
export function scrollFor(offs, index, viewport, align = "center") {
  const n = offs.length - 1;
  if (n <= 0) return 0;
  const i = Math.max(0, Math.min(n - 1, index));
  const top = offs[i], h = offs[i + 1] - offs[i];
  const y = align === "start" ? top : align === "end" ? top + h - viewport : top + h / 2 - viewport / 2;
  return Math.max(0, Math.min(y, tailScroll(offs, viewport)));
}

/** The spacers around a mounted range: the rows above `start` and below `end`, as heights. @param {Float64Array} offs @param {number} start @param {number} end */
export function spacers(offs, start, end) {
  const n = offs.length - 1;
  return { top: offs[Math.max(0, Math.min(start, n))], bottom: offs[n] - offs[Math.max(0, Math.min(end, n))] };
}

/**
 * The row at the top of the viewport and how far into it the viewport starts.
 * @param {readonly string[]} keys @param {Float64Array} offs @param {number} scrollTop
 * @returns {{ key: string, into: number } | null}
 */
export function captureAnchor(keys, offs, scrollTop) {
  if (!keys.length) return null;
  const i = indexAt(offs, scrollTop);
  return { key: keys[i], into: scrollTop - offs[i] };
}

/**
 * The scroll position that puts the anchored row back where it was, or null when it is gone.
 * `index` finds a key's row (a Map from key to index, built once per layout).
 * @param {{ key: string, into: number } | null} anchor @param {Map<string, number>} index @param {Float64Array} offs
 */
export function restoreAnchor(anchor, index, offs) {
  if (!anchor) return null;
  const i = index.get(anchor.key);
  if (i === undefined) return null;
  return Math.max(0, offs[i] + anchor.into);
}

/** At the bottom, or within STICKY_SLACK of it. @param {number} scrollTop @param {number} viewport @param {number} height @param {number} [slack] */
export const isAtBottom = (scrollTop, viewport, height, slack = STICKY_SLACK) => scrollTop + viewport >= height - slack;

/** Two ranges mount the same rows. @param {{ start: number, end: number } | null} a @param {{ start: number, end: number } | null} b */
export const sameRange = (a, b) => !!a && !!b && a.start === b.start && a.end === b.end;

/**
 * The range that mounts row `index` first (a deep link from Needs), centred when it can be.
 * @param {Float64Array} offs @param {number} index @param {number} viewport @param {{ margin?: number, threshold?: number, max?: number }} [o]
 */
export function rangeAround(offs, index, viewport, o = {}) {
  const scrollTop = scrollFor(offs, index, viewport);
  const r = windowRange({ offs, scrollTop, viewport, ...o });
  if (index < r.start) return { ...r, start: index, scrollTop };
  if (index >= r.end) return { ...r, end: index + 1, scrollTop };
  return { ...r, scrollTop };
}
