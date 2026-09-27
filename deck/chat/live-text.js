// @ts-check
// A reply's text as one row that streams smoothly. Deltas arrive in lumps (the Switchboard
// coalesces partial text every 50 ms); painting each lump reads as jagged, so the row reveals at a
// steady display rate (core/pace.js) on requestAnimationFrame, and only while the page is on
// screen: hidden, it shows everything that arrived, a few times a second, with no frames at all.
//
// Only the growing part re-parses. Finished blocks are frozen: the text is scanned once, line by
// line as it arrives, for where a block ends (a blank line outside a code fence, or a fence's
// closing line), and each finished stretch is rendered once and appended; only the tail (the
// block being written) is rendered again on each frame, with the cursor inside its last
// paragraph. A code block is highlighted once, when it closes: while its fence is open the tail
// shows its lines as plain text. Once the text is done it is rendered whole, once, and the row is
// an ordinary reply.
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

/** A fence as lib/markdown.js reads one: its opening line (and language) and its closing line. */
const FENCE_OPEN = /^```[ \t]*(\S*)[ \t]*$/;
const isFenceClose = (/** @type {string} */ line) => line.trim() === "```";

/**
 * Where streaming markdown's blocks end, found once per line: scan() moves over the complete lines
 * added since the last call, so a long reply is scanned in linear time however often it is asked.
 * @typedef {{ pos: number, fence: boolean, lang: string, fenceStart: number, bodyStart: number, end: number }} Scan
 * @returns {Scan}
 */
export const newScan = () => ({ pos: 0, fence: false, lang: "", fenceStart: 0, bodyStart: 0, end: 0 });

/**
 * Move `st` over the complete lines of `s` it has not seen. `end` is where the finished blocks
 * end: after a blank line outside a fence, or after a fence's closing line.
 * @param {Scan} st @param {string} s
 */
export function scan(st, s) {
  for (;;) {
    const nl = s.indexOf("\n", st.pos);
    if (nl === -1) return st;
    const line = s.slice(st.pos, nl);
    if (st.fence) {
      if (isFenceClose(line)) { st.fence = false; st.end = nl + 1; }
    } else {
      const f = FENCE_OPEN.exec(line);
      if (f) { st.fence = true; st.lang = f[1] || ""; st.fenceStart = st.pos; st.bodyStart = nl + 1; }
      else if (line.trim() === "") st.end = nl + 1;
    }
    st.pos = nl + 1;
  }
}

/**
 * Where the settled part of streaming markdown ends: the last block end (a blank line or a
 * closing fence) outside a code fence, so an open fence never splits. Linear in the text.
 * @param {string} s
 */
export function settledEnd(s) {
  return scan(newScan(), s).end;
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
  /** The finished blocks (rendered once each, appended) and the block being written. */
  let top = /** @type {any} */ (null), tail = /** @type {any} */ (null);
  /** How much of the text is frozen into `top`, and the line scan that finds block ends. */
  let frozen = 0, st = newScan();
  /** @type {any} */ let raf = null, slow = null;

  const whole = () => {
    el.replaceChildren(); add(el, renderMarkdown(text)); drawn = text; top = tail = null; frozen = 0; st = newScan();
  };
  /** The first `n` characters: new finished blocks appended once, the tail every time. */
  const partial = (/** @type {number} */ n) => {
    const s = text.slice(0, n);
    if (!top || s.length < st.pos) {
      el.replaceChildren(); top = h("div", { class: "cv-md-part" }); tail = h("div", { class: "cv-md-part" }); el.append(top, tail);
      frozen = 0; st = newScan();
    }
    scan(st, s);
    if (st.end > frozen) { add(top, renderMarkdown(s.slice(frozen, st.end))); frozen = st.end; }
    tail.replaceChildren();
    if (st.fence) {
      // An open fence: what is above it as markdown, its lines as plain text until it closes.
      const before = s.slice(frozen, st.fenceStart);
      if (before.trim()) add(tail, renderMarkdown(before));
      const code = h("code", { class: "lang-" + (st.lang || "text") }, s.slice(Math.min(st.bodyStart, s.length)));
      code.append(h("span", { class: "msg-cursor" }));
      tail.append(h("pre", { class: "cv-open-fence" }, code));
    } else {
      add(tail, renderMarkdown(s.slice(frozen)));
      const last = tail.lastElementChild && /^(P|LI|H\d)$/.test(tail.lastElementChild.tagName) ? tail.lastElementChild : tail;
      last.append(h("span", { class: "msg-cursor" }));
    }
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
    const was = text;
    text = String(it.text ?? "");
    // Not the same text grown (a re-read replaced it): the frozen blocks are not its blocks.
    if (top && !text.startsWith(was.slice(0, frozen))) { top = null; }
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
