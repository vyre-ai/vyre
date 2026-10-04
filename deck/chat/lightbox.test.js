// @ts-check
// The tap-to-zoom overlay (cohesion item 18): opens with a picture and its caption, Esc or a tap
// on the backdrop closes it, and closing returns focus to whatever opened it.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $, text } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
// The base fake's document.addEventListener is a no-op with no dispatchEvent at all (only
// Elements have one): capture keydown listeners by hand, the same pattern session.test.js uses.
const keys = new Set();
doc.addEventListener = (type, fn) => { if (type === "keydown") keys.add(fn); };
doc.removeEventListener = (type, fn) => { if (type === "keydown") keys.delete(fn); };
const esc = () => { const e = /** @type {any} */ (new Event("keydown")); e.key = "Escape"; e.preventDefault = () => {}; for (const f of keys) f(e); };
// Not overriding preventDefault here (unlike esc() above): this helper's own tests read
// defaultPrevented, which only the base Event class's real preventDefault() sets.
const tab = (shiftKey = false) => {
  const e = /** @type {any} */ (new Event("keydown"));
  e.key = "Tab"; e.shiftKey = shiftKey;
  for (const f of keys) f(e);
  return e;
};
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; return { documentElement: new E("svg") }; } },
});

const { openLightbox, _reset } = await import("./lightbox.js");

test.beforeEach(() => { _reset(); keys.clear(); doc.body.replaceChildren(); });

test("open: the picture and its caption draw; the opener's own focus is remembered", () => {
  const opener = doc.createElement("button");
  doc.body.append(opener);
  doc.activeElement = opener;
  openLightbox("data:image/png;base64,QUJD", { alt: "invoice", caption: "invoice.png - from you" });
  const root = $(doc.body, ".lightbox");
  assert.equal(root.hidden, false);
  assert.equal($(root, ".lightbox-img").getAttribute("src"), "data:image/png;base64,QUJD");
  assert.equal($(root, ".lightbox-img").getAttribute("alt"), "invoice");
  assert.equal(text($(root, ".lightbox-cap")), "invoice.png - from you");
  assert.equal($(root, ".lightbox-cap").hidden, false);
});

test("close: the × hides it, drops the src, and gives focus back to the opener", () => {
  const opener = doc.createElement("button");
  doc.body.append(opener);
  let focused = false;
  /** @type {any} */ (opener).focus = () => { focused = true; };
  doc.activeElement = opener;
  openLightbox("data:image/png;base64,QUJD");
  const root = $(doc.body, ".lightbox");
  $(root, ".lightbox-close").click();
  assert.equal(root.hidden, true);
  assert.equal($(root, ".lightbox-img").getAttribute("src"), null);
  assert.equal(focused, true);
});

test("Esc closes it; a second Esc (already closed) does nothing", () => {
  openLightbox("data:image/png;base64,QUJD");
  const root = $(doc.body, ".lightbox");
  esc();
  assert.equal(root.hidden, true);
  esc();
  assert.equal(root.hidden, true);
});

test("aria-modal's promise: Tab never leaves the dialog (app-design's review) - it stays on the one control", () => {
  openLightbox("data:image/png;base64,QUJD");
  const root = $(doc.body, ".lightbox");
  const closeBtn = $(root, ".lightbox-close");
  let focused = false;
  /** @type {any} */ (closeBtn).focus = () => { focused = true; doc.activeElement = closeBtn; };
  doc.activeElement = closeBtn; // the one control, focused on open per openLightbox
  const e1 = tab();
  assert.equal(e1.defaultPrevented, true, "with one control, Tab is always caught");
  assert.equal(focused, true);
  focused = false;
  const e2 = tab(true); // Shift+Tab: same, still the only control
  assert.equal(e2.defaultPrevented, true);
  assert.equal(focused, true);
});

test("a tap on the backdrop closes it; a tap that bubbled from the picture itself does not", () => {
  openLightbox("data:image/png;base64,QUJD");
  const root = $(doc.body, ".lightbox");
  const img = $(root, ".lightbox-img");
  // The fake DOM does not bubble; a real click on the picture reaches root's listener with the
  // picture as e.target (as a real bubbled click would), and root's handler must ignore it.
  const fromImg = new Event("click"); Object.defineProperty(fromImg, "target", { value: img });
  root.dispatchEvent(fromImg);
  assert.equal(root.hidden, false, "a click that started on the picture does not close it");
  const fromBackdrop = new Event("click"); Object.defineProperty(fromBackdrop, "target", { value: root });
  root.dispatchEvent(fromBackdrop);
  assert.equal(root.hidden, true);
});

test("no caption: the caption line is hidden, not drawn empty", () => {
  openLightbox("data:image/png;base64,QUJD", { alt: "screen" });
  const root = $(doc.body, ".lightbox");
  assert.equal($(root, ".lightbox-cap").hidden, true);
});
