// @ts-check
// The phone's Lumen (docs/design/phone.md section 3): one floating bar at the bottom of the three
// pages that opens Find. A tap opens it; a drag up opens it too, following the finger; holding the
// mic dictates, and letting go puts the words in Find without sending them. The shell (app.js)
// owns the route and decides when Lumen shows; this file only draws it and reads gestures.
//
//   const cap = capsule({ open(words) { ... } });
//   deck.append(cap.el);
//   cap.name("juno");      // the assistant's name in the placeholder
//   cap.proxy()            // focus a hidden field in the same tap, so iOS raises the keyboard
//
// Nothing here runs until a finger touches it: no timers, no polls, passive listeners where a
// listener does not need to stop the browser (the mic does: a long press would select text).

import { h, put } from "./dom.js";
import { icon, mark } from "./icons.js";

/** The browser's speech recognition, where it has one (Safari and Chrome prefix it). */
export function recognizer() {
  const w = /** @type {any} */ (typeof window === "undefined" ? {} : window);
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** "Ask juno, find, or run": the assistant's name when there is one, else Vyre. */
export const placeholder = (/** @type {string | null | undefined} */ who) => `Ask ${who || "Vyre"}, find, or run`;

/** The assistant among agents.list's answer (an array, or { agents }), by kind. */
export function assistantName(/** @type {any} */ data) {
  const list = Array.isArray(data) ? data : data?.agents || [];
  return list.find((/** @type {any} */ a) => a?.kind === "assistant")?.name || null;
}

const DRAG_OPEN = 64;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * @param {{ open: (words?: string) => void }} o
 */
export function capsule(o) {
  const text = h("span", { class: "cap-ph ellipsis" }, placeholder(null));
  const openBtn = h("button", { type: "button", class: "cap-open", "aria-label": placeholder(null) },
    h("span", { class: "cap-mark" }, mark(20)), text);
  const SR = recognizer();
  const mic = h("button", { type: "button", class: "cap-mic", "aria-label": "Hold to dictate", hidden: !SR }, icon("mic", 20));
  // A field iOS will raise the keyboard for: focused in the tap itself, before Find exists; Find's
  // own box takes the focus (and keeps the keyboard) the moment it draws.
  const proxy = /** @type {HTMLInputElement} */ (h("input", { class: "cap-proxy", type: "text", tabindex: "-1", "aria-hidden": "true", autocomplete: "off" }));
  const rise = h("div", { class: "cap-rise", "aria-hidden": "true" });
  const el = h("div", { class: "capsule", role: "region", "aria-label": "Find" }, openBtn, mic, proxy);
  let who = /** @type {string | null} */ (null);

  function name(/** @type {string | null} */ n) {
    who = n;
    if (!el.classList.contains("listening")) put(text, placeholder(n));
    openBtn.setAttribute("aria-label", placeholder(n));
  }

  // ---- tap and drag up ------------------------------------------------------------------------
  let y0 = 0, dy = 0, pid = -1, dragging = false;
  openBtn.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    pid = e.pointerId; y0 = e.clientY; dy = 0; dragging = false;
  }, { passive: true });
  openBtn.addEventListener("pointermove", e => {
    if (e.pointerId !== pid) return;
    dy = Math.max(0, y0 - e.clientY);
    if (!dragging && dy > 8) {
      dragging = true;
      try { openBtn.setPointerCapture(pid); } catch {}
      document.body.append(rise);
    }
    if (dragging) rise.style.transform = `translateY(calc(100% - ${dy}px))`;
  }, { passive: true });
  const end = (/** @type {PointerEvent} */ e) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    if (!dragging) return; // a plain tap is the click below
    dragging = false;
    if (e.type === "pointerup" && dy >= DRAG_OPEN) {
      proxy.focus({ preventScroll: true });
      if (reduced()) { rise.remove(); o.open(); return; }
      rise.classList.add("going");
      rise.style.transform = "translateY(0)";
      const go = () => { rise.classList.remove("going"); rise.remove(); rise.style.transform = ""; o.open(); };
      rise.addEventListener("transitionend", go, { once: true });
    } else {
      rise.classList.add("going");
      rise.style.transform = "translateY(100%)";
      rise.addEventListener("transitionend", () => { rise.classList.remove("going"); rise.remove(); }, { once: true });
    }
    // The click that follows a drag must not open Find a second time.
    swallow = true;
  };
  let swallow = false;
  openBtn.addEventListener("pointerup", end, { passive: true });
  openBtn.addEventListener("pointercancel", end, { passive: true });
  openBtn.addEventListener("click", () => {
    if (swallow) { swallow = false; return; }
    proxy.focus({ preventScroll: true });
    o.open();
  });

  // ---- hold the mic to dictate ------------------------------------------------------------------
  /** @type {any} */ let rec = null;
  let heard = "", holding = false;
  function listen() {
    if (!SR || rec) return;
    heard = ""; holding = true;
    try {
      rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (/** @type {any} */ ev) => {
        heard = [...ev.results].map((/** @type {any} */ r) => r[0]?.transcript || "").join(" ").replace(/\s+/g, " ").trim();
        put(text, heard || "Listening");
      };
      rec.onerror = () => { holding = false; };
      rec.onend = () => { rec = null; done(); };
      rec.start();
    } catch { rec = null; holding = false; return; }
    el.classList.add("listening");
    mic.setAttribute("aria-pressed", "true");
    put(text, "Listening");
  }
  function release() {
    if (!holding) return;
    holding = false;
    try { rec?.stop(); } catch { rec = null; done(); }
  }
  function done() {
    el.classList.remove("listening");
    mic.removeAttribute("aria-pressed");
    put(text, placeholder(who));
    const words = heard.trim();
    heard = "";
    // Into Find, never sent: the person reads it and presses Enter themselves.
    if (words) o.open(words);
  }
  mic.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { mic.setPointerCapture(e.pointerId); } catch {}
    listen();
  });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) mic.addEventListener(t, release, { passive: true });
  mic.addEventListener("contextmenu", e => e.preventDefault());
  // A keyboard holds the mic with Space or Enter.
  mic.addEventListener("keydown", e => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); listen(); } });
  mic.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); release(); } });

  return { el, name, proxy: () => proxy.focus({ preventScroll: true }) };
}
