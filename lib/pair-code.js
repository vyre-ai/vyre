// @ts-check
// A server install code: one bearer the creator's published identity key signs, carried in the install line's environment (never as an argument).
// The person id is the identity chain's id (ADR 0054), not the device key's id. Redeem checks that the key in the code is still published for that person.
// Layout, 179 bytes, base64url without padding (239 characters): version 2, exp uint32 seconds, nonce 16, raw public key 32, setup secret 16, setup fingerprint 16, person id 30, Ed25519 signature 64.
// The signature covers `vyre-pair-install-v1\n` and those fields except the signature itself. The setup secret and fingerprint are the existing 43-character setup code, so the app can still find the server.

import crypto from "node:crypto";
import { keyId } from "./identity/directory.js";

export const PAIR_TAG = "vyre-pair-install-v1\n";
export const PAIR_VERSION = 2;
export const PAIR_TTL_MS = 30 * 60 * 1000;
export const PAIR_TTL_S = 30 * 60;
export const PAIR_SKEW_S = 120;
export const PAIR_CODE_BYTES = 179;
export const PAIR_CODE_LEN = 239;
export const PERSON_ID_RE = /^per_[a-z2-7]{26}$/;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** @param {number} n */
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

/**
 * The signed bytes. @param {number} exp @param {Uint8Array} nonce @param {Uint8Array} pub @param {Uint8Array} secret @param {Uint8Array} fp
 */
export function pairMessage(exp, nonce, pub, secret, fp, person) {
  return Buffer.concat([Buffer.from(PAIR_TAG), Buffer.from([PAIR_VERSION]), u32(exp), Buffer.from(nonce), Buffer.from(pub), Buffer.from(secret), Buffer.from(fp), Buffer.from(String(person))]);
}

/** @param {string} code */
export function parsePairCode(code) {
  if (typeof code !== "string" || code.length !== PAIR_CODE_LEN || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  let raw;
  try { raw = Buffer.from(code, "base64url"); } catch { return null; }
  if (raw.length !== PAIR_CODE_BYTES || raw.toString("base64url") !== code || raw[0] !== PAIR_VERSION) return null;
  return {
    exp: raw.readUInt32BE(1),
    nonce: raw.subarray(5, 21),
    pub: raw.subarray(21, 53),
    secret: raw.subarray(53, 69),
    fp: raw.subarray(69, 85),
    person: raw.subarray(85, 115).toString("utf8"),
    sig: raw.subarray(115, 179),
  };
}

/** The 43-character setup code embedded in a parsed install code. @param {{ secret: Uint8Array, fp: Uint8Array }} p */
export function setupCodeOf(p) {
  return Buffer.concat([Buffer.from(p.secret), Buffer.from(p.fp)]).toString("base64url");
}

/** @param {Uint8Array} pub */
export const personIdOfKey = pub => `per_${keyId(Buffer.from(pub))}`;

/**
 * Mint a code. `person` is the identity chain's id. `sign` is this device's identity key and the private half never enters this function.
 * @param {{ person: string, publicKey: string, sign: (m: Uint8Array) => Uint8Array|Buffer|Promise<Uint8Array|Buffer>, secret: Uint8Array, fingerprint: Uint8Array, now?: () => number, random?: (n: number) => Uint8Array, ttlMs?: number }} o
 */
export async function mintPairCode(o) {
  const person = String(o.person || "");
  const pub = Buffer.from(o.publicKey, "base64url");
  const secret = Buffer.from(o.secret);
  const fp = Buffer.from(o.fingerprint);
  if (!PERSON_ID_RE.test(person)) throw fail("bad_input", "An install code needs the person's identity id. Open the Vyre app and try again.");
  if (pub.length !== 32 || secret.length !== 16 || fp.length !== 16) throw fail("bad_input", "An install code needs the identity's public key, a setup secret and its fingerprint.");
  const now = o.now || Date.now;
  const exp = Math.floor(now() / 1000) + Math.floor((o.ttlMs ?? PAIR_TTL_MS) / 1000);
  const nonce = Buffer.from((o.random || (n => crypto.randomBytes(n)))(16));
  const msg = pairMessage(exp, nonce, pub, secret, fp, person);
  const sig = Buffer.from(await o.sign(msg));
  if (sig.length !== 64) throw fail("bad_input", "The identity key did not sign the install code. Try again from the Vyre app.");
  const raw = Buffer.concat([Buffer.from([PAIR_VERSION]), u32(exp), nonce, pub, secret, fp, Buffer.from(person), sig]);
  return { code: raw.toString("base64url"), exp, person, setup: setupCodeOf({ secret, fp }) };
}

/**
 * Check a code's shape, expiry and signature. The person id is the one the signature covers. Whether that key is still published is redeem's check.
 * @param {string} code @param {() => number} [now]
 * @returns {{ ok: true, person: string, exp: number, setup: string, nonceHash: string, secret: Buffer, fp: Buffer, pub: Buffer } | { ok: false, code: string, message: string }}
 */
export function verifyPairCode(code, now = Date.now) {
  const p = parsePairCode(code);
  if (!p || !PERSON_ID_RE.test(p.person)) return { ok: false, code: "bad_input", message: "That install code does not look right. Copy the install line from the Vyre app again." };
  const t = Math.floor(now() / 1000);
  if (p.exp > t + PAIR_TTL_S + PAIR_SKEW_S) return { ok: false, code: "bad_input", message: "That install code is not one this server accepts. Make a new install line in the Vyre app." };
  if (t > p.exp + PAIR_SKEW_S) return { ok: false, code: "expired", message: "That install code has expired. Make a new install line in the Vyre app and run it again." };
  const msg = pairMessage(p.exp, p.nonce, p.pub, p.secret, p.fp, p.person);
  let key;
  try { key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, p.pub]), format: "der", type: "spki" }); } catch { return { ok: false, code: "denied", message: "That install code is not signed by an identity key. Make a new install line in the Vyre app." }; }
  if (!crypto.verify(null, msg, key, p.sig)) return { ok: false, code: "denied", message: "That install code is not signed by the person it names. Make a new install line in the Vyre app." };
  return { ok: true, person: p.person, exp: p.exp, setup: setupCodeOf(p), nonceHash: crypto.createHash("sha256").update(p.nonce).digest("hex"), secret: Buffer.from(p.secret), fp: Buffer.from(p.fp), pub: Buffer.from(p.pub) };
}

/** The one install line, for Linux and for a Mac that stays on. On a Mac, i.sh hands the same line to the Mac server installer. The code rides in the environment of sh, never as an argument. @param {"linux"|"mac"} [_os] @param {string} code */
export function installCommand(_os, code) {
  return `curl -fsSL vyre.run/i | VYRE_CODE=${code} VYRE_STORE=auto sh`;
}
