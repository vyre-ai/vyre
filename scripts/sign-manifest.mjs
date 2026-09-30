// @ts-check
// Sign a release: write manifest.json { version, tarball, sha256, channel? } and manifest.sig (base64
// Ed25519 over the exact manifest bytes) beside vyre.tgz. The private key (PKCS8 PEM) comes from the
// environment (VYRE_SIGNING_KEY, the release workflow's repo secret), never an argument and never a
// file. The signature is checked against the RELEASE_KEY pinned in core/vyre-core/release.js before
// anything is written, so a wrong secret fails the release instead of shipping a manifest no Mac trusts.
//
//   VYRE_SIGNING_KEY=... node scripts/sign-manifest.mjs TARBALL OUTDIR VERSION [CHANNEL]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RELEASE_KEY, verifyManifest } from "../core/vyre-core/release.js";

/**
 * @param {{ tarball: string, outDir: string, version: string, channel?: string, pem: string, key?: string }} o
 *   key: the public key to check against; tests only, the default is the pinned RELEASE_KEY.
 */
export function signManifest({ tarball, outDir, version, channel, pem, key = RELEASE_KEY }) {
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  const manifest = Buffer.from(JSON.stringify({ version, tarball: path.basename(tarball), sha256, ...(channel ? { channel } : {}) }));
  const sig = crypto.sign(null, manifest, crypto.createPrivateKey(pem)).toString("base64");
  verifyManifest(manifest, sig, { key }); // throws unless the signing key is the pinned one
  fs.writeFileSync(path.join(outDir, "manifest.json"), manifest);
  fs.writeFileSync(path.join(outDir, "manifest.sig"), sig + "\n");
  return { sha256 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tarball, outDir, version, channel] = process.argv.slice(2);
  const pem = process.env.VYRE_SIGNING_KEY || "";
  if (!tarball || !outDir || !version || !pem) { console.error("usage: VYRE_SIGNING_KEY=<pkcs8 pem> sign-manifest.mjs TARBALL OUTDIR VERSION [CHANNEL]"); process.exit(2); }
  try { const { sha256 } = signManifest({ tarball, outDir, version, channel, pem }); console.log(`signed ${version} (${sha256.slice(0, 12)}...)`); }
  catch (e) { console.error(`sign-manifest: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
