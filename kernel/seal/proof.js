// kernel/seal/proof.js: the sealing process checks a presence proof itself (invariant 4): a signature by an enrolled, biometric-gated key of the
// one person in the chain, over exactly this payload, fresh, used once. The process trusts the kernel only for who is in the chain.
import crypto from "node:crypto";
import { proofBytes, payloadHash } from "./wire.js";

export const SIGNERS = new Set(["secure_enclave", "tpm", "windows_hello", "strongbox", "webauthn_platform"]);
export const MAX_PROOF_LIFE_MS = 120_000;

export class Presence {
  constructor(now = Date.now) { this.keys = new Map(); this.used = new Map(); this.now = now; this.since = now(); }
  /** A device key the kernel enrolled for a person: SPKI DER, base64. Only the kernel (the parent process) can say this. */
  enrol({ person, key_id, spki, signer }) {
    if (!SIGNERS.has(signer)) throw new Error("bad signer");
    this.keys.set(key_id, { person, signer, key: crypto.createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" }) });
  }
  revoke(key_id) { this.keys.delete(key_id); }
  /** @returns {string|null} the reason a proof is refused, or null when it stands. */
  refuse(proof, { op, space, fields, ctx }) {
    if (!proof || typeof proof !== "object") return "no_proof";
    if (!ctx.one_person || !ctx.person) return "chain_not_person";
    const k = this.keys.get(proof.key_id);
    if (!k || k.person !== ctx.person || k.signer !== proof.signer) return "unknown_key";
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
