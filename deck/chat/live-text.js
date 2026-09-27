// @ts-check
// A reply's text as one row that streams smoothly. Deltas arrive in lumps (the Switchboard
// coalesces partial text every 50 ms); painting each lump reads as jagged, so the row reveals at a
// steady display rate (core/pace.js) on requestAnimationFrame, and only while the page is on
// screen: hidden, it shows everything that arrived, a few times a second, with no frames at all.
//
// Only the growing part re-parses. The text is split at its last paragraph break outside a code
// fence: the settled part above it is rendered once per break, the tail (the paragraph being
// written) on each frame, with the cursor inside its last paragraph. Once the text is done it is
// rendered whole, once, and the row is an ordinary reply.
//
// Nothing here uses innerHTML: lib/markdown.js builds text nodes.

import { h, add } from "../js/dom.js";
import { renderMarkdown } from "./lib/markdown.js";
import { createPacer } from "./core/pace.js";

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const frame = typeof requestAnimationFrame === "function"
  ? (/** @type {() => void} */ f) => requestAnimationFrame(() => f())
  : (/** @type {() => void} */ f) => setTimeout(f, 16);
const unframe = (/** @type {any} */ id) => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); clearTimeout(id); };
/** While hidden: at most this often, and everything that arrived. */
const HIDDEN_MS = 250;

/**
 * Where the settled part of streaming markdown ends: the last blank line with an even number of
 * code fences above it, so an open fence never splits.
 * @param {string} s
 */
export function settledEnd(s) {
  let i = s.lastIndexOf("\n\n");
  while (i > 0) {
    const fences = (s.slice(0, i).match(/^\s*(```|~~~)/gm) || []).length;
    if (fences % 2 === 0) return i + 2;
    i = s.lastIndexOf("\n\n", i - 1);
  }
  return 0;
}

/**
 * @param {number|undefined} ts
 * @param {{ visible: () => boolean, onGrow?: () => void }} env visible: the page and this view are on screen; onGrow: a frame changed the height
 * @returns {HTMLElement & { sync: (item: { text: string, streaming: boolean }) => void, stop: () => void }}
 */
export function textItemRow(ts, env) {
  const el = /** @type {any} */ (h("div", { class: "cv-row cv-text msg-text" }));
  el._kind = "assistant"; el._ts = ts ?? null;
  /** @type {import("./core/pace.js").Pacer|null} */ let pacer = null;
  let text = "", drawn = /** @type {string|null} */ (null);
  /** Shown while hidden: the reveal never goes back below it. */
  let floor = 0;
  let settled = "", top = /** @type {any} */ (null), tail = /** @type {any} */ (null);
  /** @type {any} */ let raf = null, slow = null;

  const whole = () => {
    el.replaceChildren(); add(el, renderMarkdown(text)); drawn = text; top = tail = null; settled = "";
  };
  /** The first `n` characters, the settled part only when its break moved, the tail every time. */
  const partial = (/** @type {number} */ n) => {
    const s = text.slice(0, n);
    if (!top) { el.replaceChildren(); top = h("div", { class: "cv-md-part" }); tail = h("div", { class: "cv-md-part" }); el.append(top, tail); settled = ""; }
    const cut = settledEnd(s);
    if (s.slice(0, cut) !== settled) { settled = s.slice(0, cut); top.replaceChildren(); add(top, renderMarkdown(settled)); }
    tail.replaceChildren(); add(tail, renderMarkdown(s.slice(cut)));
    const last = tail.lastElementChild && /^(P|LI|H\d)$/.test(tail.lastElementChild.tagName) ? tail.lastElementChild : tail;
    last.append(h("span", { class: "msg-cursor" }));
    drawn = null;
  };
  const tick = () => {
    raf = null;
    if (!pacer) return;
    if (!env.visible()) { hiddenDraw(); return; }
    const t = now();
    const n = Math.min(text.length, Math.max(pacer.visible(t), floor));
    partial(n);
    env.onGrow?.();
    if (n < text.length) raf = frame(tick);
  };
  const hiddenDraw = () => {
    if (slow) return;
    slow = setTimeout(() => { slow = null; if (!pacer) return; if (env.visible()) { kick(); return; } floor = text.length; partial(floor); }, HIDDEN_MS);
  };
  const kick = () => { if (!raf) raf = frame(tick); };

  el.sync = it => {
    text = String(it.text ?? "");
    if (it.streaming) {
      if (!pacer) { pacer = createPacer(); floor = 0; el.classList.add("cv-live"); partial(0); }
      pacer.push(text.length, now());
      if (env.visible()) kick(); else hiddenDraw();
      return;
    }
    if (pacer) { pacer.done(); pacer = null; el.classList.remove("cv-live"); }
    if (raf) { unframe(raf); raf = null; }
    if (slow) { clearTimeout(slow); slow = null; }
    if (drawn !== text) whole();
  };
  /** Back on screen: catch up at the display rate from what is shown. */
  el.kick = () => { if (pacer) kick(); };
  el.stop = () => { if (raf) unframe(raf); if (slow) clearTimeout(slow); raf = slow = null; };
  return el;
}
