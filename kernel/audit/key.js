// kernel/audit/key.js: the Space's checkpoint signing key and how the owners' devices come to trust it (DESIGN-wink 2; K5).
// A Space is an identity whose list holds its owners (kernel/identity/chain.js). The checkpoint key is a Space key: made and held by the sealing process
// on the Space's home (`spaceKey`, never returned), and ENDORSED by an owner: an owner's device signs `{ space, key_id, pub }`, the endorsement is
// kept in the log, and a device accepts the key only after checking that signature against the Space's own identity chain (the owner is on the list,
// the device is on the owner's own list as it stood then). So the home cannot swap the key under the devices, and the owners' devices hold the
// checkpoints it signs (kernel/audit/index.js `createDeviceCheckpoints`).
import * as chain from "../identity/chain.js";
import { KernelError } from "../core/errors.js";

const TAG = "vyre-space-key-v1\n";
const enc = new TextEncoder();

/** The bytes an owner's device signs to endorse the Space's checkpoint key: the key, and the position of the owner's own list the device relied on, so a removed device's signature cannot be backdated into validity. @param {{ space: string, key_id: string, pub: string, ts: number, via_seq: number, via_head: string }} e */
export const endorsementBytes = e => enc.encode(TAG + chain.canonical({ space: e.space, key_id: e.key_id, pub: e.pub, ts: e.ts, via_seq: e.via_seq, via_head: e.via_head }));

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
export const revocationBytes = r => enc.encode(REVOKE_TAG + chain.canonical({ space: r.space, key_id: r.key_id, ts: r.ts, via_seq: r.via_seq, via_head: r.via_head }));

/** Check a revocation against the Space's identity chain, the same way an endorsement is checked. @param {any[]} spaceOps @param {any} r @param {{ ownerOps: any, now?: number }} ctx */
export async function verifyRevocation(spaceOps, r, ctx) {
  try {
    const now = ctx.now ?? Date.now();
    const state = await chain.stateAt(spaceOps, r.ts, { now, ownerOps: ctx.ownerOps });
    if (!state || state.kind !== "space" || state.id !== r.space) throw new Error("not this Space");
    const { pub, signing } = await chain.signerKey(state, r.by, r.via, r.ts, { ownerOps: ctx.ownerOps, live: true, now }, { seq: r.via_seq, head: r.via_head });
    if (!(await chain.verifyWith(pub, revocationBytes(r), r.sig, signing))) throw new Error("bad signature");
  } catch (err) { throw new KernelError("bad_revocation", "that is not an owner's revocation of the Space key", String(err && /** @type {any} */ (err).message)); }
  return { space: r.space, key_id: r.key_id };
}

/**
 * Build the endorsement an owner's device signs. `sign(bytes)` is that device's key.
 * @param {{ space: string, key_id: string, pub: string }} key @param {{ by: string, via: string, viaPos: { via_seq: number, via_head: string }, ts: number, sign: (b: Uint8Array) => Promise<Uint8Array> }} owner
 */
export async function endorse(key, owner) {
  const body = { space: key.space, key_id: key.key_id, pub: key.pub, ts: owner.ts, via_seq: owner.viaPos.via_seq, via_head: owner.viaPos.via_head };
  return { ...body, by: owner.by, via: owner.via, sig: chain.b64u(await owner.sign(endorsementBytes(body))) };
}

