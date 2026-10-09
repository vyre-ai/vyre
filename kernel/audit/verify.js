// kernel/audit/verify.js: checks over public data that nothing in the kernel calls yet: a device verifying that an owner endorsed the Space key, an owner's revocation of it, and two devices
// comparing the checkpoints they hold. No grant is decided here and no secret is read, so this is not part of the trusted base (kernel/size.test.js). The device side of checkpoint comparison may still come.
import crypto from "node:crypto";
import * as chain from "../identity/chain.js";
import { KernelError } from "../core/errors.js";
import { endorsementBytes, revocationBytes } from "./key.js";
import { verifyCheckpoint, eventAt } from "./index.js";

/** @param {{ space: string, key_id: string }} key @param {{ by: string, via: string, viaPos: { via_seq: number, via_head: string }, ts: number, sign: (b: Uint8Array) => Promise<Uint8Array> }} owner */
export async function revokeKey(key, owner) {
  const body = { space: key.space, key_id: key.key_id, ts: owner.ts, via_seq: owner.viaPos.via_seq, via_head: owner.viaPos.via_head };
  return { ...body, by: owner.by, via: owner.via, sig: chain.b64u(await owner.sign(revocationBytes(body))) };
}

/** The public key object for a base64 SPKI. @param {string} pub */
export const publicKeyOf = pub => crypto.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });

/**
 * Check an endorsement against the Space's identity chain: the Space's list had this owner at that time, the owner's own chain had that device on it,
 * and the device's signature covers exactly this key. Throws a KernelError when it does not hold; returns the key to trust.
 * @param {any[]} spaceOps the Space's chain @param {any} e the endorsement @param {{ ownerOps: (id: string) => Promise<any[] | null>, now?: number }} ctx ownerOps: an owner's own whole chain
 * @returns {Promise<{ space: string, key_id: string, pub: string }>}
 */
export async function verifyEndorsement(spaceOps, e, ctx) {
  try {
    const now = ctx.now ?? Date.now();
    const state = await chain.stateAt(spaceOps, e.ts, { now, ownerOps: ctx.ownerOps });
    if (!state || state.kind !== "space" || state.id !== e.space) throw new Error("not this Space");
    if (crypto.createHash("sha256").update(Buffer.from(e.pub, "base64")).digest("hex").slice(0, 16) !== e.key_id) throw new Error("key id does not match the key");
    // `live`: the device must still be on the owner's current list as well as at the position it named, so a removed device cannot endorse.
    const { pub, signing } = await chain.signerKey(state, e.by, e.via, e.ts, { ownerOps: ctx.ownerOps, live: true, now }, { seq: e.via_seq, head: e.via_head });
    const ok = await chain.verifyWith(pub, endorsementBytes(e), e.sig, signing);
    if (!ok) throw new Error("bad signature");
  } catch (err) { throw new KernelError("bad_endorsement", "the Space key is not endorsed by an owner of the Space", String(err && /** @type {any} */ (err).message)); }
  return { space: e.space, key_id: e.key_id, pub: e.pub };
}

/**
 * Two devices compare the checkpoints they hold. The same position with two hashes is a split (the home told them different histories); a checkpoint
 * that is valid for neither is refused. Two honest checkpoints at different positions cannot be told apart without a log, so with one they are checked
 * for inclusion.
 * @param {any} a @param {any} b @param {crypto.KeyObject | string} publicKey @param {{ read(f?: any): any[] }} [log]
 * @returns {{ ok: boolean, why?: string }}
 */
export function compareCheckpoints(a, b, publicKey, log) {
  if (!verifyCheckpoint(a, publicKey) || !verifyCheckpoint(b, publicKey)) return { ok: false, why: "bad_signature" };
  if (a.seq === b.seq) return a.hash === b.hash ? { ok: true } : { ok: false, why: "split_history" };
  if (!log) return { ok: true };
  const [lo, hi] = a.seq < b.seq ? [a, b] : [b, a];
  const e = eventAt(log, lo.seq), h = eventAt(log, hi.seq);
  return e && e.hash === lo.hash && h && h.hash === hi.hash ? { ok: true } : { ok: false, why: "history_differs" };
}
