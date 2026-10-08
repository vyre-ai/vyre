// @ts-check
// A passkey's yes (the one yes for a browser-only person): the kernel presence proof for a held act, signed by the browser's own passkey instead of a chip key. Its shape is kernel/seal/passkey-proof.test.js:
// the proof object { signer: "webauthn_platform", key_id, payload_hash, decision, chain_hash, issued_at, expires_at, nonce } plus `signature`, the base64url of the assertion's JSON { ad, cd, s }, where the
// WebAuthn challenge is the SHA-256 of the proof's own bytes (proofBytes). The passkey key's sign(message) already makes that envelope for a message (src/identity/passkey.js), so this only builds the bytes.
import { sha256 } from "@noble/hashes/sha256";
import { b64url, canonical, chainHash, payloadHash, proofBytes } from "../../modules/vyre-signer/presence-proof.js";
import { passkeyPresenceKey } from "../identity/passkey.js";

/** The id a presence key is known by in a home's sealing process: dk_ and the first 16 hex characters of the SHA-256 of its SPKI DER (lib/presence-key-id.js). @param {Uint8Array} spkiDer */
export const presenceKeyId = (spkiDer) => "dk_" + [...sha256(spkiDer).slice(0, 8)].map((v) => v.toString(16).padStart(2, "0")).join("");

/** How long a proof is good for (the kernel's own life for a held yes). */
export const PROOF_LIFE_MS = 60_000;

/**
 * Sign one held act with the browser's passkey.
 * A space on a server asks with a one-use challenge: the proof then names that home and challenge in its signed body, as the other signers do (presence-proof.js proofBody).
 * @param {{ op: string, space: string, fields: Record<string, any>, payload_hash: string, person: string, home?: string, challenge?: string }} card
 * @param {{ key: { sign(message: Uint8Array): Promise<Uint8Array>, keep(): any }, now?: () => number, nonce?: () => string }} o
 */
export async function signPresenceWithPasskey(card, o) {
  const pk = passkeyPresenceKey(o.key.keep());
  if (!pk) throw Object.assign(new Error("this device has no passkey"), { code: "no_signer" });
  // Never sign a hash the box gave without recomputing it from the fields shown (AP-1).
  if (payloadHash(card.op, card.space, card.fields) !== card.payload_hash) throw Object.assign(new Error("the hash does not match what the card shows"), { code: "hash_mismatch" });
  const spki = new Uint8Array(Buffer.from(pk.key, "base64url"));
  const issued = (o.now ?? Date.now)();
  const nonce = o.nonce ? o.nonce() : b64url(crypto.getRandomValues(new Uint8Array(8)));
  const p = { signer: "webauthn_platform", key_id: presenceKeyId(spki), payload_hash: card.payload_hash, decision: card.op, chain_hash: chainHash(card.person, card.space), issued_at: issued, expires_at: issued + PROOF_LIFE_MS, nonce, ...(card.home && card.challenge ? { home: String(card.home), challenge: String(card.challenge) } : {}) };
  const envelope = await o.key.sign(proofBytes(p));
  return { ...p, signature: b64url(envelope) };
}

export { canonical };
