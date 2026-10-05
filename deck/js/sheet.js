// @ts-check
// A bottom sheet (docs/design/phone.md section 5): the scrim, a --panel sheet with a grabber, a
// header, a body that scrolls and an action area pinned above the bottom safe area. It closes by
// its close button, a tap on the scrim, Escape, or a swipe down on the grabber or the header.
// While it is open, focus stays inside it and the page behind is inert; closing puts focus back
// where it was. The page behind scales to 0.94 over black, except under Reduce Motion.
//
//   const s = openSheet({ title: "Push q3-report", build(body, close, { head, actions }) { ... } });
//   s.close();
//
// build fills `body` (and, when it wants them, `head` and `actions`). A sheet whose head is left
// empty gets a plain one: the title and a close button. Styles: css/sheet.css, loaded once.
// That file also defines --match and --scrim for both themes.

import { h, put } from "./dom.js";

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  if (typeof document === "undefined") return;
  if (!document.head.querySelector('link[href="/css/sheet.css"]')) document.head.append(h("link", { rel: "stylesheet", href: "/css/sheet.css" }));
}
// Loaded at import, so --match is there for anything that imports this before a sheet opens.
if (typeof document !== "undefined") style();

const NS = "http://www.w3.org/2000/svg";
/** The close glyph, 24 grid, 1.5 stroke. */
export function closeGlyph(size = 16) {
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M6.5 6.5l11 11M17.5 6.5l-11 11");
  svg.append(p);
  return svg;
}

/** Sheets open now, innermost last. Only the innermost hears Escape and keeps focus. */
/** @type {{ el: HTMLElement, close: () => void }[]} */
const stack = [];
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open a sheet.
 * @param {{ title: string, label?: string, build: (body: HTMLElement, close: () => void, parts: { head: HTMLElement, actions: HTMLElement, sheet: HTMLElement }) => void,
 *   onClose?: () => void }} o
 * @returns {{ close: () => void, el: HTMLElement }}
 */
export function openSheet(o) {
  style();
  const back = /** @type {HTMLElement | null} */ (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const behind = document.getElementById("deck");
  const titleId = "sheet-t-" + Math.random().toString(36).slice(2, 8);

  const scrim = h("div", { class: "sheet-scrim", "aria-hidden": "true" });
  const grab = h("div", { class: "sheet-grab", "aria-hidden": "true" }, h("span", { class: "sheet-grabber" }));
  const head = h("div", { class: "sheet-head" });
  const body = h("div", { class: "sheet-body" });
  const actions = h("div", { class: "sheet-actions" });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": o.label || o.title, tabindex: "-1" },
    grab, head, body, actions);
  const layer = h("div", { class: "sheet-layer" }, scrim, sheet);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const i = stack.findIndex(s => s.el === layer);
    if (i >= 0) stack.splice(i, 1);
    document.removeEventListener("keydown", onKey, true);
    layer.classList.remove("open");
    layer.classList.add("closing");
    if (!stack.length) {
      document.documentElement.classList.remove("sheet-open");
      if (behind) behind.inert = false;
    }
    const done = () => { layer.remove(); };
    if (reduced()) done(); else { sheet.addEventListener("transitionend", done, { once: true }); setTimeout(done, 400); }
    try { if (back && back.isConnected) back.focus({ preventScroll: true }); } catch {}
    o.onClose?.();
  }

  // Build first, so the head and the actions know what they hold before the sheet shows.
  o.build(body, close, { head, actions, sheet });
  if (!head.childNodes.length) {
    put(head, h("div", { class: "sheet-plain" },
      h("h2", { class: "sheet-title", id: titleId }, o.title),
      h("button", { type: "button", class: "sheet-close", "aria-label": "Close", onclick: close }, closeGlyph(16))));
    sheet.removeAttribute("aria-label");
    sheet.setAttribute("aria-labelledby", titleId);
  }
  if (!actions.childNodes.length) actions.hidden = true;

  scrim.addEventListener("click", close);

  // Focus stays in the innermost sheet; Escape closes it.
  function onKey(/** @type {KeyboardEvent} */ e) {
    if (stack[stack.length - 1]?.el !== layer) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = /** @type {HTMLElement[]} */ ([...sheet.querySelectorAll(FOCUSABLE)]).filter(x => !x.closest("[hidden]") && x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); sheet.focus(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);

  // Swipe down on the grabber or the header. Follows the finger; past a third of the sheet, or a
  // quick flick, it closes; else it springs back.
  let y0 = 0, dy = 0, lastY = 0, lastT = 0, v = 0, dragging = false, pid = -1;
  const down = (/** @type {PointerEvent} */ e) => {
    if (e.button !== 0 || closed) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("button, a, input, textarea, select")) return;
    dragging = true; pid = e.pointerId; y0 = lastY = e.clientY; lastT = e.timeStamp; dy = 0; v = 0;
    sheet.classList.add("dragging");
  };
  const move = (/** @type {PointerEvent} */ e) => {
    if (!dragging || e.pointerId !== pid) return;
    dy = Math.max(0, e.clientY - y0);
    if (dy > 4) { try { /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(pid); } catch {} }
    const dt = e.timeStamp - lastT;
    if (dt > 0) v = (e.clientY - lastY) / dt;
    lastY = e.clientY; lastT = e.timeStamp;
    sheet.style.transform = dy ? `translateY(${dy}px)` : "";
  };
  const up = (/** @type {PointerEvent} */ e) => {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    sheet.classList.remove("dragging");
    if (dy > sheet.offsetHeight / 3 || (v > 0.6 && dy > 24)) { sheet.style.transform = `translateY(${dy}px)`; requestAnimationFrame(() => { sheet.style.transform = ""; close(); }); }
    else sheet.style.transform = "";
  };
  for (const zone of [grab, head]) {
    zone.addEventListener("pointerdown", down);
    zone.addEventListener("pointermove", move);
    zone.addEventListener("pointerup", up);
    zone.addEventListener("pointercancel", up);
  }

  document.body.append(layer);
  stack.push({ el: layer, close });
  document.documentElement.classList.add("sheet-open");
  if (behind) behind.inert = true;
  // Next frame, so the opening transition runs from the closed position.
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) layer.classList.add("open"); }));
  const first = /** @type {HTMLElement | null} */ (sheet.querySelector("[autofocus]"));
  (first || sheet).focus({ preventScroll: true });
  return { close, el: sheet };
}
