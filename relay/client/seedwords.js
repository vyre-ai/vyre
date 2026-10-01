// @ts-check
// seedwords: the 16-byte pairing seed a computer chooses for itself (the Windows app, ticket
// relay.pair.ticket { seed }) as words a person can read out, type or scan, and back. One module, both
// sides: the app shows the words and the QR, the Deck's "Add a Windows PC" takes either.
//
// Words. 13 words from the setup page's 2048-word list (relay/client/words.js, BIP-39 English):
//   words 1 to 12 carry the 128 seed bits in 11-bit groups, the last of them padded with 4 zero bits;
//   word 13 is the checksum: the first 11 bits of SHA-256(seed).
// A single mistyped, missing, swapped or extra word is caught (word 13 misses one chance in 2048,
// and a nonzero pad is refused too). Typing is forgiving: any case, spaces, commas or dashes between
// words, and the first four letters of a word are enough (the list is unique in its first four).
//
// QR. The text `vyre-pc:` then the 22 characters of the seed in base64url. Nothing else in it.
// parseSeedText() takes the words, that QR text, or the bare 22 characters.
//
// The seed is the pairing secret until it is used: show it only on the person's own screen, never
// log it, and clear it when the pairing ends.

import { WORDS } from "./words.js";
import { base64url, fromBase64url } from "./bytes.js";

export const SEED_BYTES = 16;
export const QR_PREFIX = "vyre-pc:";
const LIST = /** @type {string[]} */ (WORDS);
const INDEX = new Map(LIST.map((w, i) => [w, i]));
const BY_PREFIX = new Map(LIST.map((w, i) => [w.slice(0, 4), i]));

/** A fresh seed. @param {import("./noise.js").CryptoProvider} crypto */
export const newSeed = crypto => crypto.randomBytes(SEED_BYTES);

/** The 11-bit checksum: the first 11 bits of SHA-256 of the seed. */
async function checksum(seed, crypto) {
  const h = await crypto.sha256(seed);
  return (h[0] << 3) | (h[1] >> 5);
}

/**
 * The 13 words for a seed.
 * @param {Uint8Array} seed 16 bytes @param {import("./noise.js").CryptoProvider} crypto @returns {Promise<string[]>}
 */
export async function seedToWords(seed, crypto) {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) throw new Error("a pairing seed is 16 bytes");
  const out = [];
  let acc = 0n;
  for (const b of seed) acc = (acc << 8n) | BigInt(b);
  acc <<= 4n;   // 128 bits become 132: twelve groups of eleven, the last padded with four zero bits
  for (let i = 11; i >= 0; i--) out.push(LIST[Number((acc >> BigInt(i * 11)) & 0x7ffn)]);
  out.push(LIST[await checksum(seed, crypto)]);
  return out;
}

/**
 * The seed for 13 words, or a thrown error whose `code` says what is wrong: `word_count`, `unknown_word`
 * (with `word`), `bad_checksum`.
 * @param {string | string[]} input @param {import("./noise.js").CryptoProvider} crypto @returns {Promise<Uint8Array>}
 */
export async function wordsToSeed(input, crypto) {
  const words = (Array.isArray(input) ? input : String(input).split(/[\s,.\-_;]+/)).map(w => String(w).trim().toLowerCase()).filter(Boolean);
  const bad = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
  if (words.length !== 13) throw bad("word_count", `a pairing code is 13 words; there are ${words.length}`);
  const idx = words.map(w => {
    const i = INDEX.has(w) ? INDEX.get(w) : (w.length >= 4 ? BY_PREFIX.get(w.slice(0, 4)) : undefined);
    if (i === undefined || (w.length > 4 && !INDEX.has(w) && !LIST[i].startsWith(w))) throw bad("unknown_word", `"${w}" is not in the word list`, { word: w });
    return /** @type {number} */ (i);
  });
  let acc = 0n;
  for (const i of idx.slice(0, 12)) acc = (acc << 11n) | BigInt(i);
  if ((acc & 0xfn) !== 0n) throw bad("bad_checksum", "these words are not a pairing code");
  acc >>= 4n;
  const seed = new Uint8Array(SEED_BYTES);
  for (let i = SEED_BYTES - 1; i >= 0; i--) { seed[i] = Number(acc & 0xffn); acc >>= 8n; }
  if ((await checksum(seed, crypto)) !== idx[12]) throw bad("bad_checksum", "the last word does not match: one of the words is mistyped");
  return seed;
}

/** The text a QR code carries for a seed. @param {Uint8Array} seed */
export const seedQrText = seed => QR_PREFIX + base64url(seed);

/**
 * A seed from whatever the person or the camera gave: the 13 words, the QR text, or the bare 22
 * characters. Throws as wordsToSeed does, or `bad_seed`.
 * @param {string} text @param {import("./noise.js").CryptoProvider} crypto @returns {Promise<Uint8Array>}
 */
export async function parseSeedText(text, crypto) {
  const t = String(text || "").trim();
  const raw = t.startsWith(QR_PREFIX) ? t.slice(QR_PREFIX.length) : /^[A-Za-z0-9_-]{22}$/.test(t) ? t : null;
  if (raw !== null) {
    let b;
    try { b = fromBase64url(raw); } catch { b = null; }
    if (!b || b.length !== SEED_BYTES) throw Object.assign(new Error("that is not a pairing code"), { code: "bad_seed" });
    return b;
  }
  return wordsToSeed(t, crypto);
}
