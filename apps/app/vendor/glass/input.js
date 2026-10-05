// @ts-check
// Input rules for a take-over (ADR 0005, decision 2), layered over noVNC's own handlers. Nothing
// here runs unless this surface holds the keyboard; the relay drops input from anyone else anyway.
//
//  - on a Mac, Cmd+letter goes as Ctrl+letter (the container is Linux) and Cmd alone is not sent;
//  - Ctrl+Enter hands back;
//  - paste is typed as keysyms, capped at 4 KB and paced (ClientCutText stays off);
//  - the wheel is summed and sent as one step per 50 px, at most 20 a second.

import { isMac } from "./util.js";

const XK = { Control_L: 0xffe3, Return: 0xff0d, Tab: 0xff09, BackSpace: 0xff08 };
export const PASTE_CAP = 4096;

/** The keysym for one character: Latin-1 as itself, the rest as 0x1000000 + code point. */
export function keysymFor(ch) {
  const cp = /** @type {number} */ (ch.codePointAt(0));
  if (ch === "\n" || ch === "\r") return XK.Return;
  if (ch === "\t") return XK.Tab;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  if (cp < 0x20 || cp === 0x7f) return 0;
  return 0x1000000 + cp;
}

/** Cut text to at most `cap` UTF-8 bytes, on a character boundary. */
export function capBytes(text, cap = PASTE_CAP) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= cap) return text;
  let out = "", n = 0;
  for (const ch of text) {
    const b = enc.encode(ch).length;
    if (n + b > cap) break;
    out += ch; n += b;
  }
  return out;
}

/**
 * Type text into the remote screen, a few characters per frame so the relay is not flooded.
 * Resolves with the number of characters sent.
 * @param {any} rfb @param {string} text @param {{ cancelled?: () => boolean }} [opt]
 */
export function typeText(rfb, text, opt = {}) {
  const chars = [...capBytes(text.replace(/\r\n/g, "\n"))];
  let i = 0;
  return new Promise(resolve => {
    const step = () => {
      if (opt.cancelled?.() || !rfb) return resolve(i);
      for (let n = 0; n < 24 && i < chars.length; n++, i++) {
        const k = keysymFor(chars[i]);
        if (k) rfb.sendKey(k, null);
      }
      if (i < chars.length) setTimeout(step, 30); else resolve(i);
    };
    step();
  });
}

/**
 * Attach the take-over input rules to the element that holds noVNC's canvas. Listeners run in
 * the capture phase, so they see events before noVNC does. Returns a detach.
 * @param {any} rfb
 * @param {HTMLElement} host
 * @param {{ onHandBack: () => void, onPaste?: (sent: number, cut: boolean) => void }} hooks
 */
export function attach(rfb, host, hooks) {
  let pasting = false;

  /** @param {KeyboardEvent} e */
  const key = e => {
    if (e.type === "keydown" && e.key === "Enter" && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); hooks.onHandBack(); return;
    }
    // Paste (Cmd+V, or Ctrl+V off a Mac): keep it from noVNC but let the browser fire the paste
    // event, which types the local clipboard below.
    if ((isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && e.key.toLowerCase() === "v") { e.stopPropagation(); return; }
    if (!isMac) return;
    if (e.key === "Meta") { e.preventDefault(); e.stopPropagation(); return; }
    if (e.metaKey && !e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (e.type !== "keydown") return;
      rfb.sendKey(XK.Control_L, "ControlLeft", true);
      rfb.sendKey(e.key.toLowerCase().charCodeAt(0), null);
      rfb.sendKey(XK.Control_L, "ControlLeft", false);
    }
  };

  const paste = async (/** @type {string} */ text) => {
    if (pasting || !text) return;
    pasting = true;
    const cut = new TextEncoder().encode(text).length > PASTE_CAP;
    const sent = await typeText(rfb, text);
    pasting = false;
    hooks.onPaste?.(sent, cut);
  };
  /** @param {ClipboardEvent} e */
  const onPaste = e => {
    const text = e.clipboardData?.getData("text/plain") || "";
    e.preventDefault(); e.stopPropagation();
    paste(text);
  };

  // Wheel: sum the deltas, send one 50 px step at a time, no faster than every 50 ms. The timer
  // exists only while there is scrolling left to send.
  let accX = 0, accY = 0, last = 0, timer = 0, at = { x: 0, y: 0 };
  const canvas = () => host.querySelector("canvas");
  const flush = () => {
    timer = 0;
    const c = canvas();
    if (!c) { accX = accY = 0; return; }
    const dx = Math.abs(accX) >= 50 ? Math.sign(accX) * 50 : 0;
    const dy = Math.abs(accY) >= 50 ? Math.sign(accY) * 50 : 0;
    if (!dx && !dy) return;
    accX -= dx; accY -= dy;
    last = performance.now();
    const ev = new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
    /** @type {any} */ (ev).glass = true;
    c.dispatchEvent(ev);
    if (Math.abs(accX) >= 50 || Math.abs(accY) >= 50) timer = window.setTimeout(flush, 50);
  };
  /** @param {WheelEvent} e */
  const wheel = e => {
    if (/** @type {any} */ (e).glass) return;
    e.preventDefault(); e.stopPropagation();
    const k = e.deltaMode === 1 ? 19 : e.deltaMode === 2 ? 400 : 1;
    // At most ten steps queued, so a hard flick does not scroll on for seconds.
    accX = Math.max(-500, Math.min(500, accX + e.deltaX * k));
    accY = Math.max(-500, Math.min(500, accY + e.deltaY * k));
    at = { x: e.clientX, y: e.clientY };
    if (!timer) timer = window.setTimeout(flush, Math.max(0, 50 - (performance.now() - last)));
  };

  host.addEventListener("keydown", key, true);
  host.addEventListener("keyup", key, true);
  host.addEventListener("paste", onPaste, true);
  host.addEventListener("wheel", wheel, { capture: true, passive: false });
  return () => {
    host.removeEventListener("keydown", key, true);
    host.removeEventListener("keyup", key, true);
    host.removeEventListener("paste", onPaste, true);
    host.removeEventListener("wheel", wheel, true);
    clearTimeout(timer);
  };
}
