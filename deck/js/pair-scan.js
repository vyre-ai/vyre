// @ts-check
// Scan your avatar to pair your phone: the DOM wiring. deck/views/pair-scan.js has the pure
// state machine; deck/js/scan.js has the camera+decoder; this file is the sheet that shows one
// for the other, plus the two relay calls in between.
//
// Flow (see team/HANDOFF.md's "PWA: scan-avatar-to-pair" brief): the Deck's "Add your phone"
// (launch's screen) shows the person's avatar in a live code ring encoding a one-time ticket.
// Here: the camera reads it, relay.pair.ticket.resolve turns the ticket into which box it's for
// (name + fingerprint, so the person can confirm it's really their own box before anything
// happens), then relay.join runs the real handshake - the box confirms with Touch ID on its own
// side, this sheet just waits and shows the result.
//
// PENDING on tailnet (see docs/work/pwa.md "Needs from others"): relay.pair.ticket.resolve is
// this file's own proposed name and shape - { ticket } -> { box, fingerprint } | refusal with one
// of ticket_expired, ticket_used, ticket_not_found, rate_limited. relay.join's own input/output
// past what's already documented elsewhere in this repo is assumed, not confirmed.

import { h, put } from "./dom.js";
import { attempt } from "./api.js";
import { icon } from "./icons.js";
import { startScan } from "./scan.js";
import { initial, step } from "../views/pair-scan.js";

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/pair.css" }));
}

/**
 * The scan-to-pair sheet. Mount it, call open() when the person taps "Scan", close() to tear
 * down the camera (always call close() when the sheet is dismissed, not just on success/error -
 * a live camera stream left open is exactly what "Light by default" (SPEC 8) rules out).
 * @returns {{ el: HTMLElement, open: () => void, close: () => void }}
 */
export function pairScanSheet() {
  style();
  let state = initial();
  /** @type {{ stop: () => void } | null} */ let scan = null;
  const video = /** @type {HTMLVideoElement} */ (h("video", { class: "scan-video", playsinline: true, muted: true, "aria-hidden": "true" }));
  const status = h("div", { class: "scan-status", role: "status" });
  const actions = h("div", { class: "scan-actions" });
  const el = h("div", { class: "scan-sheet", role: "dialog", "aria-label": "Scan to pair" },
    h("div", { class: "scan-title" }, icon("phone", 18), h("span", null, "Scan to pair")),
    h("div", { class: "scan-frame" }, video, h("div", { class: "scan-ring", "aria-hidden": "true" })),
    status, actions);

  function dispatch(/** @type {import("../views/pair-scan.js").Event} */ event) {
    state = step(state, event);
    render();
  }

  async function onFound(/** @type {string} */ ticket) {
    dispatch({ type: "found", ticket });
    const r = await attempt("relay.pair.ticket.resolve", { ticket });
    if (r.error) { dispatch({ type: "resolveFailed", code: r.error.code, message: String(r.error.message || r.error) }); return; }
    dispatch({ type: "resolved", box: r.data.box, fingerprint: r.data.fingerprint });
  }

  async function onConfirm() {
    if (state.kind !== "confirm") return;
    const { ticket } = state;
    dispatch({ type: "confirm" });
    const r = await attempt("relay.join", { ticket }, { presence: true });
    if (r.error) { dispatch({ type: "pairFailed", code: r.error.code, message: String(r.error.message || r.error) }); return; }
    dispatch({ type: "paired", box: r.data?.box || (state.kind === "pairing" ? state.box : "") });
  }

  function startCamera() {
    scan?.stop();
    scan = startScan({
      video,
      onFound: (ticket) => { scan?.stop(); onFound(ticket); },
      onError: (err) => dispatch({ type: "resolveFailed", code: /** @type {any} */ (err).code || "camera", message: err.message }),
    });
  }

  function render() {
    if (state.kind === "scanning") {
      put(status, "Point your camera at the code on your Mac or your box.");
      put(actions);
    } else if (state.kind === "resolving") {
      put(status, "Reading the code…");
      put(actions);
    } else if (state.kind === "confirm") {
      put(status, h("div", null, "Pair with ", h("b", null, state.box), "?"), h("div", { class: "small faint" }, "Code ", state.fingerprint));
      put(actions,
        h("button", { type: "button", class: "btn btn-primary", onclick: onConfirm }, "Pair"),
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => { dispatch({ type: "retry" }); startCamera(); } }, "Not this one"));
    } else if (state.kind === "pairing") {
      put(status, "Confirm with Touch ID on ", h("b", null, state.box), "…");
      put(actions);
    } else if (state.kind === "done") {
      put(status, icon("check", 14), " Paired with ", h("b", null, state.box), ".");
      put(actions);
    } else if (state.kind === "error") {
      put(status, h("span", { class: "pair-err" }, state.message));
      put(actions, state.retryable ? h("button", { type: "button", class: "btn btn-primary", onclick: () => { dispatch({ type: "retry" }); startCamera(); } }, "Scan again") : null);
    }
  }

  return {
    el,
    open() { state = initial(); render(); startCamera(); },
    close() { scan?.stop(); scan = null; },
  };
}
