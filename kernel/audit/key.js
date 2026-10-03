// kernel/audit/key.js: the Space's checkpoint signing key and how the owners' devices come to trust it (DESIGN-wink 2; K5).
// A Space is an identity whose list holds its owners (names/worker/chain.js). The checkpoint key is a Space key: made and held by the sealing process
// on the Space's home (`spaceKey`, never returned), and ENDORSED by an owner: an owner's device signs `{ space, key_id, pub }`, the endorsement is
// kept in the log, and a device accepts the key only after checking that signature against the Space's own identity chain (the owner is on the list,
// the device is on the owner's own list as it stood then). So the home cannot swap the key under the devices, and the owners' devices hold the
// checkpoints it signs (kernel/audit/index.js `createDeviceCheckpoints`).
import crypto from "node:crypto";
import * as chain from "../../names/worker/chain.js";
import { KernelError } from "../core/errors.js";

const TAG = "vyre-space-key-v1\n";
const enc = new TextEncoder();

/** The bytes an owner's device signs to endorse the Space's checkpoint key. @param {{ space: string, key_id: string, pub: string, ts: number }} e */
export const endorsementBytes = e => enc.encode(TAG + chain.canonical({ space: e.space, key_id: e.key_id, pub: e.pub, ts: e.ts }));

/**
 * The signer the checkpointer uses: it asks the sealing process, which holds the key. @param {{ spaceKey: { pub(i: any): Promise<any>, sign(i: any): Promise<any> } }} sealer
 * @param {any} kernelChain a kernel-built chain for the audit module
 * @returns {Promise<{ key_id: string, pub: string, sign: (bytes: Buffer) => Promise<string> }>}
 */
export async function sealerKey(sealer, kernelChain) {
  const { key_id, pub } = await sealer.spaceKey.pub({ chain: kernelChain });
  return { key_id, pub, sign: async bytes => (await sealer.spaceKey.sign({ chain: kernelChain, bytes })).signature };
}

const REVOKE_TAG = "vyre-space-key-revoked-v1\n";
/** The bytes an owner's device signs to revoke the Space's checkpoint key. Any owner may. @param {{ space: string, key_id: string, ts: number }} r */
export const revocationBytes = r => enc.encode(REVOKE_TAG + chain.canonical({ space: r.space, key_id: r.key_id, ts: r.ts }));

/** @param {{ space: string, key_id: string }} key @param {{ by: string, via: string, ts: number, sign: (b: Uint8Array) => Promise<Uint8Array> }} owner */
export async function revokeKey(key, owner) {
  const body = { space: key.space, key_id: key.key_id, ts: owner.ts };
  return { ...body, by: owner.by, via: owner.via, sig: chain.b64u(await owner.sign(revocationBytes(body))) };
}

/** Check a revocation against the Space's identity chain, the same way an endorsement is checked. @param {any[]} spaceOps @param {any} r @param {{ resolve: any, now?: number }} ctx */
export async function verifyRevocation(spaceOps, r, ctx) {
  try {
    const state = await chain.stateAt(spaceOps, r.ts, { now: ctx.now ?? Date.now(), resolve: ctx.resolve });
    if (!state || state.kind !== "space" || state.id !== r.space) throw new Error("not this Space");
    const { pub } = await chain.signerKey(state, r.by, r.via, r.ts, { resolve: ctx.resolve });
    if (!(await chain.verifyWith(pub, revocationBytes(r), r.sig))) throw new Error("bad signature");
  } catch (err) { throw new KernelError("bad_revocation", "that is not an owner's revocation of the Space key", String(err && /** @type {any} */ (err).message)); }
  return { space: r.space, key_id: r.key_id };
}

/** The public key object for a base64 SPKI. @param {string} pub */
export const publicKeyOf = pub => crypto.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });

/**
 * Build the endorsement an owner's device signs. `sign(bytes)` is that device's key.
 * @param {{ space: string, key_id: string, pub: string }} key @param {{ by: string, via: string, ts: number, sign: (b: Uint8Array) => Promise<Uint8Array> }} owner
 */
export async function endorse(key, owner) {
  const body = { space: key.space, key_id: key.key_id, pub: key.pub, ts: owner.ts };
  return { ...body, by: owner.by, via: owner.via, sig: chain.b64u(await owner.sign(endorsementBytes(body))) };
}

/**
 * Check an endorsement against the Space's identity chain: the Space's list had this owner at that time, the owner's own chain had that device on it,
 * and the device's signature covers exactly this key. Throws a KernelError when it does not hold; returns the key to trust.
 * @param {any[]} spaceOps the Space's chain @param {any} e the endorsement @param {{ resolve: (eid: string, ts: number) => Promise<any>, now?: number }} ctx resolve: an owner's own identity state at a time
 * @returns {Promise<{ space: string, key_id: string, pub: string }>}
 */
export async function verifyEndorsement(spaceOps, e, ctx) {
  try {
    const state = await chain.stateAt(spaceOps, e.ts, { now: ctx.now ?? Date.now(), resolve: ctx.resolve });
    if (!state || state.kind !== "space" || state.id !== e.space) throw new Error("not this Space");
    if (crypto.createHash("sha256").update(Buffer.from(e.pub, "base64")).digest("hex").slice(0, 16) !== e.key_id) throw new Error("key id does not match the key");
    const { pub } = await chain.signerKey(state, e.by, e.via, e.ts, { resolve: ctx.resolve });
    const ok = await chain.verifyWith(pub, endorsementBytes(e), e.sig);
    if (!ok) throw new Error("bad signature");
  } catch (err) { throw new KernelError("bad_endorsement", "the Space key is not endorsed by an owner of the Space", String(err && /** @type {any} */ (err).message)); }
  return { space: e.space, key_id: e.key_id, pub: e.pub };
}
