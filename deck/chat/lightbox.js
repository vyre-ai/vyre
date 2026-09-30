// @ts-check
// Tap-to-zoom (cohesion item 18): one overlay, shared by every picture in Chat (a step's screen, the
// person's own pasted image), mounted once per page and reused. Esc or a tap on the backdrop closes
// it, Tab is trapped to its one focusable control (aria-modal="true" means the rest of the page is
// inert to Tab while open - app-design's review), and it is inert (no picture, no listeners) until
// opened.

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
  document.addEventListener("keydown", e => {
    if (root.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    // aria-modal="true" promises Tab never leaves this dialog. Just one control today (Close),
    // found by query rather than hardcoded so a later addition (a download button, say) is caught
    // too.
    const focusable = /** @type {HTMLElement[]} */ ([...root.querySelectorAll("button")]);
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey ? document.activeElement === first : document.activeElement === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (!focusable.includes(/** @type {any} */ (document.activeElement))) { e.preventDefault(); first.focus(); }
  });
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
