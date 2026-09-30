// @ts-check
// release-sig: the one release signature every updater checks (box/vyre, `vyre update` on a Mac, vyre-core). A release carries
// SHA256SUMS.sig, base64 Ed25519 over the line "vyre-release-sums" and then the exact bytes of SHA256SUMS; the checksums vouch
// for every other file. The key is pinned here and never taken from a download. Pure: no feature state.

import crypto from "node:crypto";

/** Vyre's release public key: Ed25519, base64 SPKI DER. Also pinned in box/vyre and scripts/install-mac-server.sh. */
export const RELEASE_KEY = "MCowBQYDK2VwAyEAKXSdujH7tO/gscXCJZmYCjB+Cv1sVlOfdgLNedMR7FU=";
/** What comes before the SHA256SUMS bytes in the signed message (domain separation from anything else the key signs). */
export const SUMS_PREFIX = Buffer.from("vyre-release-sums\n");

/**
 * Whether `sigText` (base64) is a valid signature over the prefix and `sums`, by `key`.
 * @param {string | Buffer} sums @param {string | Buffer} sigText @param {string} [key]
 */
export function sumsSigned(sums, sigText, key = RELEASE_KEY) {
  try {
    const text = Buffer.from(String(sigText)).toString("utf8").trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
    const pub = crypto.createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.concat([SUMS_PREFIX, Buffer.from(sums)]), pub, Buffer.from(text, "base64"));
  } catch { return false; }
}
