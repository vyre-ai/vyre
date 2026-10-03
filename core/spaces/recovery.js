// @ts-check
// spaces: the recovery code (team/0.3/DESIGN-wink.md section 2). A code is 128 random bits written as 26 base32 characters in groups of four.
// With an optional PIN the person memorises, the paper alone is useless: the key is a memory-hard function of both. Only the PUBLIC half is
// on the identity's list, so nothing the directory holds helps a guesser except the work factor below, and the code's own 128 bits.
//
// The honest limit (the design says it too): whoever holds the code, and the PIN if one is set, can sign in as the person until an older
// entry removes them. The PIN only keeps the paper from being enough.

import crypto from "node:crypto";
import { keyId } from "../names/ids.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SALT = Buffer.from("vyre-recovery-code-v1");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
export const SCRYPT = Object.freeze({ N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });

/** A fresh code: 128 bits as 26 characters in groups of four. @param {(n: number) => Buffer} [random] */
export function newCode(random = crypto.randomBytes) {
  const raw = random(16);
  let out = "", bits = 0, value = 0;
  for (const b of raw) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, 26).replace(/(.{4})(?=.)/g, "$1-");
}

/** What a person types back is forgiving about case, spaces and dashes. @param {unknown} code */
export const normalizeCode = code => String(code ?? "").toLowerCase().replace(/[\s-]/g, "");
export const codeLooksRight = (/** @type {unknown} */ code) => /^[a-z2-7]{26}$/.test(normalizeCode(code));

/**
 * The Ed25519 key a code (and PIN) stands for. `params` is for tests only: the work factor is part of what makes a stolen paper slow to use.
 * @param {string} code @param {string} [pin] @param {{ N: number, r: number, p: number, maxmem: number }} [params]
 */
export function codeKey(code, pin = "", params = SCRYPT) {
  if (!codeLooksRight(code)) throw Object.assign(new Error("that is not a recovery code"), { code: "bad_code" });
  const seed = crypto.scryptSync(Buffer.from(`${normalizeCode(code)}\n${String(pin ?? "").normalize("NFKC")}`), SALT, 32, params);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { eid: keyId(pub), publicKey: Buffer.from(pub).toString("base64url"), sign: (/** @type {Uint8Array} */ m) => crypto.sign(null, Buffer.from(m), privateKey) };
}
