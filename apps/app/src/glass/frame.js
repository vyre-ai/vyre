// The Glass screen page: noVNC drawing what the box's stream passes through, inside an iframe on the web (the Deck's vendored noVNC, copied here by scripts/glass-assets.mjs).
// The host app (screens/glass) speaks to it with messages; nothing here knows React. The rules are the Deck's (deck/glass/watch.js, ADR 0005): view only unless this surface
// holds the keyboard, keysyms only (the relay does not take QEMU extended key events), the fit or 1:1 view, quality by link, and the last frame kept when the stream drops.
//
// (on the phone the same messages travel through the WebView: see screens/glass/GlassFrame.native.tsx)
// host -> page   {t:"connect", url, quality, compression, fit}   {t:"holding", on}   {t:"fit", on}   {t:"drop"}
// page -> host   {t:"ready"}   {t:"live"}   {t:"down", code, reason, clean}   {t:"handback"}   {t:"paste", sent, cut}   {t:"security", reason}
import RFB from "./novnc/core/rfb.js";
import { attach } from "./input.js";

const host = document.getElementById("g");
const snap = document.getElementById("snap");
// In a browser the page is an iframe and talks to its parent window. On the phone it is a WebView with no parent: the app's WebView gives it ReactNativeWebView to speak to, and hears the app through messages it
// marks `__host` (the app injects them; nothing else can reach a message listener of this page).
const native = typeof window.ReactNativeWebView === "object" && window.ReactNativeWebView ? window.ReactNativeWebView : null;
const post = (m) => { try { if (native) native.postMessage(JSON.stringify(m)); else window.parent.postMessage(m, location.origin); } catch {} };

let rfb = null;
let canvas = null;
let detach = () => {};
let fit = true;
let holding = false;
let code = 0, reason = "";

/** noVNC removes its canvas on disconnect, so the last frame is copied first and a paused view is not blank. */
function keepFrame() {
  const c = canvas;
  if (!c || !c.width || !c.height) return;
  try { snap.width = c.width; snap.height = c.height; snap.getContext("2d").drawImage(c, 0, 0); snap.hidden = false; } catch {}
}

function applyHolding() {
  detach(); detach = () => {};
  if (!rfb) return;
  rfb.viewOnly = !holding;
  if (holding) {
    detach = attach(rfb, host, {
      onHandBack: () => post({ t: "handback" }),
      onPaste: (sent, cut) => post({ t: "paste", sent, cut }),
    });
    rfb.focus({ preventScroll: true });
  }
}

function applyFit() {
  if (!rfb) return;
  rfb.scaleViewport = fit;
  rfb.clipViewport = !fit;
}

function drop() {
  const r = rfb;
  rfb = null;
  detach(); detach = () => {};
  if (r) { keepFrame(); try { r.disconnect(); } catch {} }
  host.replaceChildren();
}

function connect(m) {
  drop();
  snap.hidden = snap.hidden && true;
  code = 0; reason = "";
  let r;
  try { r = new RFB(host, String(m.url), { shared: true }); } catch (e) { post({ t: "down", code: 0, reason: String((e && e.message) || e), clean: false, start: true }); return; }
  rfb = r;
  canvas = host.querySelector("canvas");
  try { Object.defineProperty(r, "_qemuExtKeyEventSupported", { get: () => false, set: () => {}, configurable: true }); } catch {}
  r.viewOnly = true;
  r.resizeSession = false;
  r.background = "transparent";
  fit = m.fit !== false;
  r.scaleViewport = fit;
  r.clipViewport = !fit;
  r.focusOnClick = true;
  r.qualityLevel = Number(m.quality) || 6;
  r.compressionLevel = Number(m.compression) || 2;
  const sock = r._sock;
  const orig = sock && sock._eventHandlers && sock._eventHandlers.close;
  if (orig) sock._eventHandlers.close = (e) => { code = e.code; reason = e.reason || ""; orig(e); };
  r.addEventListener("connect", () => { if (rfb !== r) return; snap.hidden = true; applyFit(); applyHolding(); post({ t: "live" }); });
  r.addEventListener("disconnect", (e) => {
    if (rfb !== r) return; // closed on purpose
    rfb = null; detach(); detach = () => {};
    keepFrame();
    post({ t: "down", code, reason, clean: Boolean(e.detail && e.detail.clean) });
  });
  r.addEventListener("securityfailure", (e) => post({ t: "security", reason: (e.detail && e.detail.reason) || "Your server refused the screen." }));
}

window.addEventListener("message", (e) => {
  if (!e.data || typeof e.data !== "object") return;
  if (native ? e.data.__host !== true : e.source !== window.parent || e.origin !== location.origin) return;
  const m = e.data;
  if (m.t === "connect") connect(m);
  else if (m.t === "holding") { holding = Boolean(m.on); applyHolding(); }
  else if (m.t === "fit") { fit = Boolean(m.on); applyFit(); }
  else if (m.t === "drop") drop();
});
post({ t: "ready" });
