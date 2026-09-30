// @ts-check
// The sandboxed frame an artifact page or diagram is shown in (artifacts review M5).
//
// sandbox="allow-scripts" and nothing else: no allow-same-origin (the page runs at an opaque
// origin and cannot read the Deck's storage or call its tools), no allow-top-navigation, no
// allow-forms, no allow-popups. What that flag set cannot stop is the page navigating its OWN
// frame (`location = ...`, a meta refresh), and CSP has no navigate-to. An agent-made page could
// turn the panel into any outside page and the person would read it as part of Vyre. So the
// frame is counted: the first `load` is the artifact, a second `load` means it navigated, and
// the frame is blanked and replaced by a plain line. Public pages are accepted as they are: the
// person chose to share them.
//
// Counting loads alone misses a page that navigates before its FIRST load finishes (a script or meta
// refresh in the head aborts that load, so the browser fires one load, for the outside page). So a page
// that runs scripts also gets a per-render nonce: the render route adds a last script that posts
// {vyreFrame: nonce} to the parent, and the outside page never sees the nonce. A first load with no such
// message within about 2 s, or any load after it, blanks the frame (reviewer-2 M2). The nonce is asked
// for only where the route says it will send it (the x-vyre-frame-nonce header), so an older route is
// counted the old way instead of blanking every page.
//
// Call guardFrame() BEFORE the frame is attached, so the first load is heard, and give the frame
// its src before or as it is attached (a frame with no src that is given one later can fire a
// load for about:blank first in some browsers, which would count as the first).

import { h } from "../../js/dom.js";

/** The one sandbox token list. Never add allow-same-origin, allow-top-navigation, allow-forms or allow-popups. */
export const SANDBOX = "allow-scripts";
/** What the person reads when the page tried to leave. */
export const NAVIGATED = "This page tried to open another site";
const BLANK = "about:blank";
/** How long a page that runs scripts has to post its nonce after its first load. */
export const NONCE_WAIT_MS = 2000;

/** A fresh nonce for one render: 128 random bits, url-safe. */
export function newNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Count a frame's load events. The second one blanks the frame and calls onBlank once; after
 * that the frame's own load for the blank page (and any later one) is ignored.
 * @param {{ addEventListener: (t: string, fn: () => void) => void, removeEventListener?: (t: string, fn: () => void) => void, setAttribute: (k: string, v: string) => void, src?: string }} frame
 * @param {{ onBlank?: () => void, nonce?: string|null, wait?: number }} [o] nonce: this render's, when the page must say it is the one that loaded
 * @returns {{ loads: () => number, blanked: () => boolean, heard: () => boolean, stop: () => void }}
 */
export function guardFrame(frame, { onBlank, nonce = null, wait = NONCE_WAIT_MS } = {}) {
  let loads = 0, blanked = false, heard = false;
  /** @type {any} */ let timer = null;
  const blank = () => {
    if (blanked) return;
    blanked = true;
    clearTimeout(timer);
    frame.setAttribute("src", BLANK);
    try { frame.src = BLANK; } catch { /* a frame object with a read-only src */ }
    onBlank?.();
  };
  const onLoad = () => {
    if (blanked) return;
    loads++;
    if (loads >= 2) return blank();
    if (nonce && !heard) { timer = setTimeout(() => { if (!heard) blank(); }, wait); timer?.unref?.(); }
  };
  /** The parent's `message` event: only the frame's own window, only this render's nonce. @param {any} e */
  const onMessage = e => {
    if (!nonce || blanked || heard) return;
    const from = /** @type {any} */ (frame).contentWindow;
    if (from && e.source !== from) return;
    if (!e.data || e.data.vyreFrame !== nonce) return;
    heard = true;
    clearTimeout(timer);
  };
  frame.addEventListener("load", onLoad);
  if (nonce) globalThis.addEventListener?.("message", onMessage);
  return { loads: () => loads, blanked: () => blanked, heard: () => heard, stop: () => {
    blanked = true; clearTimeout(timer); frame.removeEventListener?.("load", onLoad); globalThis.removeEventListener?.("message", onMessage);
  } };
}

/**
 * A guarded, sandboxed frame for one artifact page. `src` is the artifacts render route's URL
 * (a path on the box, never something the artifact chose). onBlank is called after the frame is
 * blanked; the returned element is a wrapper whose content swaps to the plain line.
 * @param {{ src: string, title: string, onBlank?: () => void, nonce?: string|null, wait?: number }} o nonce: sent as ?n= to a route that says it will post it back
 * @returns {HTMLElement & { guard: ReturnType<typeof guardFrame> }}
 */
export function artifactFrame(o) {
  const wrap = /** @type {any} */ (h("div", { class: "cv-art-frame" }));
  const frame = h("iframe", { class: "cv-art-iframe", sandbox: SANDBOX, title: o.title, referrerpolicy: "no-referrer", loading: "eager" });
  wrap.guard = guardFrame(frame, { nonce: o.nonce || null, wait: o.wait, onBlank: () => {
    wrap.replaceChildren(h("p", { class: "cv-art-note", role: "alert" }, NAVIGATED));
    o.onBlank?.();
  } });
  frame.setAttribute("src", o.nonce ? o.src + (o.src.includes("?") ? "&" : "?") + "n=" + encodeURIComponent(o.nonce) : o.src);
  wrap.append(frame);
  return wrap;
}
