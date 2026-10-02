// @ts-check
// Wink's card: the live Vyre code ring, shared between onboarding's devices step and
// Settings > Devices (one card, two homes; deck/css/phone-code.css is the shared stylesheet).
// The ring draws relay.pair.ticket's raw secret while it's live (deck/js/phone-code.js), so this
// module is built around reviewer's pre-review points (relayed by the lead, 28 Sep), not just
// the visual mechanics:
//  1. Minted only on an explicit tap ("Add a device"), never on render/page load. After that tap the
//     card keeps a code fresh for the person who is looking at it (RENEW below): a new one in the last
//     30 seconds, or when they come back to a code that has run out, so a second scan (the iPhone's
//     install-then-scan) always finds a live ring. Only while this is in view and focused, never with
//     no proof if the server wants one (then a plain Refresh, as before), at most MAX_RENEWS in a row.
//     Everything else in `every(tick, 1000)` only toggles state and redraws an ALREADY-minted ticket.
//  2. Blanks to the idle avatar (no ticks) on document hidden, window blur, expiry and
//     redemption — the SVG node is replaced (dom.js's put()/replaceChildren), never just
//     display:none'd.
//  3. The ticket lives only in this closure's `ticket` variable, for one tap's pairing attempt:
//     never a URL, localStorage/sessionStorage, console, a log or an analytics event. Cleared
//     outright on redemption or Remove, not just stopped from being drawn.
//  4. One ticket shown at a time: Refresh/Add-another mints a fresh one and drops the old ring.
//     tailnet: an old, unredeemed ticket is simply left to expire server-side (not invalidated)
//     — this UI just never displays or tracks more than one at once.
//  5. A pairing window (platform's seven conditions; tools by tailnet): ONE Touch ID opens a window (relay.pair.window.open) and
//     the card keeps it alive: a ping every pingEveryMs (15 s) while the card is in view and focused (nothing when it is not:
//     30 s of silence closes it), a renewal with the window id (no proof; the previous ticket dies at the relay) in the last
//     30 seconds of a code. A phone that redeems is held, not enrolled: pairing.requested shows "A phone is pairing: <name>,
//     <fingerprint>" with Confirm and "Not you? Close", and only Confirm (relay.pair.window.confirm) enrols it. A server without the
//     window tools answers no `window`: the card then behaves as before (a proof per code, a plain Refresh).
//  6. After pairing: the device's own name (inline-renameable) and key fingerprint, plus a
//     one-tap Remove (relay.devices.remove).
import { h, put } from "./dom.js";
import { icon } from "./icons.js";
import { UNCONFIRMED_MS, UNCONFIRMED_LINE, ticketRingSvg, ticketPhase, countdown, playDance, idleAvatarSvg } from "./phone-code.js";

/** How many codes in a row this card renews by itself before it asks for a tap: about half an hour. */
const MAX_RENEWS = 6;
const parser = new DOMParser();
// wink.vyre.run is the camera page (relay/wink); phone.vyre.run redirects to it.
const SCAN_LINE = "Open wink.vyre.run on your phone and scan this code. On an iPhone, add Vyre to your Home Screen first.";
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
  // RENEW: set by an explicit tap (start, Refresh), cleared by Remove, a redemption and leaving. renews counts the
  // automatic ones since the last tap; needsTap says the server wanted a proof, so the person taps Refresh.
  let armed = false, renews = 0, renewing = false, needsTap = false;
  // The pairing window: its id (empty when the server has none), the ping cadence, when the last ping went, and a phone waiting for Confirm.
  let win = "", pingMs = 15_000, lastPing = 0, pinging = false;
  /** @type {{ device: string, name: string, fingerprint: string } | null} */ let pendingPhone = null;
  const WINDOW_MAX_RENEWS = 40;

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
  /** Close the window we hold (fire and forget, no proof): leaving, Remove, a reset. */
  const closeWindow = () => { const id = win; win = ""; pendingPhone = null; if (id) attempt("relay.pair.window.close", { window: id }).catch(() => {}); };
  const mint = async () => {
    // One Touch ID opens a window and its first code. A server that has no window tools answers without a window id: one proof per code, as before.
    if (win) closeWindow();
    let r = await attempt("relay.pair.window.open", {}, { presence: "asked" });
    if (!alive()) return; // the section unmounted while the presence prompt was pending
    if (r.data?.window) { win = String(r.data.window); pingMs = Math.max(5_000, Number(r.data.pingEveryMs) || 15_000); lastPing = Date.now(); }
    else if (!r.error || r.error.code === "no_such_tool") r = await attempt("relay.pair.ticket", {}, { presence: "asked" }); // a server from before the window
    if (!alive()) return;
    mintedAt = Date.now();
    // Reviewer's MEDIUM: ringDrawn is only ever cleared by blank(). Left true across a fresh
    // mint, tick()'s `if (!ringDrawn) drawRing()` never fires again, so Refresh (a live ring
    // already drawn) kept showing the OLD ring under the new countdown, and "Add another
    // device" (ringEl re-attached still holding the just-REDEEMED ring, since showConnected
    // never blanked it either, see below) never drew the new ticket at all. A fresh mint
    // always needs a fresh draw, whether it lands a ticket or comes back empty.
    blank();
    unconfirmed = r.data?.confirmed === false; // an older relay never acknowledges a registration
    if (r.data?.ticket) { ticket = r.data.ticket; ttlMs = Math.max(0, (r.data.ticketExpiresAt ?? r.data.expiresAt ?? mintedAt + ttlMs) - mintedAt); }
    else ticket = ""; // a declined passkey, or the tool is still unmerged: nothing real to draw yet
  };
  /** A fresh code for the person looking at this card, with no prompt: the old one stays on screen until the new one lands. */
  const renew = async () => {
    if (!armed || renewing || needsTap || !shown || !alive() || renews >= (win ? WINDOW_MAX_RENEWS : MAX_RENEWS) || pendingPhone) return false;
    renewing = true;
    try {
      // In a window: renew with its id (the relay kills the previous ticket). Otherwise no presence asked: a server that wants a proof says so.
      const r = win ? await attempt("relay.pair.window.renew", { window: win }) : await attempt("relay.pair.ticket", {});
      if (!alive() || !shown) return false;
      if (!r.data?.ticket) { needsTap = true; if (win) { win = ""; pendingPhone = null; } return false; }
      renews++;
      mintedAt = Date.now();
      unconfirmed = r.data.confirmed === false;
      ticket = r.data.ticket; ttlMs = Math.max(0, (r.data.ticketExpiresAt ?? r.data.expiresAt ?? mintedAt + ttlMs) - mintedAt);
      blank(); // a fresh mint always redraws (reviewer's MEDIUM above)
      return true;
    } finally { renewing = false; }
  };
  /** The window stays open only for a card someone is looking at: a ping per cadence while in view and focused, none otherwise. */
  const ping = () => {
    if (!win || pinging || !visible() || Date.now() - lastPing < pingMs) return;
    pinging = true; lastPing = Date.now();
    const id = win;
    attempt("relay.pair.window.ping", { window: id }).then(r => {
      if (alive() && win === id && r.error) windowEnded("The pairing window closed.");
    }).catch(() => {}).finally(() => { pinging = false; });
  };
  /** The window is over (the server closed it, or a ping found it gone): nothing is drawn, and a tap on Refresh starts the next. */
  const windowEnded = (/** @type {string} */ line) => {
    win = ""; pendingPhone = null; ticket = ""; armed = false; shown = false; pendingShown = false;
    blank();
    put(meta, [h("p", { class: "small muted" }, line), refreshBtn]);
  };
  let pendingShown = false;
  const showPending = () => {
    if (!pendingPhone) return;
    const p = pendingPhone, id = win;
    ticket = ""; blank(); // the ring is spent the moment a phone has redeemed it
    pendingShown = true;
    const confirmBtn = h("button", { class: "btn btn-primary", type: "button" }, "Confirm");
    const notNow = h("button", { class: "btn", type: "button" }, "Not you? Close");
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true; notNow.disabled = true;
      const r = await attempt("relay.pair.window.confirm", { window: id, device: p.device }); // no proof: the window's one Touch ID covers it
      if (alive() && r.error) windowEnded("That phone could not be added. Start again to retry.");
    });
    notNow.addEventListener("click", () => { pendingShown = false; closeWindow(); windowEnded("Nothing was paired."); });
    put(meta, h("div", { class: "phone-code-pending", role: "alertdialog", "aria-label": "A phone is pairing" },
      h("p", { class: "h3", style: { margin: "0 0 4px" } }, "A phone is pairing"),
      h("p", { class: "small" }, p.name), h("p", { class: "small muted mono" }, p.fingerprint),
      h("p", { class: "small muted" }, "Confirm only if this is your phone and the code matches what it shows."),
      h("div", { class: "phone-code-actions" }, confirmBtn, notNow)));
  };
  const tick = () => {
    if (!shown || !alive()) return;
    ping();
    if (pendingPhone) { if (!pendingShown) showPending(); return; }
    const { phase, msLeft } = ticketPhase(mintedAt, ttlMs);
    // In view and focused, with a code about to run out (or already out): a new one first, the "expired" line only if that cannot be done.
    if ((phase === "expiring" || phase === "expired") && armed && !needsTap && !renewing && visible() && renews < MAX_RENEWS) {
      renew().then(ok => { if (alive()) { if (!ok && phase === "expired") { ticket = ""; blank(); put(meta, [h("p", { class: "small muted" }, "This code expired."), refreshBtn]); } else tick(); } });
      if (phase === "expired") return;
    }
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
    shown = true; armed = true; renews = 0; needsTap = false; pendingPhone = null; pendingShown = false;
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
  refreshBtn.addEventListener("click", async () => { shown = true; armed = true; renews = 0; needsTap = false; pendingPhone = null; pendingShown = false; put(meta, h("span", { class: "busy" })); blank(); await mint(); if (alive()) tick(); });

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
    closeWindow();
  });

  const showConnected = (/** @type {string} */ deviceId, /** @type {string} */ initialName, /** @type {string|null} */ fingerprint) => {
    shown = false; armed = false; win = ""; pendingPhone = null; pendingShown = false; // the server closed the window when it enrolled the phone
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
    armed = false; shown = false; closeWindow();
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
  // A phone redeemed a window ticket and is held until Confirm; the window may also end on the server's side (completed, silence, expired,
  // renewals, replaced, closed by the screen). Events of another window are not ours.
  subscribe("pairing.requested", (/** @type {any} */ e) => {
    const x = e.payload || {};
    if (!shown || !win || x.window !== win) return;
    pendingPhone = { device: String(x.device || ""), name: String(x.name || "A phone").slice(0, 64), fingerprint: String(x.fingerprint || "").slice(0, 40) };
    pendingShown = false;
    showPending();
  });
  subscribe("pairing-window.closed", (/** @type {any} */ e) => {
    const x = e.payload || {};
    if (!win || x.window !== win) return;
    if (x.reason === "completed") { win = ""; return; } // relay.paired shows the connected panel
    const lines = /** @type {Record<string, string>} */ ({ silence: "The pairing window closed because this screen went quiet.", expired: "The pairing window ran out.", renewals: "The pairing window ran out of codes.", replaced: "A newer pairing window replaced this one." });
    if (shown) windowEnded(lines[x.reason] || "The pairing window closed.");
    else { win = ""; pendingPhone = null; }
  });
  every(tick, 1000);

  return h("section", { class: "dev-card", "aria-labelledby": "wink-h" },
    h("div", { class: "lbl" }, "Wink"),
    h("h2", { class: "h3", id: "wink-h" }, "Wink to connect"),
    body);
}
