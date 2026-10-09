// What a release does when it ships a first-party module: sign its folder's hash, and sign the document of lowest accepted versions. Test fixtures only; the real release signs elsewhere.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { treeHash } from "../kernel/modules/firstparty.js";

const SIG = "module.sig";

/** What a release does when it ships a module: sign its folder's hash. @param {string} dir @param {crypto.KeyObject} releasePrivateKey @returns {string} the signature (base64url), also written to module.sig */
export function signModule(dir, releasePrivateKey) {
  const sig = crypto.sign(null, Buffer.from(treeHash(dir)), releasePrivateKey).toString("base64url");
  fs.writeFileSync(path.join(dir, SIG), sig);
  return sig;
}

/**
 * The release signs the lowest version of each module it still accepts as first party (K-1) and a COUNTER, so an older signed document cannot be shown again
 * (K-2): a device that has accepted counter N refuses any document below N.
 * @param {Record<string, string>} minimums @param {crypto.KeyObject} releasePrivateKey @param {number} counter
 */
export function signMinimums(minimums, releasePrivateKey, counter = 1) {
  const body = JSON.stringify({ counter, minimums: Object.fromEntries(Object.entries(minimums).sort()) });
  return { body, sig: crypto.sign(null, Buffer.from("vyre-module-minimums-v2\n" + body), releasePrivateKey).toString("base64url") };
}
