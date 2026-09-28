// @ts-check
// Tap-to-zoom (cohesion item 18): one overlay, shared by every picture in Chat (a step's screen, the
// person's own pasted image), mounted once per page and reused. Esc or a tap on the backdrop closes
// it; it never traps focus outside itself, and it is inert (no picture, no listeners) until opened.

import { h, put } from "../js/dom.js";
import { icon } from "../js/icons.js";

/** @type {{ root: HTMLElement, img: HTMLElement, cap: HTMLElement, opener: HTMLElement|null }|null} */
let box = null;

function ensure() {
  if (box) return box;
  const img = h("img", { class: "lightbox-img", alt: "" });
  const cap = h("div", { class: "lightbox-cap" });
  const root = h("div", { class: "lightbox", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Picture",
    onclick: (/** @type {MouseEvent} */ e) => { if (e.target === root) close(); } },
    h("button", { class: "ibtn lightbox-close", type: "button", "aria-label": "Close", onclick: () => close() }, icon("close", 18)),
    img, cap);
  document.addEventListener("keydown", e => { if (!root.hidden && e.key === "Escape") { e.preventDefault(); close(); } });
  put(document.body, root);
  box = { root, img, cap, opener: null };
  return box;
}

/**
 * Open a picture full size. `alt`/`caption` describe it (a step's target, a file's name); the
 * opener regains focus on close, so a keyboard tap-to-zoom never strands the person.
 * @param {string} src @param {{ alt?: string, caption?: string }} [o]
 */
export function openLightbox(src, o = {}) {
  const b = ensure();
  b.opener = /** @type {HTMLElement|null} */ (document.activeElement);
  b.img.setAttribute("src", src);
  b.img.setAttribute("alt", o.alt || "");
  put(b.cap, o.caption || "");
  b.cap.hidden = !o.caption;
  b.root.hidden = false;
  /** @type {any} */ (b.root.querySelector(".lightbox-close"))?.focus();
}

export function close() {
  if (!box || box.root.hidden) return;
  box.root.hidden = true;
  box.img.removeAttribute("src");
  box.opener?.focus?.();
  box.opener = null;
}

/** Test-only: drop the singleton so a fresh document gets a fresh overlay. */
export function _reset() { box = null; }
