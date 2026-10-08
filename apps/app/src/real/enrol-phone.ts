// A phone was added by this computer's person, and the server could not put the phone's key on the name's list because the name's key lives HERE, not on the server: this app signs the list
// change (one Touch ID or Face ID on a device with a chip key), sends it to the names directory, keeps the longer chain, and tells the server so the waiting phone hears the answer.
// Asked wherever the app already watches wink.phone.pairing (the Devices screen, the card on Now); safe to call often, one request is served once. The steps are enrol-serve.js.

import { tool } from "./box";
import { enrolDevice } from "../identity/enrol-device.js";
import { loadIdentity, saveIdentity } from "../identity/store";
import { shellKeyHeld } from "../identity/mac-key.ts";
import { DIRECTORY } from "./install";
import { serveEnrolWith } from "./enrol-serve.js";

const serving = new Set<string>();

/** Serve the pending phone enrolment, if the server has one. Resolves true when one was served (yes or no). */
export const serveEnrol = (): Promise<boolean> => serveEnrolWith({
  call: (name, input) => tool(name, input),
  identity: loadIdentity,
  held: shellKeyHeld,
  signers: async (mine) => {
    const { hasKeys, listChangeSigners } = await import("../keys");
    return (await hasKeys()).presence ? listChangeSigners("Add a device to your Vyre name") : { sign: (m: Uint8Array) => mine.key.sign(m) };
  },
  enrol: enrolDevice,
  save: saveIdentity,
  base: DIRECTORY,
  serving,
});
