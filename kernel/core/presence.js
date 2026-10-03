// kernel/core/presence.js: the one presence interface the kernel uses (invariant 4). There is one verifier: the sealing process's, which holds
// the enrolled keys, the MACed key list and the recovery state (kernel/seal). A kernel act that a person signs (a task approval, an unblock)
// asks it through `check`; nothing else in the kernel verifies a signature. The signer hashes the payload with `payloadHash` and signs the
// proof bytes (kernel/seal/wire.js); a proof binds the person, the op, the fields, the chain and a single use.
import { isChain } from "./chain.js";
import { KernelError } from "./errors.js";

export { payloadHash, proofBytes } from "../seal/wire.js";

/**
 * @typedef {{ check(i: { chain: any, op: string, fields: Record<string, unknown>, proof: any }): Promise<string | null> }} PresenceVerifier
 * `check` resolves null when the proof stands (and uses it up), otherwise a short reason. It never throws for a bad proof.
 */

/** The verifier backed by the sealing process. @param {{ presenceCheck(i: any): Promise<string | null> }} sealer @returns {PresenceVerifier} */
export function sealerPresence(sealer) {
  return Object.freeze({
    async check(i) {
      if (!isChain(i.chain)) throw new KernelError("bad_input", "a presence check needs a kernel-built chain");
      if (!i.proof) return "no_proof";
      try { return await sealer.presenceCheck(i); } catch { return "unavailable"; }
    },
  });
}

/**
 * The verifier `authorize` calls for a risk-`grant` action: the person signs `grant.<verb>` over the resource and the canonical input hash,
 * and the sealing process checks it (one verifier). Any other action has no kernel-signed form here and so is never met by a proof.
 * @param {PresenceVerifier} presence @returns {(proof: any, ctx: any) => Promise<boolean>}
 */
export function grantProofVerifier(presence) {
  return async (proof, ctx) => {
    const m = /^(grants|rules)\.([a-z_]+)$/.exec(String(ctx && ctx.action));
    if (!m || !ctx.input_hash) return false;
    // A standing-rule act is signed as a grant act named `grant.rule_<verb>`: the sealing process accepts only task and grant acts, and a rule is one (it changes what is allowed).
    const op = m[1] === "grants" ? `grant.${m[2]}` : `grant.rule_${m[2]}`;
    return (await presence.check({ chain: ctx.chain, op, fields: { resource: ctx.resource, input_hash: ctx.input_hash }, proof })) === null;
  };
}
