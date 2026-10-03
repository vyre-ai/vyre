// kernel/seal/wire.js: what the kernel, the sealing process and the person's signer agree on byte for byte.
// The signer (Deck, native apps) hashes the payload the person is shown with payloadHash and signs proofBytes with its hardware key; the sealing
// process recomputes both. Sorted-key JSON, no whitespace, so every implementation (Node today, Rust later) produces the same bytes.
import crypto from "node:crypto";

export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
export const sha256b64 = s => crypto.createHash("sha256").update(s).digest("base64url");
/** sha-256 (base64url) of the canonical payload a person approves: `{ op, space, ...fields }`, for example op "seal.reveal" with ref and purpose. */
export const payloadHash = (op, space, fields) => sha256b64(canonical({ op, space, ...fields }));
/** The bytes a presence proof signs: the proof without its signature. */
export const proofBytes = proof => { const { signature, ...rest } = proof; return Buffer.from(canonical(rest)); };
/** The chain summary the kernel hands the sealing process (it cannot see the branded Chain across a process). */
export function chainCtx(chain) {
  const hops = chain.hops, first = hops[0];
  return {
    space: chain.space, chain_hash: sha256b64(canonical(hops.map(h => [h.actor.kind, h.actor.id, h.actor.space]))),
    one_person: hops.length === 1 && first.actor.kind === "person", person: first.actor.kind === "person" ? first.actor.id : null,
    model_originated: hops.some(h => h.actor.kind === "agent"), surface: first.via?.surface ?? null,
  };
}
