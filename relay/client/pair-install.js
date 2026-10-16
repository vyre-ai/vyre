// @ts-check
// The app's half of an install code (lib/pair-code.js is the server's). Same 179 bytes: version, expiry, nonce, the identity's raw public key, the setup secret, the setup fingerprint, the chain person id, the signature.
// Runs in a browser. The identity key signs here and the private half never leaves the key this device already holds.

import { concat, utf8, base64url, fromBase64url } from "./bytes.js";

export const PAIR_TAG = "vyre-pair-install-v1\n";
export const PAIR_VERSION = 2;
export const PAIR_TTL_MS = 30 * 60 * 1000;
export const PAIR_CODE_LEN = 239;
const PERSON_ID_RE = /^per_[a-z2-7]{26}$/;

/** @param {number} n */
function u32(n) {
  const b = new Uint8Array(4);
  const v = n >>> 0;
  b[0] = v >>> 24; b[1] = (v >>> 16) & 255; b[2] = (v >>> 8) & 255; b[3] = v & 255;
  return b;
}

/**
 * @param {{ person: string, publicKey: string, sign: (m: Uint8Array) => Uint8Array|Promise<Uint8Array>, secret: Uint8Array, fingerprint: Uint8Array, now?: () => number, random?: (n: number) => Uint8Array, ttlMs?: number }} o
 */
export async function mintPairCode(o) {
  const person = String(o.person || "");
  const pub = fromBase64url(o.publicKey);
  const secret = o.secret;
  const fp = o.fingerprint;
  if (!PERSON_ID_RE.test(person)) throw Object.assign(new Error("An install code needs the person's identity id. Open the Vyre app and try again."), { code: "bad_input" });
  if (pub.length !== 32 || secret.length !== 16 || fp.length !== 16) throw Object.assign(new Error("An install code needs the identity's public key, a setup secret and its fingerprint."), { code: "bad_input" });
  const now = o.now || Date.now;
  const exp = Math.floor(now() / 1000) + Math.floor((o.ttlMs ?? PAIR_TTL_MS) / 1000);
  const nonce = (o.random || (n => globalThis.crypto.getRandomValues(new Uint8Array(n))))(16);
  const who = utf8(person);
  const msg = concat(utf8(PAIR_TAG), new Uint8Array([PAIR_VERSION]), u32(exp), nonce, pub, secret, fp, who);
  const sig = new Uint8Array(await o.sign(msg));
  if (sig.length !== 64) throw Object.assign(new Error("The identity key did not sign the install code. Try again from the Vyre app."), { code: "bad_input" });
  const raw = concat(new Uint8Array([PAIR_VERSION]), u32(exp), nonce, pub, secret, fp, who, sig);
  const code = base64url(raw);
  return { code, exp, person };
}
