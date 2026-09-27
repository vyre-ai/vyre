// @ts-check
// Windowed rendering for the session view: the DOM glue over core/window.js.
//
// The view hands over its rows in order, each as a key, a kind and a way to make its element; this
// puts the fixed head elements first, then, above THRESHOLD rows, a top spacer, the rows within
// the viewport plus a margin, and a bottom spacer. A row's element is made only when it is
// mounted; a row that leaves the window is handed back (onUnmount) so the view can let it go.
//
// Heights are measured from the rows' boxes (the distance from a row's top to the next one's, so
// gaps and margins count) and cached by key; a row not mounted yet is estimated. The bottom anchor
// is kept exactly: stuck to the bottom, the tail is mounted and the view scrolls with it; detached
// (reading history), the row at the top of the viewport stays where it is across every change
// (history loaded above, estimates replaced by measurements, rows mounted and unmounted), by
// setting scrollTop from the new offsets. Safari has no overflow-anchor, so this is done by hand
// everywhere, and the browser's own anchoring is turned off while windowed (chat.css).
//
// Only what changed is touched: the spacers' heights are written when they change, and the rows
// are moved in place (reconcile), so a streaming reply at the tail touches only its own row.

import {
  THRESHOLD, createHeights, offsets, windowRange, rangeAround, spacers, captureAnchor, restoreAnchor, tailScroll, sameRange,
} from "./core/window.js";

/** First guesses by kind, so a long session's scrollbar is near right before anything is measured. */
const ESTIMATES = { day: 30, head: 30, user: 64, text: 96, reasoning: 36, run: 36, tool: 44, turn: 26, notice: 32, ask: 160, gate: 140, fact: 110 };
/** When nothing says how tall the viewport is (a test's DOM). */
const VIEWPORT = 800;

/**
 * @typedef {{ key: string, kind?: string, make: () => HTMLElement }} Row
 */

/**
 * @param {HTMLElement} box the scroller the rows go in
 * @param {{ following: () => boolean, onUnmount?: (key: string, el: HTMLElement) => void, threshold?: number }} opts
 */
export function createWindowView(box, opts) {
  const threshold = opts.threshold ?? THRESHOLD;
  const heights = createHeights({ estimates: ESTIMATES });
  const top = /** @type {HTMLElement} */ (document.createElement("div"));
  const bottom = /** @type {HTMLElement} */ (document.createElement("div"));
  top.setAttribute("class", "cv-spacer"); top.setAttribute("aria-hidden", "true");
  bottom.setAttribute("class", "cv-spacer"); bottom.setAttribute("aria-hidden", "true");
  /** What is laid out now. */
  let head = /** @type {HTMLElement[]} */ ([]);
  let rows = /** @type {Row[]} */ ([]);
  let keys = /** @type {string[]} */ ([]);
  let kinds = /** @type {(string|undefined)[]} */ ([]);
  let index = new Map();
  let offs = new Float64Array(1);
  let range = /** @type {{ start: number, end: number, windowed: boolean } | null} */ (null);
  /** Mounted rows by key. */
  const mounted = new Map();
  const spacerPx = { top: -1, bottom: -1 };
  /** A row to mount whatever the scroll position says (a deep link), until the reader scrolls. */
  let pin = /** @type {string|null} */ (null);

  const rect = (/** @type {any} */ el) => (typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null);
  const viewport = () => { const v = /** @type {any} */ (box).clientHeight; return typeof v === "number" && v > 0 ? v : VIEWPORT; };
  const scrollTop = () => { const v = /** @type {any} */ (box).scrollTop; return typeof v === "number" ? v : 0; };
  /** Where a mounted element starts in the scroller's content. */
  function contentY(el) {
    const a = rect(el), b = rect(box);
    return a && b ? a.top - b.top + scrollTop() : null;
  }
  /** Where model offset 0 is in the scroller's content: from the first mounted row. */
  function origin() {
    if (!range || range.end <= range.start) return 0;
    const el = mounted.get(keys[range.start]);
    const y = el ? contentY(el) : null;
    return y == null ? 0 : y - offs[range.start];
  }

  /** Measure the mounted rows' slots. True when any changed. */
  function measure() {
    if (!range || range.end <= range.start) return false;
    let changed = false, prevTop = null;
    for (let i = range.end - 1; i >= range.start; i--) {
      const el = mounted.get(keys[i]);
      if (!el) { prevTop = null; continue; }
      const r = rect(el);
      if (!r) return false;
      // The next element's top: the next row, or the bottom spacer (or the row's own height when last).
      let next = prevTop;
      if (next == null) { const nb = i === range.end - 1 && range.windowed ? rect(bottom) : null; next = nb ? nb.top : r.top + r.height; }
      const slot = next - r.top;
      if (slot >= 0 && Math.abs(heights.get(keys[i], kinds[i]) - slot) >= 0.5) { heights.set(keys[i], slot); changed = true; }
      else if (!heights.measured(keys[i]) && slot >= 0) heights.set(keys[i], slot);
      prevTop = r.top;
    }
    if (changed) offs = offsets(keys, heights, kinds);
    return changed;
  }

  function setSpacers() {
    if (!range) return;
    const s = spacers(offs, range.start, range.end);
    if (s.top !== spacerPx.top) { spacerPx.top = s.top; top.style.height = s.top + "px"; }
    if (s.bottom !== spacerPx.bottom) { spacerPx.bottom = s.bottom; bottom.style.height = s.bottom + "px"; }
  }

  /** Put `want` in the box in that order, moving only what is out of place; anything else goes. */
  function reconcile(want) {
    let cur = box.firstChild;
    for (const el of want) {
      if (cur === el) { cur = /** @type {any} */ (cur).nextSibling; continue; }
      box.insertBefore(el, cur);
    }
    while (cur) { const n = /** @type {any} */ (cur).nextSibling; cur.remove(); cur = n; }
  }

  /** Mount `next`: make what is new, hand back what left, lay out. */
  function mount(next) {
    const want = [...head];
    const keep = new Set();
    if (next.windowed) want.push(top);
    for (let i = next.start; i < next.end; i++) {
      const r = rows[i];
      const el = r.make();
      mounted.set(r.key, el);
      keep.add(r.key);
      want.push(el);
    }
    if (next.windowed) want.push(bottom);
    for (const [k, el] of [...mounted]) if (!keep.has(k)) { mounted.delete(k); opts.onUnmount?.(k, el); }
    range = next;
    box.classList?.toggle("cv-windowed", next.windowed);
    reconcile(want);
    if (next.windowed) setSpacers(); else { spacerPx.top = spacerPx.bottom = -1; }
  }

  /**
   * Lay out again: after new rows (set) or a scroll (pass). The reading position is kept: the tail
   * when following, else the row at the top of the viewport.
   * @param {boolean} fresh the rows changed, so every mounted row is made again (refreshed)
   */
  function update(fresh) {
    const follow = opts.following();
    // A short session stuck to the bottom has nothing to window or keep: no layout reads at all.
    const reads = !follow || !!range?.windowed || rows.length > threshold;
    // 1. What is on screen now, in the old model, measured.
    if (reads) measure();
    const o0 = reads ? origin() : 0;
    const anchor = follow ? null : captureAnchor(keys, offs, scrollTop() - o0);
    // 2. The new model.
    if (fresh) {
      keys = rows.map(r => r.key); kinds = rows.map(r => r.kind); index = new Map(keys.map((k, i) => [k, i]));
      if (heights.size > 2 * keys.length + 200) heights.prune(keys);
      offs = offsets(keys, heights, kinds);
    }
    const vp = viewport();
    const at = pin != null && index.has(pin) ? index.get(pin) : null;
    const y = follow ? tailScroll(offs, vp) : (restoreAnchor(anchor, index, offs) ?? scrollTop() - o0);
    const next = at != null ? rangeAround(offs, /** @type {number} */ (at), vp, { threshold }) : windowRange({ offs, scrollTop: y, viewport: vp, threshold });
    if (fresh || !sameRange(range, next) || range?.windowed !== next.windowed) mount(next);
    // 3. The rows just mounted, measured; the spacers from the new heights; the position kept.
    if (reads && measure()) setSpacers();
    if (at != null || !reads) return;
    if (follow) {
      // Stuck to the bottom: stay there through whatever was measured.
      const b = /** @type {any} */ (box);
      if (typeof b.scrollHeight === "number" && b.scrollTop + viewport() < b.scrollHeight - 0.5) b.scrollTop = b.scrollHeight;
      return;
    }
    if (anchor) {
      const want = restoreAnchor(anchor, index, offs);
      if (want != null) {
        const target = origin() + want;
        if (Math.abs(target - scrollTop()) >= 1) /** @type {any} */ (box).scrollTop = target;
      }
    }
  }

  let queued = /** @type {any} */ (null);
  const frame = typeof requestAnimationFrame === "function" ? (/** @type {() => void} */ f) => requestAnimationFrame(f) : (/** @type {() => void} */ f) => setTimeout(f, 16);

  return {
    /**
     * The rows, in order, with the head elements that always come first.
     * @param {HTMLElement[]} h @param {Row[]} list
     */
    set(h, list) {
      head = h; rows = list;
      update(true);
    },
    /** A scroll or resize: at most once a frame. A scroll by the reader lets a deep link's pin go. */
    schedule(/** @type {boolean} */ byReader = false) {
      if (byReader) pin = null;
      if (queued) return;
      queued = frame(() => { queued = null; if (rows.length > threshold || range?.windowed) update(false); });
    },
    /** Now, not on the next frame. */
    pass() { update(false); },
    /**
     * The row at the top of the viewport now, for a change that also moves what sits above the
     * rows (the Load earlier line going away): restore(anchor) after it puts that row back.
     */
    anchor() {
      if (opts.following()) return null;
      measure();
      return captureAnchor(keys, offs, scrollTop() - origin());
    },
    /** @param {{ key: string, into: number } | null} a */
    restore(a) {
      if (!a || opts.following()) return;
      const want = restoreAnchor(a, index, offs);
      if (want == null) return;
      const target = origin() + want;
      if (Math.abs(target - scrollTop()) >= 1) /** @type {any} */ (box).scrollTop = target;
    },
    /** Mount the row for `key` and the rows around it (a deep link); its element, or null. @param {string} key */
    reveal(key) {
      if (!index.has(key)) return null;
      pin = key;
      update(false);
      return mounted.get(key) || null;
    },
    /** Following again: the tail mounted (the caller scrolls). */
    follow() {
      const pinned = pin != null;
      pin = null;
      // Already holding the tail (a reply growing at the bottom): nothing to mount, nothing to touch.
      if (range?.windowed && (pinned || range.end < rows.length)) update(false);
    },
    /** The element for a row key when it is mounted. @param {string} key */
    element: key => mounted.get(key) || null,
    /** How many rows are mounted, and how many there are. */
    get count() { return { mounted: mounted.size, rows: rows.length, windowed: !!range?.windowed }; },
    stop() { if (queued) { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(queued); clearTimeout(queued); queued = null; } },
  };
}
