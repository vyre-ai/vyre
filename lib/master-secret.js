// @ts-check
// A master password or a recovery key is entered on the person's device. A model caller that supplies one is refused before any unwrap.

import { isPerson } from "./caller.js";

/** Field names that carry a password or a recovery key. Compared with underscores and hyphens removed. */
const SECRET_FIELDS = new Set(["password", "passphrase", "secret", "secretkey", "recovery", "recoverykey", "masterpassword"]);

/** @param {unknown} key */
export function isSecretField(key) {
  return SECRET_FIELDS.has(String(key).replace(/[_-]/g, "").toLowerCase());
}

/**
 * Remove secret-shaped fields from a call, including nested ones, before a card is built or stored.
 * A plain object is edited in place and returned, so the digest, the card and the call that runs all see the stripped input.
 * A frozen object is returned as a stripped copy.
 * @param {any} input
 */
export function stripSecrets(input) {
  const seen = new Set();
  const walk = (/** @type {any} */ v) => {
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Object.isFrozen(v)) {
      if (Array.isArray(v)) return v.map(walk);
      /** @type {Record<string, any>} */ const out = {};
      for (const k of Object.keys(v)) if (!isSecretField(k)) out[k] = walk(v[k]);
      return out;
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
    for (const k of Object.keys(v)) {
      if (isSecretField(k)) delete v[k];
      else v[k] = walk(v[k]);
    }
    return v;
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
