// @ts-check
// The camera page's rules, with no DOM and no camera (team/0.2.2/wink-camera.html, wink-registry.md and platform's
// rulings): what state the page is in, what a card may say, and where a confirmed scan goes.
//
//   search -> seen (a ring decoded: a tick) -> handoff (the camera page: no lookup, no card; the app confirms)
//   Card path (a later QR purpose, with its own rules): seen -> locked (the relay record checked out on this phone: a firm double
//   tap) -> card (the result card rises, thumb reach) -> handoff | search (Not now) | error
//   install: an iPhone or iPad in Safari (not the installed app). It never scans: the seed is never read, stored or sent
//   from there (platform ruling 2); the person installs, opens the app and scans again.
//
// Rules written as code here, each with a test (flow.test.js):
//   - Text from a code or a record is DISPLAY text: control and bidi characters stripped, length capped, rendered as
//     text by the page, never as markup (cardOf).
//   - An approval is bound to the exact card shown: a card has an id, a hash of the ticket and the words on it, and a
//     confirm that does not carry the id of the card on screen does nothing (confirm).
//   - A single-use code is burned by the redeem, which happens at the app origin; this page keeps the ticket only in
//     memory and drops it on Not now, on the hand-off and on any error.

/** Where a confirmed scan goes: the hosted app, a constant in this signed page, never read from the code or the record (platform). */
export const APP_ORIGIN = "https://app.vyre.run";

/** @typedef {{ kind: "install" } | { kind: "idle" } | { kind: "search" } | { kind: "seen" } | { kind: "locked", card: Card }
 *   | { kind: "card", card: Card } | { kind: "handoff", card: Card | null } | { kind: "error", code: string, message: string, retryable: boolean }} State */
/** @typedef {{ purpose: "pair.device", id: string, kind: string, who: string, address: string, fingerprint: string, note: string, expires: string, main: string, other: string }} Card */

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]+", "g");
const NAME_MAX = 64;

/** Display text from outside: no control or bidi characters, one line, capped. Never markup (the page uses text nodes). @param {unknown} s @param {string} fallback */
export function inert(s, fallback = "") {
  const t = String(s ?? "").replace(CONTROL, " ").replace(/ {2,}/g, " ").trim().slice(0, NAME_MAX);
  return t || fallback;
}

/**
 * An iPhone or iPad in a browser tab (not an installed Home Screen app): the one place the page does not scan.
 * @param {{ userAgent?: string, platform?: string, maxTouchPoints?: number, standalone?: boolean }} nav @param {boolean} [displayStandalone]
 */
export function needsInstall(nav, displayStandalone = false) {
  const ua = String(nav.userAgent || "");
  const ios = /iPhone|iPad|iPod/.test(ua) || (nav.platform === "MacIntel" && (nav.maxTouchPoints || 0) > 1);
  return ios && !(nav.standalone === true || displayStandalone);
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** The server's own address, shown on the card as a line of its own: a vyre.run name from the record's handle, or nothing. Display only: no page navigates to it (the hand-off is APP_ORIGIN). @param {unknown} handle */
export const addressOf = handle => (typeof handle === "string" && LABEL.test(handle) ? `${handle}.vyre.run` : "");

/** The card for a pairing, from what resolveTicket verified (the box's own sealed record), never from the scanned payload. @param {{ name: string, fingerprint: string, handle?: string | null }} r @param {string} id @returns {Card} */
export function cardOf(r, id) {
  const who = inert(r.name, "a Vyre server");
  return { purpose: "pair.device", id, kind: "Pair this phone", who, address: addressOf(r.handle), fingerprint: inert(r.fingerprint),
    note: `Pairing lets this phone talk to ${who}. You can remove it later in Settings.`, expires: "Single use, five minutes", main: "Pair", other: "Not now" };
}

/**
 * The id a card is bound to: a hash of the ticket (never shown, never kept past the card) and the words on it. A confirm must
 * carry this id; a card that changed between being shown and being confirmed has a different one.
 * @param {Uint8Array} ticket @param {{ name: string, fingerprint: string, handle?: string | null }} r @param {(b: Uint8Array) => Promise<Uint8Array>} sha256
 */
export async function cardId(ticket, r, sha256) {
  const words = new TextEncoder().encode(`${inert(r.name)}\n${inert(r.fingerprint)}\n${addressOf(r.handle)}\n`);
  const all = new Uint8Array(ticket.length + words.length);
  all.set(ticket); all.set(words, ticket.length);
  const d = await sha256(all);
  return Array.from(d.slice(0, 12), x => x.toString(16).padStart(2, "0")).join("");
}

/** base64url, no padding. @param {Uint8Array} b */
export function b64url(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Where a confirmed pairing goes: the app, with the ticket in the fragment (never sent to a server). @param {Uint8Array} ticket */
export const handoffUrl = ticket => `${APP_ORIGIN}/#pair=${b64url(ticket)}`;

/** @param {{ install: boolean }} o @returns {State} */
export const initial = ({ install }) => (install ? { kind: "install" } : { kind: "idle" });

/**
 * @param {State} s
 * @param {{ type: "start" } | { type: "seen" } | { type: "decoded" } | { type: "locked", card: Card } | { type: "shown" } | { type: "notNow" }
 *   | { type: "confirm", id: string } | { type: "failed", code?: string, message: string, retryable?: boolean } | { type: "retry" }} e
 * @returns {State}
 */
export function step(s, e) {
  if (s.kind === "install") return s; // an install page never turns into a scanner
  switch (e.type) {
    case "start": return s.kind === "idle" || s.kind === "error" ? { kind: "search" } : s;
    case "seen": return s.kind === "search" ? { kind: "seen" } : s;
    // A ring decoded on the camera page: no lookup and no card there (the app's card is the only confirm), straight to the hand-off.
    case "decoded": return s.kind === "search" || s.kind === "seen" ? { kind: "handoff", card: null } : s;
    case "locked": return s.kind === "seen" || s.kind === "search" ? { kind: "locked", card: e.card } : s;
    case "shown": return s.kind === "locked" ? { kind: "card", card: s.card } : s;
    case "notNow": return s.kind === "card" || s.kind === "locked" ? { kind: "search" } : s;
    case "confirm": return s.kind === "card" && s.card.id === e.id ? { kind: "handoff", card: s.card } : s;
    case "failed": return { kind: "error", code: e.code || "error", message: inert(e.message, "Something went wrong."), retryable: e.retryable !== false };
    case "retry": return s.kind === "error" ? { kind: "search" } : s;
    default: return s;
  }
}
