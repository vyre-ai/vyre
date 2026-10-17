// @ts-check
// browser-profile-key-material: random wrap keys for sealed browser profile blobs (64 hex chars = 32 bytes).

import crypto from "node:crypto";

/** A new key field value for vyre-*-browser-profile-key vault items. */
export function generateProfileKeyMaterial() {
  return crypto.randomBytes(32).toString("hex");
}
