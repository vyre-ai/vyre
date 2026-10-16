// @ts-check
// The one-screen recovery key: 128 bits, 26 base32 characters in groups of four. core/spaces/recovery.js newCode is this function.

import crypto from "node:crypto";
import { base32 } from "../../lib/bytes.js";

/** @param {(n: number) => Buffer} [random] */
export function newRecoveryCode(random = crypto.randomBytes) {
  return base32(random(16)).slice(0, 26).replace(/(.{4})(?=.)/g, "$1-");
}
