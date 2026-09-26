// @ts-check
// Glass on the phone (board PhoneGlass; ADR 0005 decision 2). noVNC's own gesture handler already
// turns a tap into a left click, a long press into a right click and a two-finger drag into
// scrolling. This file adds the two things it does not do: pinch zooms the local view (a CSS
// transform, nothing is sent), and a keyboard button opens the soft keyboard through a hidden
// field read with beforeinput, since soft keyboards report keyCode 229 for every key.

import { h } from "../js/dom.js";
import { gicon } from "./util.js";
import { keysymFor } from "./input.js";

const XK = { BackSpace: 0xff08, Delete: 0xffff, Return: 0xff0d };

/**
 * Pinch to zoom the local view of the screen. Listens in the capture phase on `host`, so noVNC
 * never sees a pinch (it would send Ctrl+wheel to the remote). While zoomed, the positions of the
 * other gestures are mapped back so a tap lands where the finger is.
 * @param {HTMLElement} host the element around noVNC's canvas
 * @param {HTMLElement} view the element to scale
 * @param {(zoom: number) => void} [changed]
 */
export function pinchZoom(host, view, changed) {
  let z = 1, start = 1, mag = 0;
  const apply = () => {
    view.style.transform = z === 1 ? "" : `scale(${z})`;
    changed?.(z);
  };
  /** @param {any} e */
  const on = e => {
    const d = e.detail;
    if (!d) return;
    if (d.type === "pinch") {
      e.stopImmediatePropagation();
      const m = Math.hypot(d.magnitudeX, d.magnitudeY);
      if (e.type === "gesturestart") {
        start = z; mag = m || 1;
        const r = view.getBoundingClientRect();
        // The zoom grows from where the fingers are (in the unscaled view's own coordinates).
        view.style.transformOrigin = `${(d.clientX - r.left) / z}px ${(d.clientY - r.top) / z}px`;
      } else if (e.type === "gesturemove") {
        z = Math.min(4, Math.max(1, start * (m / mag)));
        if (z < 1.05) z = 1;
        apply();
      }
      return;
    }
    if (z !== 1) {
      const c = host.querySelector("canvas");
      if (!c) return;
      const r = c.getBoundingClientRect();
      d.clientX = r.left + (d.clientX - r.left) / z;
      d.clientY = r.top + (d.clientY - r.top) / z;
    }
  };
  for (const t of ["gesturestart", "gesturemove", "gestureend"]) host.addEventListener(t, on, true);
  return {
    reset() { z = 1; apply(); },
    detach() { for (const t of ["gesturestart", "gesturemove", "gestureend"]) host.removeEventListener(t, on, true); view.style.transform = ""; },
  };
}

/**
 * A keyboard button and the hidden field it focuses. Text typed on the soft keyboard is sent as
 * keysyms (0x1000000 + code point outside Latin-1); the field itself always stays empty.
 * @param {() => any} rfb the connected RFB while this surface holds the keyboard, else null
 */
export function softKeyboard(rfb) {
  const field = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "gl-softkb", "aria-label": "Type on the remote screen",
    autocapitalize: "off", autocomplete: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "send" }));
  const btn = h("button", { type: "button", class: "ibtn gl-kb-btn", "aria-label": "Keyboard", title: "Keyboard",
    onclick: () => { if (document.activeElement === field) field.blur(); else field.focus({ preventScroll: true }); } }, gicon("keyboard", 20));

  field.addEventListener("beforeinput", e => {
    const r = rfb();
    e.preventDefault();
    if (!r) return;
    const t = e.inputType;
    if (e.isComposing || t === "insertCompositionText") return;
    if (t === "insertText" || t === "insertReplacementText" || t === "insertFromPaste") {
      for (const ch of e.data || e.dataTransfer?.getData("text/plain") || "") { const k = keysymFor(ch); if (k) r.sendKey(k, null); }
    } else if (t === "insertLineBreak" || t === "insertParagraph") r.sendKey(XK.Return, "Enter");
    else if (t === "deleteContentBackward" || t === "deleteWordBackward") r.sendKey(XK.BackSpace, "Backspace");
    else if (t === "deleteContentForward") r.sendKey(XK.Delete, "Delete");
  });
  // Composition (IME, dead keys) arrives whole at the end; beforeinput above cannot cancel it.
  field.addEventListener("compositionend", e => {
    const r = rfb();
    if (r) for (const ch of e.data || "") { const k = keysymFor(ch); if (k) r.sendKey(k, null); }
    field.value = "";
  });
  field.addEventListener("input", () => { field.value = ""; });
  return { btn, field };
}
