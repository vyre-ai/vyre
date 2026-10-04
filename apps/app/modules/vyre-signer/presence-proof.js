// @ts-check
// The kernel presence proof, built the way kernel/seal/wire.js and kernel/seal/proof.js read it (platform's "THE iPHONE SIGNER: EXACT BYTES"). Pure: no native call
// here, so Node tests it. index.ts adds the Secure Enclave signature and the App Attest assertion around these bytes.

import { sha256 } from "@noble/hashes/sha256";

const enc = new TextEncoder();
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** @param {Uint8Array} b */
export function b64url(b) {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63];
    if (i + 1 < b.length) out += ALPHA[(n >> 6) & 63];
    if (i + 2 < b.length) out += ALPHA[n & 63];
  }
  return out;
}

/** @param {string} s */
export function fromB64url(s) {
  const clean = s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  /** @type {number[]} */ const out = [];
  let acc = 0, bits = 0;
  for (const ch of clean) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) throw new Error("not base64url");
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return new Uint8Array(out);
}

/** Standard base64 with padding (the SPKI and the attestation travel this way). @param {Uint8Array} b */
export const b64 = (b) => b64url(b).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((3 - (b.length % 3)) % 3);

/** Sorted-key JSON with no whitespace and undefined dropped: kernel/seal/wire.js canonical, byte for byte. @param {any} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

/** @param {string | Uint8Array} s */
export const sha256b64 = (s) => b64url(sha256(typeof s === "string" ? enc.encode(s) : s));

/** The hash of what the person is shown: canonical({ op, space, fields }), `fields` NESTED (kernel/seal/payloadhash-vectors.json). @param {string} op @param {string} space @param {Record<string, any>} fields */
export const payloadHash = (op, space, fields) => sha256b64(canonical({ op, space, fields }));

/** The hash of the chain the act runs under: one person, in this space. @param {string} person @param {string} space */
export const chainHash = (person, space) => sha256b64(canonical([["person", person, space]]));

/** The bytes the key signs: the proof without its signature and without its assertion. @param {Record<string, any>} proof */
export function proofBytes(proof) {
  const { signature, assertion, ...rest } = proof;
  return enc.encode(canonical(rest));
}

/** DER SubjectPublicKeyInfo of a P-256 key from its public point's x and y (32 bytes each). @param {Uint8Array} x @param {Uint8Array} y */
export function spkiFromXY(x, y) {
  const head = Uint8Array.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04]);
  const out = new Uint8Array(head.length + 64);
  out.set(head); out.set(x, head.length); out.set(y, head.length + 32);
  return out;
}

/** A short stable id for a key: "se-" and the first 16 hex characters of the SHA-256 of its SPKI. @param {Uint8Array} spki */
export const keyIdOf = (spki) => "se-" + [...sha256(spki).slice(0, 8)].map((v) => v.toString(16).padStart(2, "0")).join("");

/** An ECDSA DER signature as the 64 byte r||s the sealing process prefers (IEEE P1363). @param {Uint8Array} der */
export function p1363FromDer(der) {
  if (der[0] !== 0x30) throw new Error("not a DER signature");
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  /** @param {number} at */
  const int = (at) => {
    if (der[at] !== 0x02) throw new Error("not a DER integer");
    let len = der[at + 1], start = at + 2;
    while (len > 32 && der[start] === 0) { start++; len--; }
    if (len > 32) throw new Error("integer too long");
    const out = new Uint8Array(32);
    out.set(der.subarray(start, start + len), 32 - len);
    return { out, next: start + len };
  };
  const r = int(i), s = int(r.next);
  const sig = new Uint8Array(64);
  sig.set(r.out); sig.set(s.out, 32);
  return sig;
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/**
 * The one canonical form of an ECDSA P-256 signature on the identity chain (NK-2, NE-1): 64 bytes r||s with s in the low half. The Secure Enclave returns either s, so a high s is
 * replaced by n - s (the same signature, verifies the same), and a verifier that refuses the high twin never sees one from this phone.
 * @param {Uint8Array} raw
 */
export function lowS(raw) {
  if (raw.length !== 64) throw new Error("not a 64 byte r||s signature");
  let s = 0n;
  for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(raw[i]);
  if (s <= P256_N >> 1n) return raw;
  s = P256_N - s;
  const out = new Uint8Array(raw);
  for (let i = 63; i >= 32; i--) { out[i] = Number(s & 0xffn); s >>= 8n; }
  return out;
}

/**
 * Check what the card showed against its hash and build the proof body (everything but the signature). Refuses, with a code, when the fields do not hash to the card's
 * payload_hash: that is what makes what you see what you sign.
 * @param {{ op: string, space: string, fields: Record<string, any>, payload_hash: string, person: string }} req
 * @param {{ keyId: string, now: number, nonce: string, lifeMs?: number }} o
 */
export function proofBody(req, o) {
  if (!req.person) throw Object.assign(new Error("no person id for this proof"), { code: "ERR_NO_PERSON" });
  if (payloadHash(req.op, req.space, req.fields ?? {}) !== req.payload_hash) throw Object.assign(new Error("the card's fields do not match its hash"), { code: "ERR_PAYLOAD_MISMATCH" });
  const life = Math.min(o.lifeMs ?? 90_000, 120_000);
  return { signer: "secure_enclave", key_id: o.keyId, payload_hash: req.payload_hash, decision: req.op, chain_hash: chainHash(req.person, req.space), issued_at: o.now, expires_at: o.now + life, nonce: o.nonce };
}

/** The bytes the App Attest key vouches for at enrolment: "vyre-enrol\n" + token + "\n" + the SPKI as base64 text. @param {string} token @param {string} spkiB64 */
export const enrolClientData = (token, spkiB64) => sha256(enc.encode(`vyre-enrol\n${token}\n${spkiB64}`));
