// @ts-check
// identity/login-store: where the sign-in records live. One small module, so the place can move (the owner is shaping a per-user folder in each space, users/<person id>/) without touching the protocol:
// the service only ever calls get(key) and set(key, value). Keys are `login:<username>` and `gh:<github id>`. Today it is one 0600 file, identity/logins.json.
import path from "node:path";
import { readJson, writePrivate } from "../../kernel/identity/files.js";

/** @param {string} root */
export function createLoginStore(root) {
  const file = path.join(root, "identity", "logins.json");
  return {
    get: (/** @type {string} */ k) => { const all = readJson(file); return all ? all[k] : undefined; },
    keys: () => Object.keys(readJson(file) || {}),
    set: (/** @type {string} */ k, /** @type {any} */ v) => { const all = readJson(file) || {}; all[k] = v; writePrivate(file, JSON.stringify(all) + "\n"); },
  };
}
