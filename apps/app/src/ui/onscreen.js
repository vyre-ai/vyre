// Whether a box is on screen: a pure helper for useOnScreen (the Glass card fetches no still while
// it is scrolled out of view, glass-mini.md). Node tests import it.

/**
 * A box of `height` at `top` overlaps the view from `viewTop` to `viewBottom` (window px). A box
 * not laid out yet (height 0) is not on screen.
 * @param {number} top @param {number} height @param {number} viewTop @param {number} viewBottom
 * @returns {boolean}
 */
export function overlaps(top, height, viewTop, viewBottom) {
  if (!(height > 0) || !Number.isFinite(top)) return false;
  return top < viewBottom && top + height > viewTop;
}

/**
 * One channel a scroller calls on each scroll, and the cards below it listen to: no React state,
 * so a scroll re-renders nothing by itself.
 * @returns {{ emit(): void, on(f: () => void): () => void }}
 */
export function createScrollSignal() {
  /** @type {Set<() => void>} */
  const fs = new Set();
  return {
    emit() {
      for (const f of fs) f();
    },
    on(f) {
      fs.add(f);
      return () => void fs.delete(f);
    },
  };
}
