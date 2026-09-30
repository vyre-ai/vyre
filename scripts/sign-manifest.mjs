// @ts-check
// Sign a release with the ONE signature Linux and Mac both verify: SHA256SUMS.sig, base64 Ed25519 over
// the exact bytes of SHA256SUMS. In DIR (which holds vyre.tgz and the other built files) this writes
//   manifest.json      { version, tarball, sha256, channel? }: the version for the anti-rollback floor
//   SHA256SUMS         every file in DIR (manifest.json included) except itself, its signature and notes.md
//   SHA256SUMS.sig     the signature
// The private key (PKCS8 PEM) comes from the environment (VYRE_SIGNING_KEY, the release workflow's
// environment secret), never an argument and never a file. The signature is checked against the
// RELEASE_KEY pinned in core/vyre-core/release.js before it is written, so a wrong secret fails the
// release instead of shipping a signature no Mac or box trusts.
//
//   VYRE_SIGNING_KEY=... node scripts/sign-manifest.mjs DIR VERSION [CHANNEL]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RELEASE_KEY, verifySums } from "../core/vyre-core/release.js";

const SKIP = new Set(["SHA256SUMS", "SHA256SUMS.sig", "notes.md"]);

/**
 * @param {{ dir: string, version: string, channel?: string, pem: string, key?: string }} o
 *   key: the public key to check against; tests only, the default is the pinned RELEASE_KEY.
 */
export function signRelease({ dir, version, channel, pem, key = RELEASE_KEY }) {
  const sha = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
  const tarball = path.join(dir, "vyre.tgz");
  const manifest = Buffer.from(JSON.stringify({ version, tarball: "vyre.tgz", sha256: sha(fs.readFileSync(tarball)), ...(channel ? { channel } : {}) }));
  fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !SKIP.has(e.name)).map((e) => e.name).sort();
  const sums = Buffer.from(names.map((n) => `${sha(fs.readFileSync(path.join(dir, n)))}  ${n}`).join("\n") + "\n");
  const sig = crypto.sign(null, sums, crypto.createPrivateKey(pem)).toString("base64");
  verifySums(sums, sig, { key }); // throws unless the signing key is the pinned one
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums);
  fs.writeFileSync(path.join(dir, "SHA256SUMS.sig"), sig + "\n");
  return { lines: names.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, version, channel] = process.argv.slice(2);
  const pem = process.env.VYRE_SIGNING_KEY || "";
  if (!dir || !version || !pem) { console.error("usage: VYRE_SIGNING_KEY=<pkcs8 pem> sign-manifest.mjs DIR VERSION [CHANNEL]"); process.exit(2); }
  try { const { lines } = signRelease({ dir, version, channel, pem }); console.log(`signed ${version}: SHA256SUMS lists ${lines} files`); }
  catch (e) { console.error(`sign-manifest: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
