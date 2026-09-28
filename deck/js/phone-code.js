// @ts-check
// "Add your phone" (the user's decision, 28 Sep): the person's avatar grows a live Vyre code
// ring (ADR 0043) encoding a one-time pairing ticket. This module is the piece launch owns per
// that ADR's Consequences ("launch renders vyrecode2.js's output on the Deck's pairing screen")
// plus the live/pairing variant app-design flagged as still needed from launch: a shimmer while
// the ticket is valid, and a visible countdown/expiry state once it's stale. Geometry, palette
// and the encode/decode math are app-design's vendored code (deck/vendor/vyrecode/), unchanged;
// everything in this file is launch's own.
//
// tailnet's relay.pair.ticket is built (work/tailnet 2990a810, sent to their reviewer): mint {}
// -> {ticket, expiresAt, connected}. Callers (deck/onboard/onboard.js, deck/views/settings.js)
// pass its `ticket` string straight through as `ticketId` here. Open question, asked, not yet
// answered: `ticketLevels` still runs `ticket` through `fingerprint8` (a one-way hash) rather
// than encoding its raw bytes directly — fine for a permanent public identifier (this module's
// original use), but if phone.vyre.run's decoder needs to recover the literal ticket to redeem
// it, a hash can't be reversed back into one. Flagged so this isn't mistaken for a finished,
// redeemable pairing until that's confirmed either way.
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

const CONFETTI_COLORS = ["#C6F36B", "#F6D186", "#E8A6C7", "#9FD8C8"];
const DANCE_MS = 600, CONFETTI_MS = 650;

/**
 * The avatar's dance on relay.paired, before the connected state (the user, 28 Sep; the shapes
 * are ui-ux's motion prototype, scratchpad/avatar-motion/avatar-motion.html, "goal done": the
 * msDone hop plus a confetti burst, played on the person's own avatar SVG, once, under 700ms —
 * not launch's own invention). `calm` (prefers-reduced-motion) skips all of it for a single
 * still lime dot instead, the prototype's own rule for "done": never a state that survives only
 * in motion. Targets `.vyrecode-face` (the inner group vyrecode2.js wraps the face in
 * specifically so this composes with its outer position/scale rather than overriding it) inside
 * `ringEl`, the already-drawn `.phone-code-ring` element; a caller with no matching face (an
 * unusual ring render, or none yet) still resolves — the dance is decorative, never load-bearing
 * for the connected state that follows it.
 * @param {Element} ringEl @param {boolean} calm
 * @returns {Promise<void>}
 */
export function playDance(ringEl, calm) {
  return new Promise(resolve => {
    if (calm) {
      const dot = document.createElement("span");
      dot.setAttribute("class", "phone-code-done-flag");
      dot.setAttribute("aria-hidden", "true");
      ringEl.append(dot);
      resolve();
      return;
    }
    const face = ringEl.querySelector(".vyrecode-face");
    face?.classList.add("phone-code-ms-done");
    const bits = [];
    for (let i = 0; i < 7; i++) {
      const bit = document.createElement("span");
      bit.setAttribute("class", "phone-code-confetti-bit");
      bit.setAttribute("aria-hidden", "true");
      const angle = Math.random() * Math.PI * 2;
      const dist = 22 + Math.random() * 26;
      const cx = `${(Math.cos(angle) * dist).toFixed(1)}px`, cy = `${(Math.sin(angle) * dist - 10).toFixed(1)}px`, cr = `${(Math.random() * 240 - 120).toFixed(0)}deg`;
      bit.setAttribute("style", `--cx:${cx};--cy:${cy};--cr:${cr};background:${CONFETTI_COLORS[i % CONFETTI_COLORS.length]}`);
      ringEl.append(bit);
      bits.push(bit);
    }
    setTimeout(() => {
      face?.classList.remove("phone-code-ms-done");
      for (const b of bits) b.remove();
      resolve();
    }, Math.max(DANCE_MS, CONFETTI_MS));
  });
}
