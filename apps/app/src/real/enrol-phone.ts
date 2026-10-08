// A phone was added by this computer's person, and the server could not put the phone's key on the name's list because the name's key lives HERE, not on the server: this app signs the list
// change (one Touch ID or Face ID on a device with a chip key), sends it to the names directory, keeps the longer chain, and tells the server so the waiting phone hears the answer.
// Asked wherever the app already watches wink.phone.pairing (the Devices screen, the card on Now); safe to call often, one request is served once.

import { tool } from "./box";
import { enrolDevice } from "../identity/enrol-device.js";
import { loadIdentity, saveIdentity } from "../identity/store";
import { shellKeyHeld } from "../identity/mac-key.ts";
import { DIRECTORY } from "./install";

const serving = new Set<string>();

type Ask = { enrol?: { device: string; name?: string; entry: { publicKey: string; label?: string; agree?: string; enclave?: string } } };

/** Serve the pending phone enrolment, if the server has one. Resolves true when one was served (yes or no). */
export async function serveEnrol(): Promise<boolean> {
  let ask: Ask;
  try { ask = await tool<Ask>("wink.phone.pairing"); } catch { return false; }
  const e = ask?.enrol;
  if (!e || serving.has(e.device)) return false;
  serving.add(e.device);
  const tell = (ok: boolean, reason?: string, identity?: { id: string; vyre: string }) => tool("wink.phone.enrolled", { device: e.device, ok, ...(reason ? { reason } : {}), ...(identity ? { identity } : {}) }).catch(() => null);
  try {
    const mine = await loadIdentity();
    if (!mine) { await tell(false, "This device does not hold your Vyre name, so it cannot add another."); return true; }
    // A computer whose key a page script can reach cannot change who speaks for the name (the chain refuses it): say so, the phone adds it from another device.
    if (await shellKeyHeld()) { await tell(false, "This computer cannot add a device to your name. Add it from your phone."); return true; }
    const { hasKeys, listChangeSigners } = await import("../keys");
    const signers = (await hasKeys()).presence ? listChangeSigners("Add a device to your Vyre name") : { sign: (m: Uint8Array) => mine.key.sign(m) };
    const done = await enrolDevice({ name: mine.name, eid: mine.eid, pin: mine.pin, base: DIRECTORY, ...signers, entry: e.entry });
    await saveIdentity({ name: mine.name, id: mine.id, eid: mine.eid, ops: done.ops, pin: done.pin, key: mine.key });
    await tell(true, undefined, { id: mine.id, vyre: mine.name });
  } catch (err) {
    await tell(false, (err as Error)?.message || "The device could not be added to your name.");
  } finally { serving.delete(e.device); }
  return true;
}
