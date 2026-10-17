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

/** A person who typed the secret, including through a first-party module hop, is not a model. @param {any} caller @param {any} input @param {any} [origin] */
export function modelSuppliedSecret(caller, input, origin) {
  if (isPerson(origin) || isPerson(caller)) return false;
  if (!input || typeof input !== "object") return false;
  return input.password != null || input.recovery != null || input.recoveryKey != null;
}

export const SECRET_REFUSED = "An agent cannot supply the master password or the recovery key. Enter it on your device.";
