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
 * @param {{ following: () => boolean, onUnmount?: (key: string, el: HTMLElement) => void, threshold?: number,
 *   resize?: { observe: (el: Element) => void, unobserve: (el: Element) => void } }} opts
 *   resize: told of every element mounted and let go (createStick's ResizeObserver hears them grow).
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

  /** Elements the resize observer is told of. */
  const watched = new Set();
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
    if (opts.resize) {
      const now = new Set(want);
      for (const el of watched) if (!now.has(el)) { watched.delete(el); opts.resize.unobserve(el); }
      for (const el of want) if (!watched.has(el)) { watched.add(el); opts.resize.observe(el); }
    }
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
    let changed = reads ? measure() : false;
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
    const remounted = fresh || !sameRange(range, next) || range?.windowed !== next.windowed;
    if (remounted) mount(next);
    // 3. The rows just mounted, measured - but only when mount() could have changed anything. A
    // plain scroll within the same range mounts nothing new, so the boxes read here would be
    // exactly what step 1 just read: a second forced layout (getBoundingClientRect) for no new
    // information, on every scroll frame. (Profiled: 2.2 s of it in one fling pass.) Earlier this
    // measure was dropped unconditionally and that broke real remounts under load; gating it on
    // `remounted` keeps the case that mattered and only skips the case that was pure waste.
    if (reads && remounted && measure()) changed = true;
    if (reads && changed) setSpacers();
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

// ---- stick to the bottom ----------------------------------------------------------------------
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/app/src/agent-stream/strategy-web.tsx
// (scheduleStickToBottom, handleDomScroll and the upward-input evidence handlers), Copyright (c)
// 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain DOM, no React; the
// rows are observed one by one as window-view mounts them (the timeline has no content wrapper).
//
// Nothing is read or written per event. A ResizeObserver on the scroller and on every mounted row
// hears the content grow; while stuck, its callback (once a frame, before paint) sets scrollTop to
// the bottom. Without an observer, a caller's poke asks for one frame per burst instead.
// Only the reader's own intent detaches: an upward wheel, PageUp / ArrowUp / Home / Shift+Space
// outside a text field, a finger dragging the content down, or a press on the scrollbar, each
// counting when the scroll event that moves the view up comes within 100 ms of it (the scrollbar
// for as long as it is held). Content that shrinks and clamps scrollTop is not the reader, so it
// stays stuck. Scrolling back to within 1 px of the bottom sticks again.

const EVIDENCE_MS = 100;
const RESTICK_PX = 1;
const EPSILON = 1;
const SCROLLBAR_PX = 16;

/**
 * @param {HTMLElement} box the scroller
 * @param {{ onStick?: () => void, onChange?: (stuck: boolean) => void, onGrowDetached?: () => void, keys?: EventTarget | null }} [o]
 *   onStick: before each stick frame sets scrollTop (window-view's follow(), so the tail is mounted);
 *   onChange: stuck or not changed; onGrowDetached: the content grew while the reader was away;
 *   keys: where keydown is heard (the document by default).
 */
export function createStick(box, o = {}) {
  const b = /** @type {any} */ (box);
  const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const raf = typeof requestAnimationFrame === "function" ? (/** @type {() => void} */ f) => requestAnimationFrame(f) : (/** @type {() => void} */ f) => setTimeout(f, 16);
  const unraf = (/** @type {any} */ id) => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); clearTimeout(id); };
  const num = (/** @type {any} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  let stuck = true;
  let last = num(b.scrollTop) ?? 0;
  let evidenceUntil = 0;
  let scrollbar = /** @type {number|null} */ (null);
  let touchY = /** @type {number|null} */ (null);
  /** @type {any} */ let pending = null;
  /** Content height seen by the last frame without an observer (the fallback's growth check). */
  let seen = -1;

  const set = (/** @type {boolean} */ v) => {
    if (v === stuck) return;
    stuck = v;
    // Detached: without an observer, the next frames compare the height with this one.
    if (!v && !observer) seen = num(b.scrollHeight) ?? -1;
    o.onChange?.(v);
  };
  const distance = () => {
    const top = num(b.scrollTop), vp = num(b.clientHeight), h = num(b.scrollHeight);
    return top == null || vp == null || h == null ? 0 : h - vp - top;
  };
  const toEnd = () => { const h = num(b.scrollHeight); if (h != null && distance() > 0.5) b.scrollTop = h; last = num(b.scrollTop) ?? last; };

  function frame() {
    pending = null;
    if (!stuck) {
      if (!observer) { const h = num(b.scrollHeight); if (h != null && seen >= 0 && h > seen) o.onGrowDetached?.(); if (h != null) seen = h; }
      return;
    }
    o.onStick?.();
    toEnd();
    if (!observer) seen = num(b.scrollHeight) ?? seen;
  }
  /** Something may have grown: one frame, coalesced. */
  function poke() {
    if (pending) return;
    pending = raf(frame);
  }

  const observer = typeof ResizeObserver === "function"
    // A ResizeObserver runs after layout and before paint, once a frame: stick right there, so the
    // tail is never painted a frame late (a frame asked for from here would land on the next one).
    ? new ResizeObserver(() => { if (stuck) { o.onStick?.(); toEnd(); } else o.onGrowDetached?.(); })
    : null;
  observer?.observe(box);

  const mark = () => { evidenceUntil = clock() + EVIDENCE_MS; };
  const editable = (/** @type {any} */ t) => !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
  /** A nested scroller (a tool's output) that can still take the upward input itself. */
  const nestedTakes = (/** @type {any} */ t) => {
    for (let n = t; n && n !== box; n = n.parentNode) {
      if (!n.getBoundingClientRect || typeof getComputedStyle !== "function") return false;
      try {
        const y = getComputedStyle(n).overflowY;
        if ((y === "auto" || y === "scroll") && n.scrollHeight > n.clientHeight && n.scrollTop > 0) return true;
      } catch { return false; }
    }
    return false;
  };
  const onWheel = (/** @type {any} */ e) => { if (!e.ctrlKey && e.deltaY < 0 && !nestedTakes(e.target)) mark(); };
  const onKey = (/** @type {any} */ e) => {
    if (editable(e.target)) return;
    if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey)) { if (!nestedTakes(e.target)) mark(); }
  };
  const onPointerDown = (/** @type {any} */ e) => {
    scrollbar = null;
    if (e.pointerType && e.pointerType !== "mouse") return;
    if (e.button !== 0 || e.target !== box) return;
    const r = b.getBoundingClientRect?.();
    const w = Math.max((num(b.offsetWidth) ?? 0) - (num(b.clientWidth) ?? 0), SCROLLBAR_PX);
    if (r && e.clientX >= r.right - w) scrollbar = e.pointerId ?? 0;
  };
  const onPointerUp = (/** @type {any} */ e) => { if (scrollbar != null && (e.pointerId ?? 0) === scrollbar) scrollbar = null; };
  const onTouchStart = (/** @type {any} */ e) => { touchY = e.touches?.[0]?.clientY ?? null; };
  const onTouchMove = (/** @type {any} */ e) => {
    const y = e.touches?.[0]?.clientY;
    if (y == null) return;
    // The finger moves down: the content follows it, the view goes up.
    if (touchY != null && y > touchY + EPSILON && !nestedTakes(e.target)) mark();
    touchY = y;
  };
  const onTouchEnd = () => { touchY = null; };
  const onScroll = () => {
    const top = num(b.scrollTop);
    if (top == null) return;
    const up = top < last - EPSILON;
    const intent = scrollbar != null || clock() < evidenceUntil;
    if (stuck && up && intent) set(false);
    else if (!stuck && distance() <= RESTICK_PX) set(true);
    last = top;
  };

  const keys = o.keys !== undefined ? o.keys : (typeof document !== "undefined" ? document : null);
  const win = typeof window !== "undefined" && window.addEventListener ? window : null;
  /** @type {[any, string, (e: any) => void][]} */
  const wired = [[box, "scroll", onScroll], [box, "wheel", onWheel], [box, "pointerdown", onPointerDown], [box, "touchstart", onTouchStart],
    [box, "touchmove", onTouchMove], [box, "touchend", onTouchEnd], [box, "touchcancel", onTouchEnd], [keys, "keydown", onKey],
    [win, "pointerup", onPointerUp], [win, "pointercancel", onPointerUp]];
  for (const [t, name, f] of wired) try { t?.addEventListener(name, f, { passive: true }); } catch {}

  return {
    get stuck() { return stuck; },
    /** Whether a ResizeObserver hears growth; without one the caller pokes after a change. */
    observing: !!observer,
    /** Stuck again (Jump to latest, a sent message): to the bottom now. */
    stick() { set(true); evidenceUntil = 0; o.onStick?.(); toEnd(); },
    /** The view moved on purpose (a deep link): not stuck until the reader comes back down. */
    detach() { set(false); },
    poke,
    /** @param {Element} el */
    observe(el) { observer?.observe(el); },
    /** @param {Element} el */
    unobserve(el) { observer?.unobserve(el); },
    stop() {
      if (pending) unraf(pending);
      pending = null;
      observer?.disconnect();
      for (const [t, name, f] of wired) try { t?.removeEventListener(name, f); } catch {}
    },
  };
}
