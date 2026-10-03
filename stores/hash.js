// @ts-check
// The version hash (spec 3.7, R5-14). The gateway writes a hash of each record version into the
// event and verifies it on read. It covers only the fields the language declares for the type,
// in their Vyre form (sealed fields as the placeholder), never anything Twenty adds itself
// (timestamps, position, search vector, createdBy). A conformance test checks that.

import crypto from "node:crypto";

/** Canonical JSON: keys sorted, no whitespace. @param {any} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

/**
 * @param {string} type
 * @param {string} id
 * @param {Record<string, any>} fields declared fields only, Vyre form
 * @returns {string} "sha256:<hex>"
 */
export function recordHash(type, id, fields) {
  /** @type {Record<string, any>} */ const norm = {};
  for (const k of Object.keys(fields)) norm[k] = fields[k] === undefined ? null : fields[k];
  return "sha256:" + crypto.createHash("sha256").update(canonical({ type, id, fields: norm })).digest("hex");
}
