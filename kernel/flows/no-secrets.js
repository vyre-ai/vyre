// @ts-check
// kernel/flows/no-secrets: a Flow holds references, never values (R031-72). A Flow names a Connection or a vault item and the Vault uses it; a key, a password or a token written into a step is a value
// that would sit in the Flow's text, its versions, its approval card and every export. Saving refuses it and says where, without repeating it. Pure.

import { findSecrets } from "../../lib/credential-shapes.js";

/**
 * Every string in a Flow that is shaped like a credential, by path and kind. Never the value itself. The hash of a code step is not text a person wrote.
 * @param {any} flow @returns {{ path: string, kind: string }[]}
 */
export function secretsIn(flow) {
  /** @type {{ path: string, kind: string }[]} */ const out = [];
  const walk = (/** @type {any} */ v, /** @type {string} */ path) => {
    if (typeof v === "string") { for (const f of findSecrets(v).slice(0, 1)) out.push({ path, kind: f.kind }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "hash") walk(x, path ? `${path}.${k}` : k);
  };
  walk(flow, "");
  return out;
}
