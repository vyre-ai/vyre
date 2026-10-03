// @ts-check
// Record ids: a time-prefixed UUID we mint (v7 layout, version nibble 4).
// 48-bit millisecond timestamp, then a 12-bit counter, then random bits. Twenty's validator only
// accepts UUID versions 1 to 5, so the marker is 4 (spike 2026-10-03). The id is still 128 bits,
// sorts lexically by time, and a store keeps it unchanged. If a store ever accepts version 7 the
// marker can change with no other change: nothing here reads the marker.

import crypto from "node:crypto";

let lastMs = 0;
let counter = 0;

/**
 * @param {{ now?: () => number, random?: (n: number) => Buffer }} [opts] injected for tests
 * @returns {string}
 */
export function mintId(opts = {}) {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? ((n) => crypto.randomBytes(n));
  let ms = now();
  if (ms <= lastMs) {
    // same millisecond (or clock stepped back): keep time monotonic and bump the counter
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) { ms += 1; counter = 0; }
  } else {
    counter = 0;
  }
  lastMs = ms;
  const b = random(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x40 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @param {unknown} s */
export const isRecordId = (s) => typeof s === "string" && ID_RE.test(s);

/** Milliseconds since the epoch encoded in an id. @param {string} id */
export function idTime(id) {
  if (!isRecordId(id)) throw new TypeError("not a record id");
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** Test hook: forget the monotonic state. */
export function _resetIds() { lastMs = 0; counter = 0; }
