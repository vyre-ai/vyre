// @ts-check
// Record ids. Minting is kernel/core/ids.js (the one file that mints ids: a time-prefixed UUID in the v7 layout with the version-4 marker, because Twenty rejects the v7 marker; the reason is written at the top of that file).
// This file adds only what a record store wants on top: ids from ONE process come out strictly in order, also within one millisecond and across a clock step back, by putting a 12-bit counter in the id's rand_a bits.

import crypto from "node:crypto";
import { mintUuid, isUuid, timeOf } from "../kernel/core/ids.js";

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
  const c = counter;
  return mintUuid(ms, (n) => { const r = random(n); r[0] = (c >> 8) & 0x0f; r[1] = c & 0xff; return r; });
}

/** @param {unknown} s */
export const isRecordId = (s) => isUuid(s);

/** Milliseconds since the epoch encoded in an id. @param {string} id */
export function idTime(id) {
  const t = timeOf(id);
  if (t === null || !isUuid(id)) throw new TypeError("not a record id");
  return t;
}

/** Test hook: forget the monotonic state. */
export function _resetIds() { lastMs = 0; counter = 0; }
