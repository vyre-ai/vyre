// @ts-check
// The rules of "add this device to my name", with every outside thing handed in so Node tests it with stubs: the pairing (relay/client/phonepair.js), the key, the directory's list, the store.
// Nothing is kept until the directory's list holds this device's key, and a pairing that fails, is refused or runs out keeps nothing.

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @typedef {{ publicKey: string, eid: string }} Key
 * @typedef {{
 *   held(): Promise<boolean>,
 *   makeKey(): Promise<Key>,
 *   agree?(): Promise<string | null>,
 *   pageHeld?(): Promise<boolean>,
 *   pair(o: { key: { publicKey: string, agree?: string, held?: boolean }, onWords?: (w: string) => void, onAck?: (a: string) => void, signal?: AbortSignal }): Promise<{ enrolled: boolean, reason?: string, relay: string, route: string, box: string, device: string, name: string, identity?: { id?: string, vyre?: string } }>,
 *   readList(name: string): Promise<{ ops: any[], id: string, eids: string[], pin: any } | null>,
 *   save(i: { name: string, id: string, eid: string, ops: any[], pin: any, key: Key }): Promise<void>,
 *   keepPairing(p: { relay: string, route: string, box: string, name: string, device: string }): Promise<void>,
 * }} Deps
 */

/** The directory name of the identity a pairing joined: the identity's own Vyre name, else the other device's name. @param {{ name: string, identity?: { vyre?: string } }} r */
export const nameOfPairing = (r) => String((r.identity && r.identity.vyre) || r.name).trim().toLowerCase().replace(/\.vyre\.run$/, "");

/**
 * @param {Deps} d @param {{ deviceLabel: string, onWords?: (w: string) => void, onAck?: (a: string) => void, signal?: AbortSignal }} o
 * @returns {Promise<{ name: string, id: string }>}
 */
export async function addDeviceCore(d, o) {
  if (await d.held()) throw fail("exists", "This device already holds a name.");
  const key = await d.makeKey();
  const agree = d.agree ? await d.agree().catch(() => null) : null;
  const heldByPage = d.pageHeld ? await d.pageHeld().catch(() => false) : false;
  const r = await d.pair({ key: { publicKey: key.publicKey, ...(agree ? { agree } : {}), ...(heldByPage ? { held: true } : {}) }, ...(o.onWords ? { onWords: o.onWords } : {}), ...(o.onAck ? { onAck: o.onAck } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  if (!r.enrolled) throw fail("not_enrolled", r.reason || "The other device could not add this one.");
  const name = nameOfPairing(r);
  const list = await d.readList(name);
  if (!list) throw fail("not_listed", "The directory's list did not check out.");
  if (!list.eids.includes(key.eid)) throw fail("not_listed", "This device is not on the list yet.");
  await d.save({ name, id: list.id, eid: key.eid, ops: list.ops, pin: list.pin, key });
  await d.keepPairing({ relay: r.relay, route: r.route, box: r.box, name: r.name, device: r.device }).catch(() => {});
  return { name, id: list.id };
}
