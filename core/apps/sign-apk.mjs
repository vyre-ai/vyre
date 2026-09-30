#!/usr/bin/env node
// @ts-check
// sign-apk: sign an unsigned, zip-aligned APK with APK Signature Scheme v2 and v3, for CI or by
// hand. The same signer the box uses (core/apps/apk-sign.js); no JDK needed.
//
//   node core/apps/sign-apk.mjs --key key.pem --cert cert.pem --in unsigned.apk --out signed.apk
//
// --key is a PKCS#8 PEM (EC P-256 or RSA), --cert its certificate as PEM. Prints the signed file's
// sha256, size and the certificate's sha256 as JSON.

import crypto from "node:crypto";
import fs from "node:fs";
import { sign, certSha256 } from "./apk-sign.js";

const USAGE = "usage: node core/apps/sign-apk.mjs --key key.pem --cert cert.pem --in unsigned.apk --out signed.apk";

/** @param {string[]} argv */
function args(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(key|cert|in|out)$/.exec(argv[i]);
    if (!m || i + 1 >= argv.length) throw new Error(`unknown or incomplete argument ${argv[i]}\n${USAGE}`);
    out[m[1]] = argv[++i];
  }
  for (const k of ["key", "cert", "in", "out"]) if (!out[k]) throw new Error(`--${k} is required\n${USAGE}`);
  return out;
}

try {
  const a = args(process.argv.slice(2));
  const signed = sign(fs.readFileSync(a.in), { key: fs.readFileSync(a.key, "utf8"), cert: fs.readFileSync(a.cert, "utf8") });
  fs.writeFileSync(a.out + ".tmp", signed);
  fs.renameSync(a.out + ".tmp", a.out);
  process.stdout.write(JSON.stringify({ file: a.out, sha256: crypto.createHash("sha256").update(signed).digest("hex"), size: signed.length,
    cert_sha256: certSha256(fs.readFileSync(a.cert, "utf8")) }) + "\n");
} catch (e) {
  process.stderr.write(`sign-apk: ${/** @type {Error} */ (e).message}\n`);
  process.exit(1);
}
