// @ts-check
// Serving a phone's enrolment, with every outside thing handed in (src/real/enrol-phone.ts gives the real ones): ask the server whether a phone is waiting to be added to the name's list, sign the list change
// with this app's identity key, and tell the server how it went so the waiting phone hears the answer.

/**
 * @typedef {{ publicKey: string, label?: string, agree?: string, enclave?: string }} Entry
 * @typedef {{
 *   call(tool: string, input?: any): Promise<any>,
 *   identity(): Promise<{ name: string, id: string, eid: string, ops: any[], pin: any, key: any } | null>,
 *   held(): Promise<boolean>,
 *   signers(mine: any): Promise<{ sign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array, esign?: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array }>,
 *   enrol(o: any): Promise<{ ops: any[], pin: any }>,
 *   save(i: any): Promise<void>,
 *   base: string,
 *   serving?: Set<string>,
 * }} Deps
 */

/** Serve the pending enrolment, if the server has one. Resolves true when one was served (yes or no). @param {Deps} d */
export async function serveEnrolWith(d) {
  const serving = d.serving || (d.serving = new Set());
  /** @type {any} */ let ask;
  try { ask = await d.call("wink.phone.pairing"); } catch { return false; }
  const e = ask && ask.enrol;
  if (!e || serving.has(e.device)) return false;
  serving.add(e.device);
  const tell = (/** @type {boolean} */ ok, /** @type {string} */ reason = "", /** @type {any} */ identity = undefined) => d.call("wink.phone.enrolled", { device: e.device, ok, ...(reason ? { reason } : {}), ...(identity ? { identity } : {}) }).catch(() => null);
  try {
    const mine = await d.identity();
    if (!mine) { await tell(false, "This device does not hold your Vyre name, so it cannot add another."); return true; }
    // A computer whose key a page script can reach cannot change who speaks for the name (the chain refuses it): say so, the phone adds it from another device.
    if (await d.held()) { await tell(false, "This computer cannot add a device to your name. Add it from your phone."); return true; }
    const signers = await d.signers(mine);
    const done = await d.enrol({ name: mine.name, eid: mine.eid, pin: mine.pin, base: d.base, ...signers, entry: e.entry });
    await d.save({ name: mine.name, id: mine.id, eid: mine.eid, ops: done.ops, pin: done.pin, key: mine.key });
    await tell(true, "", { id: mine.id, vyre: mine.name });
  } catch (err) {
    await tell(false, String((err && /** @type {Error} */ (err).message) || "The device could not be added to your name."));
  } finally { serving.delete(e.device); }
  return true;
}
