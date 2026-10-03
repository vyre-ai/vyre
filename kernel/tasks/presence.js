// kernel/tasks/presence.js: the presence verifier (invariant 4). A presence proof is a signature, made by a biometric-gated
// hardware key (Secure Enclave, TPM, Windows Hello, StrongBox, or a platform authenticator) over THIS payload. The
// kernel checks the signature against the key the person enrolled, that the key belongs to that person, that the proof is
// bound to the exact payload, decision and chain, and that it has not expired or been used. It cannot tell a human from
// software: that is why the signer is a hardware gesture and the signer client is in the trusted base.
import { createPublicKey, createSign, createVerify } from "node:crypto";
import { canonical } from "../core/canonical.js";
import { PRESENCE_SIGNERS } from "../contracts/index.js";

const SKEW_MS = 60_000;

/** The exact bytes a signer signs. @param {any} p */
export const signedBody = p => "vyre-presence-v1\n" + canonical({ signer: p.signer, key_id: p.key_id, payload_hash: p.payload_hash, decision: p.decision, chain_hash: p.chain_hash, issued_at: p.issued_at, expires_at: p.expires_at, nonce: p.nonce });

/**
 * What a device's signer does: sign the fields with the hardware key. Exported so tests (and the real signer client's own
 * tests) can produce proofs; the kernel never holds a private key.
 * @param {import("node:crypto").KeyObject} privateKey @param {any} fields
 */
export function signProof(privateKey, fields) {
  const body = { signer: fields.signer, key_id: fields.key_id, payload_hash: fields.payload_hash, decision: fields.decision, chain_hash: fields.chain_hash, issued_at: fields.issued_at, expires_at: fields.expires_at, nonce: fields.nonce };
  const signature = createSign("sha256").update(signedBody(body)).sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { ...body, signature };
}

/** @param {{ clock?: () => number }} [cfg] */
export function createPresence(cfg = {}) {
  const clock = cfg.clock || Date.now;
  /** @type {Map<string, { person: string, signer: string, key: import("node:crypto").KeyObject, revoked?: boolean }>} */ const keys = new Map();
  /** @type {Map<string, number>} nonce -> the proof's expiry, kept until then */ const seen = new Map();

  return Object.freeze({
    /** Enrol a person's signer key (a grant-class act made with the device in hand, K-later pairing). @param {string} key_id @param {{ person: string, signer: string, public_key: string | import("node:crypto").KeyObject }} k */
    enroll(key_id, k) {
      if (!PRESENCE_SIGNERS.includes(/** @type {any} */ (k.signer))) throw new Error("not a hardware signer");
      keys.set(key_id, { person: k.person, signer: k.signer, key: typeof k.public_key === "string" ? createPublicKey(k.public_key) : k.public_key });
    },
    revoke(/** @type {string} */ key_id) { const k = keys.get(key_id); if (k) k.revoked = true; },

    /**
     * Is this a good proof? Pure: it consumes nothing, so a gate may call it and the caller then `consume`s it once.
     * @param {any} proof @param {{ person: string, payload_hash?: string, chain_hash?: string, decision?: string }} ctx the person the chain names, and any binding the caller requires
     */
    verify(proof, ctx) {
      if (!proof || typeof proof.signature !== "string" || typeof proof.nonce !== "string") return false;
      const k = keys.get(proof.key_id);
      if (!k || k.revoked || k.signer !== proof.signer || k.person !== ctx.person) return false;
      const now = clock();
      if (!(proof.expires_at > now) || proof.issued_at > now + SKEW_MS || proof.expires_at - proof.issued_at > 10 * 60_000) return false;
      if (ctx.payload_hash !== undefined && proof.payload_hash !== ctx.payload_hash) return false;
      if (ctx.chain_hash !== undefined && proof.chain_hash !== ctx.chain_hash) return false;
      if (ctx.decision !== undefined && proof.decision !== ctx.decision) return false;
      if (seen.has(proof.nonce)) return false;
      try { return createVerify("sha256").update(signedBody(proof)).verify({ key: k.key, dsaEncoding: "ieee-p1363" }, Buffer.from(proof.signature, "base64url")); } catch { return false; }
    },

    /** Use a proof up: true the first time, false ever after. Call after the action it authorized has been decided. */
    consume(/** @type {any} */ proof) {
      const now = clock();
      for (const [n, exp] of seen) if (exp < now) seen.delete(n);
      if (seen.has(proof.nonce)) return false;
      seen.set(proof.nonce, proof.expires_at);
      return true;
    },
  });
}
