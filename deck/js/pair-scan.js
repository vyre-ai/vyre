// @ts-check
// Scan your avatar to pair your phone: the DOM wiring. deck/views/pair-scan.js has the pure
// state machine; deck/js/scan.js has the camera+decoder; deck/js/pair-ticket.js has the crypto
// and the relay handshake. This file is the sheet that shows one for the other.
//
// Flow (docs/work/pwa.md's "Phone-side contract" has the full writeup, for launch's Deck-side
// screen): the Deck's "Add your phone" shows the person's avatar in a live code ring encoding a
// one-time ticket. Here: the camera reads it (scan.js), the ticket is resolved to a box identity
// WITHOUT the ticket itself ever leaving the phone (pair-ticket.js derives a locator instead -
// reviewer's HIGH 1 on work/pwa bdca618b), the phone verifies the box's record and computes the
// fingerprint itself (reviewer's HIGH 2 - never trust a server-supplied one), the person confirms
// ("Pair with <box> (<fingerprint>)?", with an editable device name sent along), then the
// handshake runs (relay/client/client.js's pair(), the same library the Expo app uses - no
// presence/Touch ID call from the phone; that gate is at mint time on the box, per reviewer).
// On success: the person's avatar (a photo of the one just scanned, not redrawn) does a short
// celebratory dance, then redirects to their own <handle>.vyre.run (team-lead, 2026-09-28).

import { h, put } from "./dom.js";
import { icon } from "./icons.js";
import { startScan } from "./scan.js";
import { resolveTicket, completePairing } from "./pair-ticket.js";
import { attempt } from "./api.js";
import { initial, step } from "../views/pair-scan.js";

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/pair.css" }));
}

const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

/** The default device name: the person's first name (system.info owner.name) plus the model
 * (User-Agent Client Hints - Android usually gives it, e.g. "Pixel 8"; iOS Safari doesn't
 * support UA-CH at all and falls back to a plain "iPhone"/"iPad"). Editable on the confirm
 * screen; this is only ever the pre-filled suggestion (team-lead, 2026-09-28). */
async function defaultDeviceName() {
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
 * @returns {{ el: HTMLElement, open: () => void, close: () => void }}
 */
export function pairScanSheet() {
  style();
  let state = initial();
  /** @type {{ stop: () => void } | null} */ let scan = null;
  /** @type {string | null} */ let avatarUrl = null;
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

  async function onFound(/** @type {Uint8Array} */ t, /** @type {string | null} */ avatarDataUrl) {
    avatarUrl = avatarDataUrl;
    dispatch({ type: "found" });
    try {
      const [resolved, name] = await Promise.all([resolveTicket(t), defaultDeviceName()]);
      dispatch({ type: "resolved", box: resolved.box, fingerprint: resolved.fingerprint, handle: resolved.handle, defaultName: name });
      /** @type {any} */ (el)._offer = resolved.offer; // handed to completePairing on confirm
    } catch (err) {
      dispatch({ type: "resolveFailed", code: /** @type {any} */ (err).code, message: /** @type {Error} */ (err).message });
    }
  }

  async function onConfirm() {
    if (state.kind !== "confirm") return;
    const { name } = state;
    const offer = /** @type {any} */ (el)._offer;
    dispatch({ type: "confirm" });
    try {
      const r = await completePairing(offer, { name });
      dispatch({ type: "paired", box: r?.name });
      celebrate();
    } catch (err) {
      dispatch({ type: "pairFailed", code: /** @type {any} */ (err).code, message: /** @type {Error} */ (err).message });
    }
  }

  function startCamera() {
    scan?.stop();
    scan = startScan({
      video,
      onFound,
      onError: (err) => dispatch({ type: "resolveFailed", code: /** @type {any} */ (err).code || "camera", message: err.message }),
    });
  }

  /** The success dance (msDone hop + confetti, under 1.2s, the same motion launch's Deck-side
   * screen uses) then the redirect to the person's own <handle>.vyre.run. Skips the redirect
   * (stays on the done screen) when there's no handle yet - PENDING tailnet, see pair-ticket.js. */
  function celebrate() {
    if (state.kind !== "done") return;
    const { handle } = state;
    const img = el.querySelector(".scan-avatar");
    if (img && !reducedMotion()) {
      img.classList.add("ms-done");
      spawnConfetti(/** @type {HTMLElement} */ (img.parentElement || img));
    }
    if (handle) {
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
      const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", value: state.name, "aria-label": "Name this device",
        oninput: () => dispatch({ type: "rename", name: nameIn.value }) }));
      put(status, h("div", null, "Pair with ", h("b", null, state.box), "?"), h("div", { class: "small faint" }, "Code ", state.fingerprint),
        h("label", { class: "lbl", style: "margin-top:8px;display:block;" }, "Name this device", nameIn));
      put(actions,
        h("button", { type: "button", class: "btn btn-primary", onclick: onConfirm }, "Pair"),
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => { dispatch({ type: "retry" }); startCamera(); } }, "Not this one"));
    } else if (state.kind === "pairing") {
      put(status, "Pairing…");
      put(actions);
    } else if (state.kind === "done") {
      const avatar = avatarUrl
        ? h("img", { class: "scan-avatar", src: avatarUrl, alt: "" })
        : h("div", { class: "scan-avatar scan-avatar-fallback" }, icon("check", 24));
      put(status, avatar, h("div", null, icon("check", 14), " Paired with ", h("b", null, state.box), " as ", h("b", null, state.name), "."));
      put(actions);
    } else if (state.kind === "error") {
      put(status, h("span", { class: "pair-err" }, state.message));
      put(actions, state.retryable ? h("button", { type: "button", class: "btn btn-primary", onclick: () => { dispatch({ type: "retry" }); startCamera(); } }, "Scan again") : null);
    }
  }

  return {
    el,
    open() { state = initial(); avatarUrl = null; render(); startCamera(); },
    close() { scan?.stop(); scan = null; },
  };
}
