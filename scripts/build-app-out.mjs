#!/usr/bin/env node
// @ts-check
// build-app-out: the hosted phone app's release step. Takes the phone web export (apps/app's
// `expo export -p web` output) and seals what app.vyre.run serves, the way relay/app/release.js and
// scripts/deploy/verify-app-out.mjs expect: the fixed loader at the root and the app's build at
// v/<sha>/, each with its signed manifest, signed with the release key. The release workflow
// uploads the result as the `app-out` artifact; the deploy fetches only that.
//
//   VYRE_SIGNING_KEY=<pkcs8 pem> node scripts/build-app-out.mjs --dist apps/app/dist --release 0.2.0 [--out app-out]
//   node scripts/build-app-out.mjs --dist <dir> --release 0.2.0 --throwaway [--out <dir>]
//
// With the real key (the release environment's secret, from the environment, never an argument or a
// file) it refuses a key that is not the pinned RELEASE_KEY (core/vyre-core/release.js), so a wrong
// secret fails the release instead of shipping a build no box trusts. --throwaway signs with a fresh
// key made here, for a dry run and the tests: the result verifies against that key only, and the
// deploy's pinned-key check refuses it. Every folder is verified against the signing key before this
// returns, and the line the box's core/relay/releases.json gets is printed as JSON.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build, loader, verify, rawKey, publicOf } from "../relay/app/release.js";
import { RELEASE_KEY } from "../core/vyre-core/release.js";

/** The base URL the phone export is built with: apps/app/app.json experiments.baseUrl ("/app"), or none. */
export function baseUrlOf(file = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "apps", "app", "app.json")) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return String((j.expo || j).experiments?.baseUrl || ""); } catch { return ""; }
}

/**
 * @param {{ dist: string, release: string, out: string, pem?: string, throwaway?: boolean, base?: string, pinned?: string }} o
 *   release: plain x.y.z (a prerelease is never served: the release workflow skips this step for one).
 *   pinned: the public key a real run must match (SPKI base64); tests only, the default is the pinned RELEASE_KEY.
 * @returns {Promise<{ line: any, pub: string, folders: string[], throwaway: boolean }>}
 */
export async function buildAppOut({ dist, release, out, pem = "", throwaway = false, base = baseUrlOf(), pinned = RELEASE_KEY }) {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`${dist} has no index.html: build the web export first`);
  if (!/^\d+\.\d+\.\d+$/.test(release)) throw new Error(`release must be a plain x.y.z, got "${release}" (a prerelease is never served: skip this step for one)`);
  /** @type {string} */ let key = pem;
  if (throwaway) {
    if (pem) throw new Error("--throwaway and a signing key are two ways to sign: use one");
    key = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  } else if (!pem) throw new Error("no signing key: set VYRE_SIGNING_KEY (the release environment's secret), or pass --throwaway for a dry run");
  const pub = publicOf(key);
  if (!throwaway && !Buffer.from(pinned, "base64").subarray(-32).equals(Buffer.from(pub))) throw new Error("the signing key is not the pinned release key (core/vyre-core/release.js RELEASE_KEY)");
  rawKey(key); // an invalid key stops here, before anything is written
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const created = Date.now();
  await loader({ release, key, out, created });
  const line = await build({ dist, release, key, out, created, base });
  const folders = [out, path.join(out, "v", line.sha)];
  for (const f of folders) await verify(f, pub);
  return { line, pub: Buffer.from(pub).toString("base64url"), folders, throwaway };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const a = process.argv.slice(2);
  const flag = (/** @type {string} */ n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = await buildAppOut({ dist: flag("dist") || "apps/app/dist", release: flag("release") || "", out: flag("out") || "app-out", pem: process.env.VYRE_SIGNING_KEY || "", throwaway: a.includes("--throwaway"), ...(flag("base") !== undefined ? { base: flag("base") } : {}) });
    console.log(JSON.stringify(r.line));
    console.error(`app-out: sealed ${r.folders.length} folders, signed by ${r.throwaway ? "a throwaway key" : "the release key"} (${r.pub})`);
  } catch (e) { console.error(`build-app-out: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
