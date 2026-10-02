// @ts-check
// The camera page's DOM (wink.js wires the real camera, relay and navigation into it; page.test.js wires fakes). One screen:
// the camera feed, brackets that lock on a ring, a torch, and a result card that rises into thumb reach with the main action
// biggest, bottom right (team/0.2.2/wink-camera.html). The rules are in flow.js.
//
// Haptics, system patterns only: a tick when a ring decodes, a firm double tap when its record checks out on this phone,
// a success when the hand-off starts, a warning on a refusal. iPhone and iPad in Safari get the install card and nothing else.

import { h, put } from "../../deck/js/dom.js";
import { classifyError } from "../../deck/js/pair-ticket.js";
import { initial, step, needsInstall, cardOf, cardId, handoffUrl } from "./flow.js";

/**
 * @typedef {{ nav: any, standalone?: boolean, relay: string, crypto: any,
 *   startScan: (o: { video: HTMLVideoElement, onFound: (ticket: Uint8Array) => void, onError: (e: Error) => void, onSlow?: () => void }) => { stop: () => void },
 *   resolveTicket: (ticket: Uint8Array, o: { relay: string, crypto: any }) => Promise<{ name: string, fingerprint: string, handle?: string | null }>,
 *   sha256: (b: Uint8Array) => Promise<Uint8Array>, haptic: (k: "tick" | "success" | "warning") => unknown,
 *   navigate: (url: string) => void, later?: (fn: () => void, ms: number) => unknown, appHref?: string }} Deps
 */

const SVG = {
  torch: '<path d="M9 2h6l-1 6h-4zM10 8v13a2 2 0 0 0 4 0V8"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/>',
  plus: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/>',
  open: '<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
/** A constant icon drawing (never text from outside): the only markup this page parses. @param {keyof typeof SVG} k @param {number} [size] */
function icon(k, size = 22) {
  const wrap = document.createElement("span");
  wrap.setAttribute("class", "ic");
  wrap.setAttribute("aria-hidden", "true");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG[k]}</svg>`;
  return wrap;
}

/**
 * @param {HTMLElement} root @param {Deps} d
 * @returns {{ stop: () => void, state: () => import("./flow.js").State }}
 */
export function mountWink(root, d) {
  const later = d.later || ((fn, ms) => setTimeout(fn, ms));
  const install = needsInstall(d.nav, !!d.standalone);
  let state = initial({ install });
  /** The ticket and the verified record: in this closure only, dropped on Not now, on the hand-off and on any error. @type {{ ticket: Uint8Array, record: { name: string, fingerprint: string } } | null} */
  let pending = null;
  /** @type {{ stop: () => void } | null} */ let scan = null;
  let slow = false;
  let torchOn = false;

  if (install) {
    // The one place nothing starts: no camera, no lookup, no storage, no hand-off. The person installs the app and scans there.
    put(root, h("section", { class: "install", "aria-label": "Add Vyre to your Home Screen" },
      h("h2", { class: "install-title" }, "Add Vyre to your Home Screen"),
      h("ol", { class: "steps" },
        h("li", null, icon("share", 26), h("span", null, "Share")),
        h("li", null, icon("plus", 26), h("span", null, "Add to Home Screen")),
        h("li", null, icon("open", 26), h("span", null, "Open Vyre"))),
      h("p", { class: "install-line" }, "Then scan the code again, inside the app."),
      h("a", { class: "btn btn-primary", href: d.appHref || "https://app.vyre.run/" }, "Open Vyre in Safari")));
    return { stop() {}, state: () => state };
  }

  const video = /** @type {HTMLVideoElement} */ (h("video", { class: "cam-feed", playsinline: true, muted: true, "aria-hidden": "true" }));
  const hint = h("p", { class: "cam-hint", role: "status" }, "Point at a Wink");
  const reticle = h("div", { class: "reticle", "aria-hidden": "true" }, h("i", { class: "c tl" }), h("i", { class: "c tr" }), h("i", { class: "c bl" }), h("i", { class: "c br" }));
  const torch = h("button", { type: "button", class: "pillbtn", "aria-label": "Torch", "aria-pressed": "false", hidden: true, onclick: () => toggleTorch() }, icon("torch"));
  const sheet = h("section", { class: "sheet", role: "dialog", "aria-modal": "false", "aria-label": "Result" });
  const done = h("div", { class: "done", role: "status" });
  const cam = h("div", { class: "cam", "data-state": state.kind }, video,
    h("header", { class: "cam-top" }, h("h1", { class: "cam-title" }, "Wink"), torch), reticle, hint, sheet, done);
  put(root, cam);

  /** @param {Parameters<typeof step>[1]} e */
  function dispatch(e) { state = step(state, e); cam.setAttribute("data-state", state.kind); }

  function startCamera() {
    scan?.stop();
    slow = false;
    sheet.classList.remove("up"); put(sheet);
    reticle.setAttribute("class", "reticle"); done.setAttribute("class", "done");
    put(hint, "Point at a Wink"); hint.hidden = false;
    dispatch({ type: "start" });
    scan = d.startScan({ video, onFound, onError: e => fail(e), onSlow: () => { slow = true; if (state.kind === "search") put(hint, "Hold your phone straight on to the screen."); } });
    video.addEventListener("loadedmetadata", probeTorch, { once: true });
    later(probeTorch, 900);
  }

  /** @param {Uint8Array} ticket */
  async function onFound(ticket) {
    dispatch({ type: "seen" });
    reticle.classList.add("found"); put(hint, "Hold still");
    d.haptic("tick");
    try {
      const record = await d.resolveTicket(ticket, { relay: d.relay, crypto: d.crypto });
      const id = await cardId(ticket, record, d.sha256);
      pending = { ticket, record };
      dispatch({ type: "locked", card: cardOf(record, id) });
      reticle.classList.add("locked"); hint.hidden = true;
      d.haptic("success");
      scan?.stop(); scan = null; // the camera is off while a card is up: light by default
      later(showCard, 650);
    } catch (err) { fail(/** @type {Error} */ (err)); }
  }

  function showCard() {
    if (state.kind !== "locked") return;
    const card = state.card;
    dispatch({ type: "shown" });
    // Every word below is a text node (h() never parses markup), and came from cardOf: the record's own name, capped and cleaned.
    put(sheet,
      h("div", { class: "grab" }),
      h("div", { class: "kind" }, card.kind),
      h("h2", { class: "who" }, card.who),
      h("span", { class: "chip" }, card.expires),
      h("p", { class: "note" }, card.note),
      // The server's address, a line of its own (display only: the hand-off goes to app.vyre.run whatever the record says).
      h("p", { class: "addr" }, card.address ? ["Server address ", h("b", null, card.address)] : "This server has no name yet."),
      h("p", { class: "fp" }, "Code ", h("b", null, card.fingerprint), ". Check it matches your Vyre screen."),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn", onclick: notNow }, card.other),
        h("button", { type: "button", class: "btn btn-primary main", onclick: () => confirm(card.id) }, card.main)));
    sheet.classList.add("up");
  }

  function notNow() {
    pending = null;
    dispatch({ type: "notNow" });
    startCamera();
  }

  /** @param {string} id */
  function confirm(id) {
    dispatch({ type: "confirm", id });
    if (state.kind !== "handoff" || !pending) return; // no card on screen, or not this card: nothing happens
    const url = handoffUrl(pending.ticket);
    pending = null; // the ticket lives only in the URL from here
    sheet.classList.remove("up");
    put(done, h("div", { class: "tick" }, icon("check", 34)), h("b", null, "Opening Vyre"), h("p", null, "Finish pairing there."));
    done.classList.add("on");
    d.haptic("success");
    later(() => d.navigate(url), 450);
  }

  /** @param {Error & { code?: string }} err */
  function fail(err) {
    pending = null;
    scan?.stop(); scan = null;
    const c = err && (err.code === "no_camera" || err.code === "camera_ended" || err.name === "NotAllowedError" || err.name === "NotFoundError")
      ? { code: err.code || "camera", message: err.name === "NotAllowedError" ? "Camera access is off. Allow it for this page and try again." : String(err.message || "The camera is not available."), retryable: true }
      : classifyError(err);
    dispatch({ type: "failed", code: c.code, message: c.message, retryable: c.retryable });
    d.haptic("warning");
    sheet.classList.remove("up");
    hint.hidden = true;
    put(sheet, h("div", { class: "grab" }), h("p", { class: "err" }, state.kind === "error" ? state.message : c.message),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary main", onclick: () => { dispatch({ type: "retry" }); startCamera(); } }, "Scan again")));
    sheet.classList.add("up");
  }

  function probeTorch() {
    const track = /** @type {any} */ (video.srcObject)?.getVideoTracks?.()[0];
    const can = !!(track && typeof track.getCapabilities === "function" && track.getCapabilities().torch);
    torch.hidden = !can; // iOS has no torch constraint: no button rather than a dead one
  }
  async function toggleTorch() {
    const track = /** @type {any} */ (video.srcObject)?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      torchOn = !torchOn;
      torch.setAttribute("aria-pressed", String(torchOn));
      cam.classList.toggle("torch", torchOn);
      d.haptic("tick");
    } catch {}
  }

  startCamera();
  return { stop() { pending = null; scan?.stop(); scan = null; }, state: () => state };
}
