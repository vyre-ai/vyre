// @ts-check
// lib/identity: the one formula for turning owner.id into a short, stable, non-secret
// fingerprint, as a pure library (ADR 0033, section 3). No feature state: nothing here reads
// config, the store or another module.
//
// Both directions of a pairing need to land on the same 8 bytes independently -- the box
// (core/config's fingerprint8, surfaced by system.info) and the phone (tailnet's relay, which
// puts the assistant's fingerprint in the pairing ticket as identityFingerprint). If either side
// re-derives the formula instead of importing this, the two drift and the phone's avatar stops
// matching the app's. Import this; don't recompute sha256("vyre:...") elsewhere.
//
// owner.id is display identity only, never a trust anchor: any process running as the same OS
// user can read and edit ~/.vyre/config.json, so proving "I know owner.id" proves nothing about
// who is asking. Pairing and presence are proved with the vault's real keys (core/presence);
// this fingerprint only lets a human eyeball that two screens agree on whose avatar they're
// looking at.

import crypto from "node:crypto";

const KINDS = new Set(["person", "assistant"]);

/**
 * The first 8 bytes of sha256(`vyre:${kind}:v1:${ownerIdHex}`), as a Buffer. Deterministic and
 * one-way: this never lets you recover ownerIdHex, only confirm two sides agree on it.
 * @param {string} ownerIdHex - owner.id, hex.
 * @param {"person"|"assistant"} [kind] - "person" for the human's own avatar, "assistant" for
 *   Vyre's (a solo install's assistant identity is still derived from the same owner.id).
 * @returns {Buffer} exactly 8 bytes.
 */
export function fingerprint8(ownerIdHex, kind = "person") {
  if (!KINDS.has(kind)) throw new Error(`fingerprint8: kind must be "person" or "assistant", got ${JSON.stringify(kind)}`);
  if (typeof ownerIdHex !== "string" || !ownerIdHex) throw new Error("fingerprint8: ownerIdHex must be a non-empty string");
  return crypto.createHash("sha256").update(`vyre:${kind}:v1:${ownerIdHex}`).digest().subarray(0, 8);
}

/** @param {Uint8Array} bytes */
export function toBase64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** @param {string} s */
export function fromBase64url(s) {
  return Buffer.from(String(s), "base64url");
}
