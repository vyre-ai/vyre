// @ts-check
// Scan your avatar to pair your phone: the DOM wiring. deck/views/pair-scan.js has the pure
// state machine; deck/js/scan.js has the camera+decoder; deck/js/pair-ticket.js re-exports
// tailnet's relay/client library; deck/js/pair-avatar.js renders the success screen's avatar.
// This file is the sheet that shows one for the other.
//
// Flow (docs/work/pwa.md's "Phone-side contract" has the full writeup, for launch's Deck-side
// screen): the Deck's "Add your phone" shows the person's avatar in a live code ring encoding a
// one-time ticket. Here: the camera reads it (scan.js), resolveTicket() looks the ticket up and
// verifies it WITHOUT pairing - the ticket never leaves the phone, the record's MAC covers the
// whole thing, the fingerprint is computed locally - the person sees "Pair with <name>
// (<fingerprint>)?" and can say no before anything happens, and only on Pair does pairOffer()
// run the actual handshake. On success: the person's SAME avatar (rendered fresh, not a camera
// photo - see pair-avatar.js) does a short celebratory dance, then redirects to their own
// <handle>.vyre.run once tailnet's resolve hands one back.
//
// The resolved `offer` (it carries the derived pairing secret) lives ONLY in this closure's
// local `pendingOffer` variable - never in storage, a URL, or a log - and is dropped (set back to
// null) on "Not this one" or once pairing finishes either way, so it can never outlive one scan.

import { h, put } from "./dom.js";
import { icon } from "./icons.js";
import { startScan } from "./scan.js";
import { resolveTicket, pairOffer, crypto, classifyError } from "./pair-ticket.js";
import { renderPersonAvatar } from "./pair-avatar.js";
import { attempt } from "./api.js";
import { initial, step } from "../views/pair-scan.js";

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/pair.css" }));
}

const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

/** The device name sent with the pairing: the person's first name (system.info owner.name) plus
 * the model (User-Agent Client Hints - Android usually gives it, e.g. "Pixel 8"; iOS Safari
 * doesn't support UA-CH at all and falls back to a plain "iPhone"/"iPad") - "Alex's iPhone"
 * (team-lead, 2026-09-28). */
async function deviceName() {
  let model = null;
  try {
    const uaData = /** @type {any} */ (navigator).userAgentData;
    if (uaData?.getHighEntropyValues) {
      const info = await uaData.getHighEntropyValues(["model"]);
      if (info?.model) model = String(info.model).trim();
    }
  } catch {}
  const kind = model || (/iPhone|iPod/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : "This phone");
  const r = await attempt("system.info");
  const first = r.data?.owner?.name ? String(r.data.owner.name).trim().split(/\s+/)[0] : null;
  return first ? `${first}'s ${kind}` : kind;
}

/**
 * The scan-to-pair sheet. Mount it, call open() when the person taps "Scan", close() to tear
 * down the camera (always call close() when the sheet is dismissed, not just on success/error -
 * a live camera stream left open is exactly what "Light by default" (SPEC 8) rules out).
 * @param {{ relay: string }} opts the box's relay address (nothing in the 72-bit code carries
 *   this - PENDING launch: where its "Add your phone" screen gets it from, to pass in here)
 * @returns {{ el: HTMLElement, open: () => void, close: () => void }}
 */
export function pairScanSheet(opts) {
  style();
  let state = initial();
  /** @type {{ stop: () => void } | null} */ let scan = null;
  /** @type {{ relay: string, route: string, box: Uint8Array, secret: string } | null} */ let pendingOffer = null;
  /** @type {string | null} */ let cameraAvatarUrl = null; // scan.js's crop, kept as a fallback only
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

  async function onFound(/** @type {Uint8Array} */ ticket, /** @type {string | null} */ avatarDataUrl) {
    cameraAvatarUrl = avatarDataUrl;
    dispatch({ type: "found" });
    try {
      const resolved = await resolveTicket(ticket, { relay: opts.relay, crypto });
      pendingOffer = resolved.offer;
      dispatch({ type: "resolved", name: resolved.name, fingerprint: resolved.fingerprint, handle: resolved.handle });
    } catch (err) {
      const { code, message } = classifyError(/** @type {Error} */ (err));
      dispatch({ type: "resolveFailed", code, message });
    }
  }

  async function onConfirm() {
    if (state.kind !== "confirm" || !pendingOffer) return;
    const offer = pendingOffer;
    dispatch({ type: "confirm" });
    try {
      const name = await deviceName();
      const result = await pairOffer(offer, { name, about: { kind: "web" }, crypto });
      pendingOffer = null;
      dispatch({ type: "paired", box: result.name, deviceName: name });
      renderAvatar(offer.box);
      celebrate();
    } catch (err) {
      pendingOffer = null;
      const { code, message } = classifyError(/** @type {Error} */ (err));
      dispatch({ type: "pairFailed", code, message });
    }
  }

  function onNotThisOne() {
    pendingOffer = null;
    dispatch({ type: "notThisOne" });
    startCamera();
  }

  function startCamera() {
    scan?.stop();
    scan = startScan({
      video,
      onFound,
      onError: (err) => dispatch({ type: "resolveFailed", code: /** @type {any} */ (err).code || "camera", message: err.message }),
    });
  }

  /** Renders the SAME avatar (user's own instruction, 2026-09-28 - not a camera crop) from the
   * verified box key; the camera crop from scan.js is what's shown until/unless this succeeds,
   * and stays if this throws (a rendering bug should never blank the success moment). */
  async function renderAvatar(/** @type {Uint8Array} */ boxKey) {
    try {
      const svg = await renderPersonAvatar(boxKey);
      const img = el.querySelector(".scan-avatar");
      if (img) img.outerHTML = svg.replace("<svg", '<svg class="scan-avatar"');
    } catch {} // cameraAvatarUrl (already rendered) stands in
  }

  /** The success dance (msDone hop + confetti, under 1.2s, the same motion launch's Deck-side
   * screen uses) then the redirect to the person's own <handle>.vyre.run - only when tailnet's
   * resolve handed one back; otherwise stays on the done screen (team-lead, 2026-09-28). */
  function celebrate() {
    const img = el.querySelector(".scan-avatar");
    if (img && !reducedMotion()) {
      img.classList.add("ms-done");
      spawnConfetti(/** @type {HTMLElement} */ (img.parentElement || img));
    }
    if (state.kind === "done" && state.handle) {
      const handle = state.handle;
      window.setTimeout(() => { location.href = `https://${handle}.vyre.run`; }, reducedMotion() ? 300 : 1100);
    }
  }

  function spawnConfetti(/** @type {HTMLElement} */ host) {
    const colors = ["#C6F36B", "#F6D186", "#E8A6C7", "#9FD8C8"];
    for (let i = 0; i < 7; i++) {
      const bit = h("span", { class: "confetti-bit" });
      const angle = Math.random() * Math.PI * 2, dist = 22 + Math.random() * 26;
      bit.style.setProperty("--cx", (Math.cos(angle) * dist).toFixed(1) + "px");
      bit.style.setProperty("--cy", (Math.sin(angle) * dist - 10).toFixed(1) + "px");
      bit.style.setProperty("--cr", (Math.random() * 240 - 120).toFixed(0) + "deg");
      bit.style.background = colors[i % colors.length];
      host.appendChild(bit);
      window.setTimeout(() => bit.remove(), 700);
    }
  }

  function render() {
    if (state.kind === "scanning") {
      put(status, "Point your camera at the code on your Mac or your box.");
      put(actions);
    } else if (state.kind === "resolving") {
      put(status, "Reading the code…");
      put(actions);
    } else if (state.kind === "confirm") {
      put(status, h("div", null, "Pair with ", h("b", null, state.name), "?"), h("div", { class: "small faint" }, "Code ", state.fingerprint));
      put(actions,
        h("button", { type: "button", class: "btn btn-primary", onclick: onConfirm }, "Pair"),
        h("button", { type: "button", class: "btn btn-ghost", onclick: onNotThisOne }, "Not this one"));
    } else if (state.kind === "pairing") {
      put(status, "Pairing…");
      put(actions);
    } else if (state.kind === "done") {
      const avatar = cameraAvatarUrl
        ? h("img", { class: "scan-avatar", src: cameraAvatarUrl, alt: "" })
        : h("div", { class: "scan-avatar scan-avatar-fallback" }, icon("check", 24));
      put(status, avatar, h("div", null, icon("check", 14), " Paired with ", h("b", null, state.box), " as ", h("b", null, state.deviceName), "."),
        h("div", { class: "small faint" }, "Code ", state.fingerprint, ". Not you? Remove it in Settings, Devices."));
      put(actions);
    } else if (state.kind === "error") {
      put(status, h("span", { class: "pair-err" }, state.message));
      put(actions, state.retryable ? h("button", { type: "button", class: "btn btn-primary", onclick: () => { dispatch({ type: "retry" }); startCamera(); } }, "Scan again") : null);
    }
  }

  return {
    el,
    open() { state = initial(); pendingOffer = null; cameraAvatarUrl = null; render(); startCamera(); },
    close() { scan?.stop(); scan = null; pendingOffer = null; },
  };
}
