// kernel/core/presence.js: the one presence interface the kernel uses (invariant 4). There is one verifier: the sealing process's, which holds
// the enrolled keys, the MACed key list and the recovery state (kernel/seal). A kernel act that a person signs (a task approval, an unblock)
// asks it through `check`; nothing else in the kernel verifies a signature. The signer hashes the payload with `payloadHash` and signs the
// proof bytes (kernel/seal/wire.js); a proof binds the person, the op, the fields, the chain and a single use.
import { isChain } from "./chain.js";
import { KernelError } from "./errors.js";

export { payloadHash, proofBytes } from "../seal/wire.js";

/**
 * @typedef {{ check(i: { chain: any, op: string, fields: Record<string, unknown>, proof: any, dry?: boolean }): Promise<string | null> }} PresenceVerifier
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
 * @param {PresenceVerifier} presence @returns {(proof: any, ctx: any) => Promise<{ ok: boolean, reason?: string }>} ok, or why the proof was refused (the verifier's stable code)
 */
export function grantProofVerifier(presence) {
  return async (proof, ctx) => {
    const m = /^(grants|rules|project)\.([a-z_]+)$/.exec(String(ctx && ctx.action));
    if (!m || !ctx.input_hash) return { ok: false, reason: "no_proof" };
    // A standing-rule act is signed as a grant act named `grant.rule_<verb>`: the sealing process accepts only task and grant acts, and a rule is one (it changes what is allowed). Moving a project out
    // (`project.move_out`) is a grant-class act too: it is signed as `grant.move_out`.
    const op = m[1] === "rules" ? `grant.rule_${m[2]}` : `grant.${m[2]}`;
    const why = await presence.check({ chain: ctx.chain, op, fields: { resource: ctx.resource, input_hash: ctx.input_hash }, proof });
    return why === null ? { ok: true } : { ok: false, reason: why };
  };
}

/**
 * Presence over the peer wire (the lead's ruling): a remote device signs a CHALLENGE the home issued, and the proof carries what ties it to that challenge as two extra fields that the signer
 * signs like every other (the proof's signed bytes are every field but the signature): `home` (the home's own Space id) and `challenge` (the one-use nonce the home issued). The kernel's one
 * verifier (the sealing process) checks the signature, the key (a device on the person's signed list, via the pinned-chain bind), the op and the nonce `nonce` (single use); THIS checks that the
 * proof names this home and this challenge, so a proof made for another home, or another challenge, is refused, and a replay is refused by the single-use `nonce` and by the wire spending the
 * challenge. The peer session alone is never presence. Returns null when the binding holds, else a short reason.
 * @param {any} proof @param {{ home: string, challenge: string }} want @returns {string | null}
 */
export function remoteBinding(proof, want) {
  if (!proof || typeof proof !== "object") return "no_proof";
  if (typeof want.home !== "string" || !want.home || typeof want.challenge !== "string" || !want.challenge) return "no_challenge";
  if (proof.home !== want.home) return "wrong_home";
  if (proof.challenge !== want.challenge) return "wrong_challenge";
  return null;
}
