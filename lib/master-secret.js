// @ts-check
// A master password or a recovery key is entered on the person's device. A model caller that supplies one is refused before any unwrap.
// The names are the one list in lib/secret-keys.js. Approval cards and the kernel egress ask that list.

import { isPerson } from "./caller.js";
import { egressNameIsSecret } from "./secret-keys.js";

/** @param {unknown} key */
export function isSecretField(key) {
  return egressNameIsSecret(String(key));
}

/**
 * A copy of a call with secret-shaped fields removed, including nested ones, for the card, its digest and what is stored.
 * The call that runs keeps its own object, so a vault item named `secret` still reaches the tool.
 * @param {any} input
 */
export function stripSecrets(input) {
  const seen = new Map();
  const walk = (/** @type {any} */ v) => {
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return seen.get(v);
    if (Array.isArray(v)) {
      const out = [];
      seen.set(v, out);
      for (const x of v) out.push(walk(x));
      return out;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
    /** @type {Record<string, any>} */ const out = {};
    seen.set(v, out);
    for (const k of Object.keys(v)) if (!isSecretField(k)) out[k] = walk(v[k]);
    return out;
  };
  return walk(input);
}

/** @param {any} caller @param {any} input */
export function modelSuppliedSecret(caller, input) {
  if (isPerson(caller)) return false;
  if (!input || typeof input !== "object") return false;
  return input.password != null || input.recovery != null || input.recoveryKey != null;
}

export const SECRET_REFUSED = "An agent cannot supply the master password or the recovery key. Enter it on your device.";
