// @ts-check
// "Add your phone" (the user's decision, 28 Sep): the person's avatar grows a live Vyre code
// ring (ADR 0043) encoding a one-time pairing ticket. This module is the piece launch owns per
// that ADR's Consequences ("launch renders vyrecode2.js's output on the Deck's pairing screen")
// plus the live/pairing variant app-design flagged as still needed from launch: a shimmer while
// the ticket is valid, and a visible countdown/expiry state once it's stale. Geometry, palette
// and the encode/decode math are app-design's vendored code (lib/wink-code/), unchanged;
// everything in this file is launch's own.
//
// tailnet's relay.pair.ticket is built (work/tailnet 2990a810, sent to their reviewer): mint {}
// -> {ticket, expiresAt, connected}, `ticket` a base64url encoding of TICKET_BYTES=8 random
// bytes (core/relay/wire.js on work/tailnet). Per the lead (28 Sep), while Wink pairing is on
// screen the ring encodes those RAW ticket bytes directly, not a hash of them: the phone decodes
// the same 8 bytes and derives the pairing from them (lib/wink-code/payload.js). This is
// why `ticketLevels` no longer calls `fingerprint8` for a ticket — that one-way hash belongs only
// on a permanent identity avatar outside pairing (not built here), never on the pairing ring
// itself, since a hash can't be reversed back into the literal ticket the phone needs to redeem.
// Security (the lead): treat the ticket as a secret — never logged, never put in a URL, never in
// the DOM as text or a data attribute. Only the drawn SVG (ticksSunburst's tick lengths/marker
// dots) carries it; callers must stop drawing it (swap back to the placeholder/idle state) once
// it expires or a phone redeems it, not go on re-rendering an already-spent or stale ticket.
import { buildCodeword, bytesToBits } from "../../lib/wink-code/payload.js";
import { renderCode2, bitsToLevels } from "../../lib/wink-code/vyrecode2.js";
import { userAvatar } from "../../lib/wink-code/identity.js";

/** A relay.pair.ticket `ticket` string (base64url) to its 8 raw bytes. Any string that doesn't
 * decode to exactly 8 bytes (a placeholder, or a still-mismatched real shape) is coerced by
 * truncating or zero-padding rather than throwing: this ring is never itself the redemption path
 * (the phone still resolves the offer through the relay), so a malformed input degrades to "a
 * ring that draws but won't scan," never a crash. @param {string} s @returns {number[]} */
function ticketToBytes(s) {
  try {
    const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const bytes = Array.from(bin, c => c.charCodeAt(0) & 0xFF);
    if (bytes.length === 8) return bytes;
    return Array.from({ length: 8 }, (_, i) => bytes[i] ?? 0);
  } catch {
    return Array.from({ length: 8 }, (_, i) => s.charCodeAt(i % s.length) & 0xFF);
  }
}

/** The 72-level payload for one ticket, ready for renderCode2. @param {string} ticket @returns {number[]} */
export function ticketLevels(ticket) {
  const codeword = buildCodeword(ticketToBytes(ticket));
  return bitsToLevels(bytesToBits(codeword));
}

/**
 * The ring's SVG markup for one ticket. `userOption`/`theme` match the person's own avatar so the
 * ring reads as "the same identity," per the ADR's "same hand" rule.
 * @param {string} ticket
 * @param {{ userOption?: number, theme?: "dark"|"light", size?: number }} [opts]
 * @returns {string}
 */
export function ticketRingSvg(ticket, { userOption = 0, theme = "dark", size = 280 } = {}) {
  const levels = ticketLevels(ticket);
  const svg = renderCode2(levels, { userOption, style: "ticksSunburst", theme, size });
  // app-design's locked renderer (lib/wink-code) positions the face in one group; the dance
  // needs an untransformed inner group to animate, so it is added here rather than in the vendor copy.
  return svg.replace(/(<g transform="translate\([^)]*\) scale\([^)]*\)">)([\s\S]*)(<\/g>\s*<\/svg>)$/, '$1<g class="vyrecode-face">$2</g>$3');
}

/**
 * The plain avatar, no ring: what a caller shows once a ticket expires or is redeemed, in place
 * of going on displaying its now-spent bits (the lead, 28 Sep — "swap back to the identity").
 * Same `userOption` as the ring it replaces, so the face doesn't visibly change, only the ticks
 * around it disappear. Centred and padded to `size` so it drops into the same ring-shaped slot.
 * @param {{ userOption?: number, size?: number }} [opts]
 * @returns {string}
 */
export function idleAvatarSvg({ userOption = 0, size = 280 } = {}) {
  const d = Math.round(size * 0.6); // matches the ring's own FACE_D:CENTER*2 ratio (360:600)
  const face = userAvatar(userOption, d);
  // Same viewBox-aware scaling renderCode2 does for the ring's own face (userAvatar always draws
  // into its native 0 0 120 120 regardless of the width/height passed to it).
  const faceViewBox = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(face);
  const faceNativeW = faceViewBox ? parseFloat(faceViewBox[1]) : d;
  const scale = d / faceNativeW;
  const inset = (size - d) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <g transform="translate(${inset}, ${inset}) scale(${scale})">${face.replace(/<svg[^>]*>|<\/svg>/g, "")}</g>
  </svg>`;
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

const CONFETTI_COLORS = ["#F1EEE6", "#F6D186", "#E8A6C7", "#9FD8C8"];
const DANCE_MS = 600, CONFETTI_MS = 650;

/**
 * The avatar's dance on relay.paired, before the connected state (the user, 28 Sep; the shapes
 * are ui-ux's motion prototype, scratchpad/avatar-motion/avatar-motion.html, "goal done": the
 * msDone hop plus a confetti burst, played on the person's own avatar SVG, once, under 700ms —
 * not launch's own invention). `calm` (prefers-reduced-motion) skips all of it for a single
 * still bone dot instead, the prototype's own rule for "done": never a state that survives only
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

/** relay.pair.ticket says confirmed:false when an older relay never acknowledged the registration: after about 20 seconds without a pairing, say so. */
export const UNCONFIRMED_MS = 20000;
export const UNCONFIRMED_LINE = "The relay did not confirm this code. If the PC does not finish, make a new one.";
