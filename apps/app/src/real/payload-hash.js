// @ts-check
// The hash a person's key signs for an approval, recomputed here from the fields the person SEES (reviewer-2 AP-1): the box hands over a payload_hash with the card, and a box that could be altered must
// not be able to show one act and hand over the hash of another. Same bytes as kernel/seal/wire.js: sha-256 (base64url) over sorted-key JSON of { op, space, ...fields }.
import { b64url, sha256 } from "../auth/person.ts";

/** @param {any} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

/** @param {string} op @param {string} space @param {Record<string, any>} fields */
export const payloadHash = (op, space, fields) => b64url(sha256(new TextEncoder().encode(canonical({ op, space, ...fields }))));

/** Does the hash the box gave match the fields shown? @param {{ op: string, space: string, fields: Record<string, any>, payload_hash: string }} c */
export const hashMatches = (c) => typeof c.payload_hash === "string" && payloadHash(c.op, c.space, c.fields ?? {}) === c.payload_hash;
