// @ts-check
// pairwords: the three words both sides of a scan-or-paste pairing show, so the person compares them and answers yes (DESIGN-wink.md section 4, rulings of
// 4 Oct 2026). The words are made from material fresh to THIS pairing, never from the static keys alone (fifth run, break 3):
//   words = first 33 bits of sha256( domain "vyre-wink-pair-words-v2" || ticket secret || box key || device id || nonce A || nonce B ), every part length-prefixed,
// where the ticket secret is the single-use 16 bytes of the QR, the box key and the device id are the two keys, nonce A is the app's random 16 bytes and nonce B the
// server's. Commit-then-reveal is the standard way to make that safe (the same shape as the short authentication string of ZRTP and Bluetooth numeric comparison): the app
// first sends commit = sha256(domain "vyre-wink-pair-commit-v1" || nonce A), the server answers with nonce B, and only then the app reveals nonce A. Nobody can choose a
// nonce after seeing the other side's words: the app fixed A before it saw B, and B is fixed before A is known, so a man in the middle who relays between two sessions faces
// two different (A, B, device) triples and gets words that agree on both legs with probability 2^-33 per attempt, and a pairing has one try (five minutes, one answer).
// Three words from the 2048-word list carry 33 bits. The same function runs on the server (Node) and in the app (browser or Node).

import { WORDS } from "./words.js";

const enc = new TextEncoder();
/** @param {...string} parts length-prefixed, so no two part lists give the same bytes */
const frame = (...parts) => enc.encode(parts.map(p => `${String(p).length}:${p}`).join("\n"));
const hex = (/** @type {Uint8Array} */ b) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
/** @param {{ subtle?: SubtleCrypto }} o */
const sha = async (/** @type {Uint8Array} */ bytes, o) => new Uint8Array(await (o.subtle || globalThis.crypto.subtle).digest("SHA-256", bytes));

/** The commitment to a nonce, sent before the other side's nonce is known. @param {string} nonce @param {{ subtle?: SubtleCrypto }} [o] @returns {Promise<string>} */
export async function nonceCommit(nonce, o = {}) { return hex(await sha(frame("vyre-wink-pair-commit-v1", nonce), o)); }
/** A short tag that names which ticket a pairing used, without giving the ticket away. @param {string} ticket @param {{ subtle?: SubtleCrypto }} [o] @returns {Promise<string>} */
export async function ticketTag(ticket, o = {}) { return hex((await sha(frame("vyre-wink-pair-ticket-v1", ticket), o)).slice(0, 12)); }
/** A fresh random nonce, 16 bytes, hex. @returns {string} */
export function newNonce() { return hex(globalThis.crypto.getRandomValues(new Uint8Array(16))); }

/**
 * @param {string} box the server's public key, base64url, as the ticket record names it
 * @param {string} device the scanning device's id on the server
 * @param {{ ticket?: string, nonceA: string, nonceB: string, subtle?: SubtleCrypto }} o the pairing's own material: `ticket` the single-use secret (base64url or hex; "" when none is known),
 *   `nonceA` the app's nonce, `nonceB` the server's
 * @returns {Promise<string>} for example "amber coral seven"
 */
export async function pairWords(box, device, o) {
  if (!o || !o.nonceA || !o.nonceB) throw new Error("the pairing words need this pairing's own nonces");
  const h = await sha(frame("vyre-wink-pair-words-v2", o.ticket || "", box, device, o.nonceA, o.nonceB), o);
  const bits = (h[0] * 2 ** 24 + h[1] * 2 ** 16 + h[2] * 2 ** 8 + h[3]) * 2 ** 1 + (h[4] >> 7); // the first 33 bits
  return [0, 1, 2].map(i => WORDS[Math.floor(bits / 2 ** (22 - 11 * i)) % 2048]).join(" ");
}
