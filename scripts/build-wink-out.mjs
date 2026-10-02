#!/usr/bin/env node
// @ts-check
// build-wink-out: the camera page's release step (the wink.vyre.run twin of scripts/build-app-out.mjs). Seals the page
// (relay/wink: index.html, its scripts and the Deck's scanner and relay client it loads, a signed manifest, and the
// service worker stamped with the release public key) with the release key. The release workflow uploads the result
// as the `wink-out` artifact; the deploy fetches only that.
//
//   VYRE_SIGNING_KEY=<pkcs8 pem> node scripts/build-wink-out.mjs --release 0.2.0 [--out wink-out]
//   node scripts/build-wink-out.mjs --release 0.2.0 --throwaway [--out <dir>]
//
// A real run refuses a key that is not the pinned RELEASE_KEY (core/vyre-core/release.js); --throwaway signs with a
// fresh key for a dry run and the tests, which the deploy's pinned-key check refuses. The release is a plain x.y.z
// (a prerelease is never served). Every folder is verified against the signing key before this returns.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "../relay/wink/release.js";
import { verify, publicOf, rawKey } from "../relay/app/release.js";
import { RELEASE_KEY } from "../core/vyre-core/release.js";

/**
 * @param {{ release: string, out: string, pem?: string, throwaway?: boolean, pinned?: string }} o
 *   pinned: the public key a real run must match (SPKI base64); tests only, the default is the pinned RELEASE_KEY.
 */
export async function buildWinkOut({ release, out, pem = "", throwaway = false, pinned = RELEASE_KEY }) {
  if (!/^\d+\.\d+\.\d+$/.test(release)) throw new Error(`release must be a plain x.y.z, got "${release}" (a prerelease is never served: skip this step for one)`);
  /** @type {string} */ let key = pem;
  if (throwaway) {
    if (pem) throw new Error("--throwaway and a signing key are two ways to sign: use one");
    key = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  } else if (!pem) throw new Error("no signing key: set VYRE_SIGNING_KEY (the release environment's secret), or pass --throwaway for a dry run");
  rawKey(key);
  const pub = publicOf(key);
  if (!throwaway && !Buffer.from(pinned, "base64").subarray(-32).equals(Buffer.from(pub))) throw new Error("the signing key is not the pinned release key (core/vyre-core/release.js RELEASE_KEY)");
  const r = await build({ release, key, out });
  await verify(out, pub);
  return { ...r, pub: Buffer.from(pub).toString("base64url"), throwaway };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const a = process.argv.slice(2);
  const flag = (/** @type {string} */ n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = await buildWinkOut({ release: flag("release") || "", out: flag("out") || "wink-out", pem: process.env.VYRE_SIGNING_KEY || "", throwaway: a.includes("--throwaway") });
    console.log(JSON.stringify({ release: r.release, manifest: r.manifest, files: r.files }));
    console.error(`wink-out: sealed ${r.files} files, signed by ${r.throwaway ? "a throwaway key" : "the release key"} (${r.pub})`);
  } catch (e) { console.error(`build-wink-out: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
