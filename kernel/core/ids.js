// kernel/core/ids.js: the ONE file that mints ids (contract 2, Ids). Everything else that needs a time-ordered id imports it (records/ids.js adds only an in-process ordering on top).
//
// Layout and why: the id is a time-prefixed UUID in the v7 LAYOUT (48 bits of milliseconds first, then 12 bits, then the variant, then random), so sorting ids as text sorts them by time and a store can keep them in
// key order. The version nibble is 4, NOT 7, on purpose: Twenty (the objects layer behind records) validates ids as UUID versions 1 to 5 and rejects the v7 marker (spike, 3 Oct 2026), and a record id has to be
// accepted by it unchanged. Nothing reads the marker as a version: if a store ever takes 7 the nibble can change here and nowhere else. Ruling (team-lead, 6 Oct 2026): one minting file, v7 layout with the version-4 marker.
import { randomBytes } from "node:crypto";

const HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @param {number} [now] @param {(n: number) => Uint8Array} [rand] */
export function mintUuid(now = Date.now(), rand = n => randomBytes(n)) {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new RangeError("time out of range for an id");
  const r = rand(10);
  const b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x40 | (r[0] & 0x0f);
  b[7] = r[1];
  b[8] = 0x80 | (r[2] & 0x3f);
  for (let i = 3; i < 10; i++) b[9 + i - 3] = r[i];
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `dec_`, `gr_`, `evt_`... plus a time-prefixed uuid. @param {string} prefix */
export const mintId = (prefix, now = Date.now(), rand = undefined) => `${prefix}_${mintUuid(now, rand)}`;

export const isUuid = (/** @type {unknown} */ s) => typeof s === "string" && HEX.test(s);

/** The millisecond an id was minted at, or null when it is not one of ours. @param {string} id */
export function timeOf(id) {
  const u = String(id).slice(-36);
  return isUuid(u) ? parseInt(u.replace(/-/g, "").slice(0, 12), 16) : null;
}
