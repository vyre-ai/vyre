// @ts-check
// "Add your phone" (the user's decision, 28 Sep): the person's avatar grows a live Vyre code
// ring (ADR 0033) encoding a one-time pairing ticket. This module is the piece launch owns per
// that ADR's Consequences ("launch renders vyrecode2.js's output on the Deck's pairing screen")
// plus the live/pairing variant app-design flagged as still needed from launch: a shimmer while
// the ticket is valid, and a visible countdown/expiry state once it's stale. Geometry, palette
// and the encode/decode math are app-design's vendored code (deck/vendor/vyrecode/), unchanged;
// everything in this file is launch's own.
//
// Not yet wired to a real ticket: tailnet's relay.pair.ticket mint call doesn't exist yet (asked,
// see docs/work/launch-surfaces.md "Add your phone"). Callers pass whatever string the real call
// eventually returns as `ticketId` — this module only needs a stable string to fingerprint, the
// same as any other seed elsewhere in the Deck (deck/js/pair.js, etc).
import { fingerprint8, buildCodeword, bytesToBits } from "../vendor/vyrecode/payload.js";
import { renderCode2, bitsToLevels } from "../vendor/vyrecode/vyrecode2.js";

/** The 72-level payload for one ticket id, ready for renderCode2. @param {string} ticketId @returns {Promise<number[]>} */
export async function ticketLevels(ticketId) {
  const id8 = await fingerprint8(String(ticketId));
  const codeword = buildCodeword(id8);
  return bitsToLevels(bytesToBits(codeword));
}

/**
 * The ring's SVG markup for one ticket. `userOption`/`theme` match the person's own avatar so the
 * ring reads as "the same identity," per the ADR's "same hand" rule.
 * @param {string} ticketId
 * @param {{ userOption?: number, theme?: "dark"|"light", size?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function ticketRingSvg(ticketId, { userOption = 0, theme = "dark", size = 280 } = {}) {
  const levels = await ticketLevels(ticketId);
  return renderCode2(levels, { userOption, style: "ticksSunburst", theme, size });
}

/**
 * The ticket's own state, from when it was minted and how long it lives. `phase` drives the
 * ring's look: "live" shimmers, "expiring" (the last 30s, the user's countdown getting real)
 * drops the shimmer for an urgent countdown, "expired" dims the ring and offers only Refresh.
 * @param {number} mintedAt @param {number} ttlMs @param {number} [now]
 * @returns {{ phase: "live"|"expiring"|"expired", msLeft: number }}
 */
export function ticketPhase(mintedAt, ttlMs, now = Date.now()) {
  const msLeft = Math.max(0, mintedAt + ttlMs - now);
  if (msLeft <= 0) return { phase: "expired", msLeft: 0 };
  if (msLeft <= 30_000) return { phase: "expiring", msLeft };
  return { phase: "live", msLeft };
}

/** "4:59", "0:03", ... never negative, always two digits of seconds. @param {number} msLeft */
export function countdown(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
