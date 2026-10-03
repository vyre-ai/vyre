// kernel/seal/proof.js: the sealing process checks a presence proof itself (invariant 4): a signature by an enrolled, biometric-gated key of the
// one person in the chain, over exactly this payload, fresh, used once. The process trusts the kernel only for who is in the chain.
import crypto from "node:crypto";
import { proofBytes, payloadHash, sha256b64 } from "./wire.js";

export const SIGNERS = new Set(["secure_enclave", "tpm", "windows_hello", "strongbox", "webauthn_platform"]);
export const MAX_PROOF_LIFE_MS = 120_000;

export class Presence {
  /** @param {() => number} [now] @param {{ verifiers?: Record<string, (att: any, spki: Buffer) => string | null>, allowUnattested?: boolean }} [o] a verifier checks a platform attestation (App Attest, Android key attestation, a TPM quote, WebAuthn) and returns the signer class it proves, or null */
  constructor(now = Date.now, { verifiers = {}, allowUnattested = false } = {}) { this.keys = new Map(); this.used = new Map(); this.tokens = new Map(); this.now = now; this.since = now(); this.verifiers = verifiers; this.allowUnattested = allowUnattested; }
  have(person) { return [...this.keys.values()].some(k => k.person === person); }
  /** Step 1 of the ceremony: a one-time token for this person and this key, minutes long. The kernel shows it through the pairing flow. */
  begin({ person, key_id, spki }) {
    const token = crypto.randomBytes(16).toString("base64url");
    this.tokens.set(token, { person, key_id, spki: sha256b64(spki), exp: this.now() + 300_000 });
    return { token, expires_in_ms: 300_000 };
  }
  /**
   * Step 2: enrol a device key for a person. The chain must be exactly that person; the token must be this key's, unused and fresh; a second device
   * needs a proof from a key already enrolled for the same person; the signer class must be proved by a platform attestation, or the process
   * must have been started to allow unattested keys (development, and a platform where no attestation exists, said plainly in the card).
   * @returns {{ attested: boolean } | { refused: string }}
   */
  enrol({ person, key_id, spki, signer, token, attestation, proof, ctx }) {
    if (!SIGNERS.has(signer)) return { refused: "bad_signer" };
    if (!ctx?.one_person || ctx.model_originated || ctx.person !== person) return { refused: "chain_not_person" };
    const t = this.tokens.get(token); this.tokens.delete(token);
    if (!t || t.exp < this.now() || t.person !== person || t.key_id !== key_id || t.spki !== sha256b64(spki)) return { refused: "no_ceremony" };
    if (this.keys.has(key_id)) return { refused: "exists" };
    if (this.have(person)) {
      const why = this.refuse(proof, { op: "presence.enrol", space: ctx.space, fields: { key_id, spki: t.spki, signer }, ctx });
      if (why) return { refused: why === "no_proof" ? "needs_presence" : why };
    }
    let attested = false;
    if (attestation && this.verifiers[attestation.format]) {
      if (this.verifiers[attestation.format](attestation, Buffer.from(spki, "base64")) !== signer) return { refused: "bad_attestation" };
      attested = true;
    } else if (!this.allowUnattested) return { refused: "unattested" };
    this.keys.set(key_id, { person, signer, attested, key: crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" }) });
    return { attested };
  }
  /** Only the person who owns the key (or a proof from another of their keys) may take it away. */
  revoke(key_id, ctx) {
    const k = this.keys.get(key_id);
    if (!k || !ctx?.one_person || ctx.person !== k.person) return false;
    this.keys.delete(key_id); return true;
  }
  /** @returns {string|null} the reason a proof is refused, or null when it stands. */
  refuse(proof, { op, space, fields, ctx }) {
    if (!proof || typeof proof !== "object") return "no_proof";
    if (!ctx.one_person || !ctx.person) return "chain_not_person";
    const k = this.keys.get(proof.key_id);
    if (!k || k.person !== ctx.person || k.signer !== proof.signer) return "unknown_key";
    if (!k.attested && !this.allowUnattested) return "unattested";
    if (proof.decision !== op || proof.chain_hash !== ctx.chain_hash) return "wrong_decision";
    if (proof.payload_hash !== payloadHash(op, space, fields)) return "wrong_payload";
    const t = this.now();
    // The used-nonce list is in memory: a proof issued before this process started could already have been used, so none is accepted.
    if (proof.issued_at < this.since || !(proof.issued_at <= t + 5000) || !(proof.expires_at > t) || proof.expires_at - proof.issued_at > MAX_PROOF_LIFE_MS) return "expired";
    let ok = false;
    try {
      const sig = Buffer.from(proof.signature, "base64url");
      ok = crypto.verify("sha256", proofBytes(proof), { key: k.key, dsaEncoding: sig.length === 64 ? "ieee-p1363" : "der" }, sig);
    } catch { ok = false; }
    if (!ok) return "bad_signature";
    for (const [n, e] of this.used) if (e < t) this.used.delete(n);
    if (this.used.has(proof.nonce)) return "replayed";
    this.used.set(proof.nonce, proof.expires_at);
    return null;
  }
}
