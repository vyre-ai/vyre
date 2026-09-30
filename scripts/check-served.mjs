#!/usr/bin/env node
// @ts-check
// check-served: is what an origin serves for the setup page and the install line what the signed release says?
//
//   node scripts/check-served.mjs --origin https://vyre.run --release DIR
//
// DIR holds the release's SHA256SUMS, SHA256SUMS.sig and setup.json (scripts/setup-hashes.mjs). The signature is checked against
// the pinned release key (lib/release-sig.js, over "vyre-release-sums\n" + SHA256SUMS), setup.json must be the file SHA256SUMS lists,
// and then every path in it is fetched from the origin and hashed. One mismatch, or a path that does not answer 200, is a failure
// (exit 1): the origin serves something the release did not sign. PLAN section 5 row 1; run it after a deploy and in the matrix.
// It is a tamper check for what THIS request gets: an origin can answer another client or network differently, so run it from more than one place.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_KEY, sumsSigned } from "../lib/release-sig.js";

const sha = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * @param {{ origin: string, release: string, key?: string, fetch?: typeof fetch }} o
 * @returns {Promise<{ checked: number, problems: string[] }>}
 */
export async function checkServed({ origin, release, key = RELEASE_KEY, fetch: get = fetch }) {
  const need = (/** @type {string} */ n) => { const f = path.join(release, n); if (!fs.existsSync(f)) throw new Error(`the release has no ${n}`); return fs.readFileSync(f); };
  const sums = need("SHA256SUMS"), setup = need("setup.json");
  if (!sumsSigned(sums, need("SHA256SUMS.sig").toString("utf8"), key)) throw new Error("SHA256SUMS.sig does not verify against Vyre's release key: the release is not trusted");
  const line = sums.toString("utf8").split("\n").find(l => /^[0-9a-f]{64} [ *]setup\.json$/.test(l));
  if (!line || line.slice(0, 64) !== sha(setup)) throw new Error("setup.json is not the file the signed SHA256SUMS lists");
  const list = JSON.parse(setup.toString("utf8"));
  if (!list || list.v !== 1 || !Array.isArray(list.files)) throw new Error("setup.json is not { v: 1, files: [...] }");
  const base = origin.replace(/\/+$/, "");
  /** @type {string[]} */ const problems = [];
  for (const [p, hex] of list.files) {
    // One leading slash, nothing that could change the host or climb out: the path is signed, but it is built into a URL here.
    if (typeof p !== "string" || !/^\/(?!\/)[\x21-\x7e]*$/.test(p) || p.includes("..")) { problems.push(`${String(p).slice(0, 60)}: not a plain path`); continue; }
    let res;
    try { res = await get(base + p, { redirect: "manual", headers: { "cache-control": "no-cache", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" } }); } catch (e) { problems.push(`${p}: ${/** @type {Error} */ (e).message}`); continue; }
    if (res.status !== 200) { problems.push(`${p}: answered ${res.status}`); continue; }
    const got = sha(Buffer.from(await res.arrayBuffer()));
    if (got !== hex) problems.push(`${p}: serves ${got.slice(0, 12)}, the release signed ${String(hex).slice(0, 12)}`);
  }
  return { checked: list.files.length, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (/** @type {string} */ n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const origin = arg("--origin"), release = arg("--release");
  if (!origin || !release) { console.error("usage: check-served.mjs --origin https://vyre.run --release DIR"); process.exit(2); }
  checkServed({ origin, release: path.resolve(release) }).then(r => {
    for (const p of r.problems) console.error(`check-served: ${p}`);
    if (r.problems.length) process.exit(1);
    console.log(`check-served: ${r.checked} files at ${origin} match the signed release`);
  }, e => { console.error(`check-served: ${e.message}`); process.exit(1); });
}
