// @ts-check
// A master password or a recovery key is entered on the person's device. A model caller that supplies one is refused before any unwrap.

import { isPerson } from "./caller.js";

/** @param {any} caller @param {any} input */
export function modelSuppliedSecret(caller, input) {
  if (isPerson(caller)) return false;
  if (!input || typeof input !== "object") return false;
  return input.password != null || input.recovery != null || input.recoveryKey != null;
}

export const SECRET_REFUSED = "An agent cannot supply the master password or the recovery key. Enter it on your device.";
