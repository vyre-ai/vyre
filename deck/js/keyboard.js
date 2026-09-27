// @ts-check
// The phone's keyboard (docs/design/one-app/DIRECTION.md, "The keyboard"). iOS shrinks the visual
// viewport when the keyboard opens and leaves the layout alone, so a fixed shell would keep the
// composer under the keys. One visualViewport listener, attached only while a text field has
// focus on a phone, sets --kb on <html> (the keyboard's inset in px) and data-kb while it is up.
// CSS moves the Chat composer and a sheet up by it; "deck:kb" on window ({ kb, delta }) lets the
// transcript keep its last line in view in the same frame. Passive, one write per frame, no timer.
//
//   watchKeyboard()   once, from pwa.start()
//   kbInset(h, vv)    the pure math, for tests

/**
 * The keyboard's inset: what the visual viewport lost at the bottom of the layout viewport.
 * 0 when there is no visualViewport or the page is pinch zoomed (the height then says the zoom).
 * @param {number} innerHeight @param {{ height: number, offsetTop: number, scale?: number } | null | undefined} vv
 */
export function kbInset(innerHeight, vv) {
  if (!vv || (vv.scale && vv.scale > 1.01)) return 0;
  return Math.max(0, Math.floor(innerHeight - vv.height - vv.offsetTop));
}

const NOT_TYPED = /^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/i;
/** A field the keyboard types into. @param {any} el */
export function typesText(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return !NOT_TYPED.test(el.type || "text");
  return !!el.isContentEditable;
}

/** @param {any} [win] */
export function watchKeyboard(win = window) {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const doc = win.document, root = doc.documentElement;
  const phone = () => win.matchMedia?.("(max-width: 760px)").matches;
  let kb = 0, frame = 0, on = false;

  const apply = () => {
    frame = 0;
    const el = doc.activeElement;
    const typing = typesText(el);
    // iOS pans the whole page to bring a focused field into view. The shell is fixed, so take the
    // pan back: --kb lifts the field instead, and the header stays where it was.
    if (typing && (win.scrollY || 0) > 0) win.scrollTo(0, 0);
    const next = kbInset(win.innerHeight, vv);
    if (next !== kb) {
      const delta = next - kb;
      kb = next;
      root.style.setProperty("--kb", kb + "px");
      if (kb) root.setAttribute("data-kb", ""); else root.removeAttribute("data-kb");
      win.dispatchEvent(new win.CustomEvent("deck:kb", { detail: { kb, delta } }));
      if (typing && kb) reveal(el);
    }
    if (!kb && !typing) stop();
  };
  const queue = () => { if (!frame) frame = win.requestAnimationFrame(apply); };

  /** A field in a scroller that now sits under the keyboard: scroll that scroller, never the page. */
  const reveal = (/** @type {any} */ el) => {
    const sc = el.closest?.(".sheet-body, .thread-view, .page");
    if (!sc || el.closest(".composer")) return;
    const r = el.getBoundingClientRect(), box = sc.getBoundingClientRect();
    // In a session the lifted composer covers the transcript's foot; its top is the edge.
    const composer = sc.closest(".chat-session")?.querySelector(":scope > .composer");
    const edge = Math.min(box.bottom, win.innerHeight - kb, composer ? composer.getBoundingClientRect().top : Infinity);
    const over = r.bottom + 16 - edge;
    if (over > 0) sc.scrollTop += over;
  };

  const start = () => {
    if (on) return;
    on = true;
    vv.addEventListener("resize", queue, { passive: true });
    vv.addEventListener("scroll", queue, { passive: true });
  };
  const stop = () => {
    if (!on) return;
    on = false;
    vv.removeEventListener("resize", queue);
    vv.removeEventListener("scroll", queue);
  };
  const focusIn = (/** @type {Event} */ e) => { if (typesText(e.target) && phone()) { start(); queue(); } };
  // Focus leaving a field: one more look once the keyboard has gone (or moved to the next field).
  const focusOut = () => { if (on) queue(); };
  doc.addEventListener("focusin", focusIn, { passive: true });
  doc.addEventListener("focusout", focusOut, { passive: true });
  return () => {
    stop();
    doc.removeEventListener("focusin", focusIn);
    doc.removeEventListener("focusout", focusOut);
    if (frame) win.cancelAnimationFrame(frame);
  };
}
