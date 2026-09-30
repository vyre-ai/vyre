#!/usr/bin/env node
// @ts-check
// build-phone: the static site behind phone.vyre.run (the phone's page at /pair/scan and the rest of the Deck's shell), built
// from a SIGNED release and nothing else, so the origin serves exactly what the release signature covers.
//
//   node scripts/build-phone.mjs --release DIR [--out phone-site]
//   node scripts/build-phone.mjs --tag v0.2.0 [--out phone-site]          (downloads the assets with gh)
//
// DIR holds the release's assets: vyre.tgz, SHA256SUMS, SHA256SUMS.sig and shell.json. The build refuses to start unless
// SHA256SUMS.sig verifies (lib/release-sig.js: Ed25519 over "vyre-release-sums\n" + SHA256SUMS, against the pinned release key),
// and vyre.tgz and shell.json are the files SHA256SUMS lists. It then lays out what a box's vyred serves for the Deck: deck/
// at the root, the few files the Deck imports from outside deck/, a sw.js stamped with the build (and told the release is
// signed, so it checks every new shell), /theme.css, and /release/ with SHA256SUMS, SHA256SUMS.sig and shell.json. Last, every
// file shell.json lists is hashed in the output and must match: what is deployed is what was signed.
//
// Deploy afterwards (after the lead approves):
//   npx wrangler pages deploy phone-site --project-name vyre-phone --branch main

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RELEASE_KEY, sumsSigned } from "../lib/release-sig.js";

const RESILIENCE = ["backoff", "sse", "stream", "outbox", "web"].map(n => `core/resilience/${n}.js`);
const RELAY_CLIENT = ["client", "channel", "bytes", "response", "sse", "webcrypto", "noise"].map(n => `relay/client/${n}.js`);
/** The Deck's own out-of-deck imports, as core/daemon/index.js serves them: only these files. */
export const OUTSIDE_DECK = [...RESILIENCE, ...RELAY_CLIENT, "lib/avatar-seed/index.js"];
const skip = (/** @type {string} */ rel) => /(^|\/)(test|fixtures|release|node_modules)(\/|$)|\.test\.js$|\.map$/.test(rel);
const sha = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
/** Where a shell path (as deck/sw.js lists it) is in the output. */
const outPath = (/** @type {string} */ p) => (p === "/" ? "index.html" : p.slice(1));

/** Sums from SHA256SUMS text: name -> hex. */
function parseSums(text) {
  /** @type {Record<string, string>} */ const out = {};
  for (const line of text.split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) [ *]([^ /]+)$/.exec(line);
    if (!m) throw new Error("SHA256SUMS is not a checksum list");
    out[m[2]] = m[1];
  }
  return out;
}

function copyTree(from, to, base = from) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), rel = path.relative(base, src);
    if (e.isSymbolicLink() || skip(rel)) continue;
    if (e.isDirectory()) copyTree(src, path.join(to, e.name), base);
    else if (e.isFile()) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(src, path.join(to, e.name)); }
  }
}

/**
 * @param {{ release: string, out: string, key?: string }} o
 * @returns {{ files: number, shell: number, build: string }}
 */
export function buildPhone({ release, out, key = RELEASE_KEY }) {
  const need = ["vyre.tgz", "SHA256SUMS", "SHA256SUMS.sig", "shell.json"];
  for (const n of need) if (!fs.existsSync(path.join(release, n))) throw new Error(`the release has no ${n}`);
  const sums = fs.readFileSync(path.join(release, "SHA256SUMS"));
  if (!sumsSigned(sums, fs.readFileSync(path.join(release, "SHA256SUMS.sig"), "utf8"), key)) throw new Error("SHA256SUMS.sig does not verify against Vyre's release key: refusing to build from it");
  const listed = parseSums(sums.toString("utf8"));
  for (const n of ["vyre.tgz", "shell.json"]) {
    if (listed[n] !== sha(fs.readFileSync(path.join(release, n)))) throw new Error(`${n} is not the file SHA256SUMS lists`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-phone-"));
  try {
    const x = spawnSync("tar", ["-xzf", path.join(release, "vyre.tgz"), "-C", tmp, "--strip-components=1"], { encoding: "utf8" });
    if (x.status !== 0) throw new Error(`could not unpack vyre.tgz: ${x.stderr.trim()}`);
    const deck = path.join(tmp, "deck");
    if (!fs.existsSync(path.join(deck, "index.html")) || !fs.existsSync(path.join(deck, "sw.js"))) throw new Error("vyre.tgz has no Deck (deck/index.html, deck/sw.js)");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    copyTree(deck, out);
    for (const rel of OUTSIDE_DECK) {
      const from = path.join(tmp, rel);
      if (!fs.existsSync(from)) throw new Error(`vyre.tgz has no ${rel}, which the Deck imports`);
      fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(out, rel));
    }
    // sw.js carries the build (a release is a new sw.js and a phone swaps its cache at once) and is told the release is signed.
    let commit = null, version = "0";
    try { const b = JSON.parse(fs.readFileSync(path.join(tmp, "build.json"), "utf8")); if (typeof b.commit === "string") commit = b.commit; } catch { /* unstamped */ }
    try { version = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8")).version || version; } catch { /* none */ }
    const id = (commit ? commit.slice(0, 12) : "v" + version).replace(/[^\w.-]/g, "");
    let sw = fs.readFileSync(path.join(deck, "sw.js"), "utf8");
    if (!sw.includes('const BUILD = "dev";')) throw new Error("deck/sw.js has no BUILD line to stamp");
    sw = sw.replace('const BUILD = "dev";', `const BUILD = ${JSON.stringify(id)};`).replace("const SHELL_SIGNED = false;", "const SHELL_SIGNED = true;");
    fs.writeFileSync(path.join(out, "sw.js"), sw);
    // The Deck links /theme.css: the defaults, since no box's config is behind this origin.
    fs.writeFileSync(path.join(out, "theme.css"), "/* Vyre's colours: the defaults are in tokens.css and deck.css. */\n");
    fs.mkdirSync(path.join(out, "release"), { recursive: true });
    for (const n of ["SHA256SUMS", "SHA256SUMS.sig", "shell.json"]) fs.copyFileSync(path.join(release, n), path.join(out, "release", n));
    // Pages: the Deck's headers (its CSP allows the production relay only) and the one shell for every client route. A real file
    // wins over the rewrite, and /release/* files always exist.
    fs.writeFileSync(path.join(out, "_headers"), [
      "# The Deck's headers (core/daemon deckHeaders), for the phone's origin. Cloudflare Pages reads this file.",
      "/*",
      "  Cache-Control: no-cache",
      "  X-Content-Type-Options: nosniff",
      "  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' wss://relay.vyre.run https://relay.vyre.run; frame-ancestors 'none'",
      "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
      "  Referrer-Policy: no-referrer", ""].join("\n"));
    fs.writeFileSync(path.join(out, "_redirects"), "/* /index.html 200\n");
    // What is deployed is what was signed: every file the signed shell.json lists, hashed here.
    const shell = JSON.parse(fs.readFileSync(path.join(release, "shell.json"), "utf8"));
    if (!shell || shell.v !== 1 || !Array.isArray(shell.files)) throw new Error("shell.json is not { v: 1, files: [...] }");
    for (const [p, hex] of shell.files) {
      const f = path.join(out, outPath(String(p)));
      if (!fs.existsSync(f)) throw new Error(`shell.json lists ${p}, which the build does not have`);
      if (sha(fs.readFileSync(f)) !== hex) throw new Error(`${p} in the build is not the file shell.json signed`);
    }
    let files = 0;
    const count = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) count(path.join(d, e.name)); else files++; } };
    count(out);
    return { files, shell: shell.files.length, build: id };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (/** @type {string} */ n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = path.resolve(arg("--out") || "phone-site");
  let release = arg("--release");
  try {
    if (!release) {
      const tag = arg("--tag");
      if (!tag) throw new Error("usage: build-phone.mjs --release DIR | --tag vX.Y.Z [--out DIR]");
      release = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-release-"));
      const g = spawnSync("gh", ["release", "download", tag, "--repo", "vyre-ai/vyre", "--dir", release, "-p", "vyre.tgz", "-p", "SHA256SUMS", "-p", "SHA256SUMS.sig", "-p", "shell.json"], { encoding: "utf8" });
      if (g.status !== 0) throw new Error(`could not download ${tag}: ${g.stderr.trim()}`);
    }
    const r = buildPhone({ release: path.resolve(release), out });
    console.log(`phone site: ${r.files} files in ${out}, build ${r.build}; the ${r.shell} shell files match the signed shell.json`);
  } catch (e) { console.error(`build-phone: ${/** @type {Error} */ (e).message}`); process.exit(1); }
}
