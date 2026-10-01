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
// Call guardFrame() BEFORE the frame is attached, so the first load is heard, and give the frame
// its src before or as it is attached (a frame with no src that is given one later can fire a
// load for about:blank first in some browsers, which would count as the first).

import { h } from "../../js/dom.js";

/** The sandbox token lists. A static kind (doc, report, dashboard, diagram, deck, media) runs no script at all; only a page or app the box
 * marks `interactive` gets allow-scripts. Never add allow-same-origin, allow-top-navigation, allow-forms, allow-popups or allow-downloads. */
export const SANDBOX = "allow-scripts";
export const SANDBOX_STATIC = "";
/** The one fixed line under an interactive artifact: no dialog, said every time. */
export const INTERACTIVE_LINE = "Runs its own code and can reach the internet";
/** Whether a kind runs its own code when the box does not say: only a page or an app. @param {string} type */
export const interactiveByKind = type => type === "page" || type === "app";
/** What the person reads when the page tried to leave. */
export const NAVIGATED = "This page tried to open another site";
const BLANK = "about:blank";

/**
 * Count a frame's load events. The second one blanks the frame and calls onBlank once; after
 * that the frame's own load for the blank page (and any later one) is ignored.
 * @param {{ addEventListener: (t: string, fn: () => void) => void, removeEventListener?: (t: string, fn: () => void) => void, setAttribute: (k: string, v: string) => void, src?: string }} frame
 * @param {{ onBlank?: () => void }} [o]
 * @returns {{ loads: () => number, blanked: () => boolean, stop: () => void }}
 */
export function guardFrame(frame, { onBlank } = {}) {
  let loads = 0, blanked = false;
  const onLoad = () => {
    if (blanked) return;
    loads++;
    if (loads < 2) return;
    blanked = true;
    frame.setAttribute("src", BLANK);
    try { frame.src = BLANK; } catch { /* a frame object with a read-only src */ }
    onBlank?.();
  };
  frame.addEventListener("load", onLoad);
  return { loads: () => loads, blanked: () => blanked, stop: () => { blanked = true; frame.removeEventListener?.("load", onLoad); } };
}

/**
 * A guarded, sandboxed frame for one artifact page. `src` is the artifacts render route's URL
 * (a path on the box, never something the artifact chose). onBlank is called after the frame is
 * blanked; the returned element is a wrapper whose content swaps to the plain line.
 * @param {{ src: string, title: string, interactive?: boolean, onBlank?: () => void }} o
 * @returns {HTMLElement & { guard: ReturnType<typeof guardFrame> }}
 */
export function artifactFrame(o) {
  const wrap = /** @type {any} */ (h("div", { class: "cv-art-frame" }));
  const frame = h("iframe", { class: "cv-art-iframe", sandbox: o.interactive === false ? SANDBOX_STATIC : SANDBOX, title: o.title, referrerpolicy: "no-referrer", loading: "eager" });
  wrap.guard = guardFrame(frame, { onBlank: () => {
    wrap.replaceChildren(h("p", { class: "cv-art-note", role: "alert" }, NAVIGATED));
    o.onBlank?.();
  } });
  frame.setAttribute("src", o.src);
  wrap.append(frame);
  return wrap;
}
