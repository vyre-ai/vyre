// @ts-check
// totp: one-time codes for items that carry a `totp` field, from node:crypto and nothing else.
//
// Decision 10 in docs/adr/0001-vault-crypto.md puts TOTP inside the Vault so a person can drop an
// authenticator app. The seed is as sensitive as a password, so every error here names what is
// wrong with the input without ever repeating it. HOTP is refused rather than half supported: a
// counter has to be stored and advanced, and a code that silently repeats is worse than no code.

import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHMS = new Set(["sha1", "sha256", "sha512"]);

/**
 * RFC 4648 base32 to bytes. Case-insensitive; spaces, dashes and `=` padding are ignored.
 * @param {string} s
 * @returns {Buffer}
 */
export function base32Decode(s) {
  const clean = String(s).replace(/[\s=-]/g, "").toUpperCase();
  const out = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base32: only A-Z and 2-7 are allowed");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/**
 * @typedef {{ secret: Buffer, algorithm: "sha1"|"sha256"|"sha512", digits: 6|8, period: number }} OtpParams
 */

/**
 * Read an `otpauth://totp/...` URI or a bare base32 secret. Defaults: sha1, 6 digits, 30 s.
 * @param {string} input
 * @returns {OtpParams}
 */
export function parseOtpauth(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("totp: empty secret");
  let secretText = raw, algorithm = "sha1", digits = 6, period = 30;
  if (/^otpauth:/i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error("totp: not a valid otpauth URI"); }
    const kind = url.hostname.toLowerCase();
    if (kind === "hotp") throw new Error("totp: otpauth://hotp (counter based) is not supported, only totp");
    if (kind !== "totp") throw new Error("totp: otpauth URI must be otpauth://totp/...");
    const p = url.searchParams;
    secretText = p.get("secret") || "";
    if (!secretText) throw new Error("totp: otpauth URI has no secret parameter");
    if (p.has("algorithm")) algorithm = String(p.get("algorithm")).toLowerCase().replace(/-/g, "");
    if (p.has("digits")) digits = Number(p.get("digits"));
    if (p.has("period")) period = Number(p.get("period"));
  }
  if (!ALGORITHMS.has(algorithm)) throw new Error("totp: algorithm must be SHA1, SHA256 or SHA512");
  if (digits !== 6 && digits !== 8) throw new Error("totp: digits must be 6 or 8");
  if (!Number.isInteger(period) || period < 1 || period > 86400) throw new Error("totp: period must be a whole number of seconds from 1 to 86400");
  let secret;
  try { secret = base32Decode(secretText); } catch { throw new Error("totp: secret is not valid base32"); }
  if (secret.length === 0) throw new Error("totp: secret is empty");
  return { secret, algorithm: /** @type {OtpParams["algorithm"]} */ (algorithm), digits: /** @type {6|8} */ (digits), period };
}

/**
 * The current code, per RFC 6238 with RFC 4226 dynamic truncation.
 * @param {string} input an otpauth://totp URI or a bare base32 secret
 * @param {{ at?: number }} [opts] `at` is a time in milliseconds
 * @returns {{ code: string, remaining: number, period: number, digits: number }}
 */
export function totp(input, { at = Date.now() } = {}) {
  const { secret, algorithm, digits, period } = parseOtpauth(input);
  const seconds = Math.floor(at / 1000);
  const counter = Math.floor(seconds / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  const code = String(bin % 10 ** digits).padStart(digits, "0");
  return { code, remaining: period - (seconds % period), period, digits };
}
