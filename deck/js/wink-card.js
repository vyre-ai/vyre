// @ts-check
// Wink's card: the live Vyre code ring, shared between onboarding's devices step and
// Settings > Devices (one card, two homes; deck/css/phone-code.css is the shared stylesheet).
// The ring draws relay.pair.ticket's raw secret while it's live (deck/js/phone-code.js), so this
// module is built around reviewer's pre-review points (relayed by the lead, 28 Sep), not just
// the visual mechanics:
//  1. Minted only on an explicit tap ("Add a device"), never on render/page load; no auto-mint
//     loop — `every(tick, 1000)` only ever toggles state and redraws an ALREADY-minted ticket.
//  2. Blanks to the idle avatar (no ticks) on document hidden, window blur, expiry and
//     redemption — the SVG node is replaced (dom.js's put()/replaceChildren), never just
//     display:none'd.
//  3. The ticket lives only in this closure's `ticket` variable, for one tap's pairing attempt:
//     never a URL, localStorage/sessionStorage, console, a log or an analytics event. Cleared
//     outright on redemption or Remove, not just stopped from being drawn.
//  4. One ticket shown at a time: Refresh/Add-another mints a fresh one and drops the old ring.
//     tailnet: an old, unredeemed ticket is simply left to expire server-side (not invalidated)
//     — this UI just never displays or tracks more than one at once.
//  5. After pairing: the device's own name (inline-renameable) and key fingerprint, plus a
//     one-tap Remove (relay.devices.remove).
import { h, put } from "./dom.js";
import { icon } from "./icons.js";
import { UNCONFIRMED_MS, UNCONFIRMED_LINE, ticketRingSvg, ticketPhase, countdown, playDance, idleAvatarSvg } from "./phone-code.js";

const parser = new DOMParser();
// pwa's committed route for pairScanSheet() (28 Sep, not yet a real page — an exported function
// only — but this is the path they're pointing phone.vyre.run at).
const SCAN_LINE = "Open phone.vyre.run/pair/scan on your phone and Wink to connect.";
/** SVG markup -> a real node (the Deck's own rule, deck/js/dom.js: no innerHTML). @param {string} src */
const parseSvg = src => /** @type {SVGElement} */ (document.importNode(parser.parseFromString(src, "image/svg+xml").documentElement, true));

/**
 * @param {{
 *   attempt: (name: string, input?: any, opts?: any) => Promise<{ data?: any, error?: any }>,
 *   subscribe: (event: string, fn: (e: any) => void) => void,
 *   every: (fn: () => void, ms: number) => void,
 *   cleanup: (fn: () => void) => void,
 *   calm: () => boolean,
 *   alive?: () => boolean,
 *   onNext?: (() => void) | null,
 * }} deps
 */
export function buildWinkCard({ attempt, subscribe, every, cleanup, calm, alive = () => true, onNext = null }) {
  let mintedAt = 0, ttlMs = 5 * 60_000, ticket = "", shown = false, focused = true, ringDrawn = false, unconfirmed = false;

  const ringEl = h("div", { class: "phone-code-ring", "aria-live": "polite" });
  const setRing = (/** @type {SVGElement} */ node) => put(ringEl, node);
  setRing(parseSvg(idleAvatarSvg({ size: 280 })));

  const meta = h("div", { class: "phone-code-meta" });
  const refreshBtn = h("button", { class: "btn", type: "button" }, "Refresh");
  const startBtn = h("button", { class: "btn btn-primary", type: "button" }, "Add a device");
  const body = h("div", { class: "phone-code-body" }, ringEl,
    h("p", { class: "small muted" }, SCAN_LINE), meta);
  put(meta, startBtn);

  const visible = () => focused && document.visibilityState !== "hidden";

  const blank = () => {
    ringDrawn = false;
    ringEl.classList.remove("shimmer", "expiring", "expired");
    setRing(parseSvg(idleAvatarSvg({ size: 280 })));
  };
  const drawRing = () => {
    if (!ticket) { blank(); return; }
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    setRing(parseSvg(ticketRingSvg(ticket, { theme })));
    ringDrawn = true;
  };
  const mint = async () => {
    const r = await attempt("relay.pair.ticket", {}, { presence: "asked" });
    if (!alive()) return; // the section unmounted while the presence prompt was pending
    mintedAt = Date.now();
    // Reviewer's MEDIUM: ringDrawn is only ever cleared by blank(). Left true across a fresh
    // mint, tick()'s `if (!ringDrawn) drawRing()` never fires again, so Refresh (a live ring
    // already drawn) kept showing the OLD ring under the new countdown, and "Add another
    // device" (ringEl re-attached still holding the just-REDEEMED ring, since showConnected
    // never blanked it either, see below) never drew the new ticket at all. A fresh mint
    // always needs a fresh draw, whether it lands a ticket or comes back empty.
    blank();
    unconfirmed = r.data?.confirmed === false; // an older relay never acknowledges a registration
    if (r.data?.ticket) { ticket = r.data.ticket; ttlMs = Math.max(0, (r.data.expiresAt ?? mintedAt + ttlMs) - mintedAt); }
    else ticket = ""; // a declined passkey, or the tool is still unmerged: nothing real to draw yet
  };
  const tick = () => {
    if (!shown || !alive()) return;
    const { phase, msLeft } = ticketPhase(mintedAt, ttlMs);
    if (phase === "expired") {
      ticket = ""; // spent; never redrawable
      blank();
      put(meta, [h("p", { class: "small muted" }, "This code expired."), refreshBtn]);
      return;
    }
    if (!visible()) {
      blank(); // still holds `ticket` in memory; redraws once visible again, no re-mint needed
      put(meta, h("p", { class: "small muted" }, "Paused while this isn't in view."));
      return;
    }
    ringEl.classList.toggle("shimmer", phase === "live" && !calm());
    ringEl.classList.toggle("expiring", phase === "expiring");
    if (!ringDrawn) drawRing();
    put(meta, h("p", { class: "small muted" }, `Expires in ${countdown(msLeft)}`),
      unconfirmed && Date.now() - mintedAt > UNCONFIRMED_MS ? h("p", { class: "small muted" }, UNCONFIRMED_LINE) : null);
  };

  const start = async () => {
    shown = true;
    put(body, ringEl, h("p", { class: "small muted" }, SCAN_LINE), meta);
    put(meta, h("span", { class: "busy" }));
    // Reviewer's LOW: blank before the mint's own Touch ID/passkey prompt, not only after it
    // resolves, so a re-attached ringEl (Add another device, right after showConnected) or any
    // other stale content never shows for as long as the prompt is up.
    blank();
    await mint();
    if (alive()) tick();
  };
  startBtn.addEventListener("click", start);
  refreshBtn.addEventListener("click", async () => { put(meta, h("span", { class: "busy" })); blank(); await mint(); if (alive()) tick(); });

  // Reviewer's #2: hidden/blurred blanks the ring at once, not on the next 1s tick.
  const onVisChange = () => { if (shown) tick(); };
  document.addEventListener("visibilitychange", onVisChange);
  const onBlur = () => { focused = false; if (shown) tick(); };
  const onFocus = () => { focused = true; if (shown) tick(); };
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  cleanup(() => {
    document.removeEventListener("visibilitychange", onVisChange);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
  });

  const showConnected = (/** @type {string} */ deviceId, /** @type {string} */ initialName, /** @type {string|null} */ fingerprint) => {
    shown = false;
    ticket = ""; // redeemed: gone from memory, not just off-screen
    // Reviewer's LOW on the MEDIUM fix: ringDrawn=false alone left ringEl itself still holding
    // the just-redeemed ring's markup (only the NEXT drawRing() call would replace it), so
    // ringEl showed the spent ring the moment it was re-attached, for as long as the following
    // mint()'s Touch ID/passkey prompt was up. blank() replaces the SVG node outright, matching
    // "blank on use", not only "blank on the next draw".
    blank();
    const nameIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", value: initialName, "aria-label": "Device name" }));
    let saved = initialName;
    const save = async () => {
      const v = nameIn.value.trim();
      if (!v || v === saved) return;
      const r = await attempt("relay.devices.rename", { id: deviceId, name: v });
      if (!r.error) saved = v;
    };
    nameIn.addEventListener("blur", save);
    nameIn.addEventListener("keydown", e => { if (e.key === "Enter") nameIn.blur(); });
    const removeBtn = h("button", { class: "btn", type: "button" }, "Remove");
    removeBtn.addEventListener("click", async () => {
      const r = await attempt("relay.devices.remove", { id: deviceId }, { presence: "asked" });
      if (!r.error && alive()) resetToStart();
    });
    const anotherBtn = h("button", { class: onNext ? "btn" : "btn btn-primary", type: "button" }, onNext ? "Connect another device" : "Add another device");
    anotherBtn.addEventListener("click", start);
    put(body,
      h("div", { class: "phone-code-connected", role: "status" },
        icon("check", 20),
        h("div", null,
          h("p", { class: "h3", style: { margin: "0 0 4px" } }, "Your phone is connected."),
          fingerprint ? h("p", { class: "small muted mono" }, fingerprint) : null,
          h("div", { class: "field" }, nameIn))),
      h("div", { class: "phone-code-actions" },
        onNext ? h("button", { class: "btn btn-primary", type: "button", onclick: onNext }, "Next step") : null,
        anotherBtn, removeBtn));
  };

  const resetToStart = () => {
    blank();
    put(body, ringEl, h("p", { class: "small muted" }, SCAN_LINE), meta);
    put(meta, startBtn);
  };

  subscribe("relay.paired", async (/** @type {any} */ e) => {
    // Only react while this card is actively offering a ticket (tapped, not yet redeemed):
    // a stray relay.paired before "Add a device" was ever pressed here shouldn't pop this
    // card's celebration. Once shown, Refresh mid-flight is still fine to react to (tailnet:
    // an old ticket redeeming after a newer one was minted is expected, not invalidated).
    if (!shown) return;
    await playDance(ringEl, calm());
    showConnected(e.payload?.device, e.payload?.name || "A device", e.payload?.fingerprint || null);
  });
  every(tick, 1000);

  return h("section", { class: "dev-card", "aria-labelledby": "wink-h" },
    h("div", { class: "lbl" }, "Wink"),
    h("h2", { class: "h3", id: "wink-h" }, "Wink to connect"),
    body);
}
