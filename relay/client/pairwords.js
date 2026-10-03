// @ts-check
// pairwords: the three words both sides of a scan-or-paste pairing show, so the person compares them and answers yes (DESIGN-wink.md section 4, ruling of
// 4 Oct 2026). Made from both sides' keys: sha256("vyre-wink-pair-words-v1" || box key || device id), where the box key is the server's public key (the ticket's
// record carries it, MAC-checked) and the device id is the id the server derived from the scanning device's own public key (a hash of it), so the words change
// with either key. Three words from the 2048-word list carry 33 bits: enough for a person to catch a stranger's device, with the pairing window of five minutes
// and one try. The same function runs on the server (Node) and in the app (browser or Node).

import { WORDS } from "./words.js";

const enc = new TextEncoder();
/**
 * @param {string} box the server's public key, base64url, as the ticket record names it
 * @param {string} device the scanning device's id on the server
 * @param {{ subtle?: SubtleCrypto }} [o]
 * @returns {Promise<string>} for example "amber coral seven"
 */
export async function pairWords(box, device, o = {}) {
  const subtle = o.subtle || globalThis.crypto.subtle;
  const h = new Uint8Array(await subtle.digest("SHA-256", enc.encode(`vyre-wink-pair-words-v1\n${String(box)}\n${String(device)}`)));
  const bits = (h[0] * 2 ** 24 + h[1] * 2 ** 16 + h[2] * 2 ** 8 + h[3]) * 2 ** 1 + (h[4] >> 7); // the first 33 bits
  return [0, 1, 2].map(i => WORDS[Math.floor(bits / 2 ** (22 - 11 * i)) % 2048]).join(" ");
}
