#!/usr/bin/env node
// scripts/dev-sign.mjs --root <unpacked package root> --out <dir>: what an install from a checkout (install-box.sh --from) does so its box boots its modules with no path rule and no
// development switch. A throwaway Ed25519 key is made here and never leaves this process; its public half replaces the pinned release key in the files that carry it (in THIS tree only:
// the checkout is never touched), then the module list (scripts/modules-manifest.mjs) is made from the tree as it now is and signed. The result is the three files a release carries:
// modules.json, SHA256SUMS and SHA256SUMS.sig, written to --out. The real release key is not used and nothing here can sign for it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const a = process.argv.slice(2);
const opt = (/** @type {string} */ n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const root = opt("--root"), out = opt("--out");
if (!root || !out) { console.error("usage: dev-sign.mjs --root <unpacked package root> --out <dir>"); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));

const kp = crypto.generateKeyPairSync("ed25519");
const pub = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const sigFile = path.join(root, "lib", "release-sig.js");
const OLD = /^export const RELEASE_KEY = "(.*)";/m.exec(fs.readFileSync(sigFile, "utf8"))?.[1];
if (!OLD) { console.error("dev-sign: could not read the pinned key"); process.exit(1); }
let swapped = 0;
for (const f of ["core/vyre-core/release.js", "box/vyre", "lib/release-sig.js", "scripts/install-mac-server.sh", "deck/sw.js"]) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  const t = fs.readFileSync(p, "utf8");
  if (t.includes(OLD)) { fs.writeFileSync(p, t.split(OLD).join(pub)); swapped++; }
}
if (!fs.readFileSync(sigFile, "utf8").includes(pub)) { console.error("dev-sign: the key was not pinned"); process.exit(1); }

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
let counter = 1;
try { const { releaseCounter } = await import(path.join(HERE, "release-counter.mjs")); counter = releaseCounter(pkg.version); } catch { /* a development version: counter 1 */ }
fs.mkdirSync(out, { recursive: true });
const modules = path.join(out, "modules.json");
const r = spawnSync(process.execPath, [path.join(root, "scripts", "modules-manifest.mjs"), root, "--counter", String(counter), "--release", pkg.version, "--out", modules], { encoding: "utf8" });
if (r.status !== 0) { console.error("dev-sign: the module list could not be made: " + (r.stderr || r.stdout).trim()); process.exit(1); }
const sums = `${crypto.createHash("sha256").update(fs.readFileSync(modules)).digest("hex")}  modules.json\n`;
fs.writeFileSync(path.join(out, "SHA256SUMS"), sums);
const sig = crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), Buffer.from(sums)]), kp.privateKey).toString("base64");
fs.writeFileSync(path.join(out, "SHA256SUMS.sig"), sig + "\n");
console.log(`dev-sign: ${swapped} files pinned to a throwaway key, ${Object.keys(JSON.parse(fs.readFileSync(modules, "utf8")).modules).length} modules signed (counter ${counter})`);
