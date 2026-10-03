// kernel/core/ids.js: time-prefixed ids (contract 2, Ids). 48 bits of milliseconds, the v4 version marker
// (Twenty rejects v7), the RFC variant, and random for the rest. Sorting by text is sorting by time.
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
