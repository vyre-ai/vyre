// @ts-check
// The hash a person's key signs for an approval, recomputed here from the fields the person SEES (reviewer-2 AP-1): the box hands over a payload_hash with the card, and a box that could be altered must
// not be able to show one act and hand over the hash of another. Same bytes as kernel/seal/wire.js: sha-256 (base64url) over sorted-key JSON of { op, space, fields } (the nested form, platform b1cc0b0ed: a field named op or space can no longer stand in for the real one).
import { b64url, sha256 } from "../auth/person.ts";
import { canonical } from "../../../../kernel/core/canonical.js";

/** Sorted-key JSON, no spaces: the kernel's canonical, imported not copied (kernel/core/canonical.js, which is kernel/seal/wire.js's byte for byte). */
export { canonical };

/** @param {string} op @param {string} space @param {Record<string, any>} fields */
export const payloadHash = (op, space, fields) => b64url(sha256(new TextEncoder().encode(canonical({ op, space, fields }))));

/** Does the hash the box gave match the fields shown? @param {{ op: string, space: string, fields: Record<string, any>, payload_hash: string }} c */
export const hashMatches = (c) => typeof c.payload_hash === "string" && payloadHash(c.op, c.space, c.fields ?? {}) === c.payload_hash;
