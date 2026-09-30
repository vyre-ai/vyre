// @ts-check
// A test release for the Mac server proof (.github/workflows/mac-server.yml): this checkout packed the
// way vyre.tgz is (npm pack), signed with a THROWAWAY Ed25519 key made here and dropped when this
// process ends. The key is never written anywhere. Its public half replaces RELEASE_KEY inside the
// TEST tarball only, so the root installer in the tarball trusts it; the production key and the
// checkout are untouched.
//
//   node scripts/mac-proof/release.mjs OUTDIR     writes OUTDIR/site/{vyre.tgz,manifest.json,manifest.sig,SHA256SUMS}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const out = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: release.mjs OUTDIR"); process.exit(2); }
const site = path.join(out, "site"), pack = path.join(out, "pack"), tree = path.join(out, "tree");
for (const d of [site, pack, tree]) fs.mkdirSync(d, { recursive: true });

const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", pack], { encoding: "utf8" }).trim().split("\n").pop();
execFileSync("tar", ["-xzf", path.join(pack, name), "-C", tree]);
const top = path.join(tree, "package");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const rel = path.join(top, "core", "vyre-core", "release.js");
const src = fs.readFileSync(rel, "utf8");
const patched = src.replace(/export const RELEASE_KEY = "[^"]+";/, `export const RELEASE_KEY = "${spki}";`);
if (patched === src) throw new Error("RELEASE_KEY line not found in release.js");
fs.writeFileSync(rel, patched);

execFileSync("tar", ["-czf", path.join(site, "vyre.tgz"), "-C", tree, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const version = JSON.parse(fs.readFileSync(path.join(top, "package.json"), "utf8")).version;
const sha = (/** @type {string} */ f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(site, f))).digest("hex");
const manifest = Buffer.from(JSON.stringify({ version, tarball: "vyre.tgz", sha256: sha("vyre.tgz"), channel: "test" }));
fs.writeFileSync(path.join(site, "manifest.json"), manifest);
fs.writeFileSync(path.join(site, "manifest.sig"), crypto.sign(null, manifest, privateKey).toString("base64") + "\n");
fs.writeFileSync(path.join(site, "SHA256SUMS"), ["vyre.tgz", "manifest.json", "manifest.sig"].map((f) => `${sha(f)}  ${f}`).join("\n") + "\n");
fs.rmSync(tree, { recursive: true, force: true });
fs.rmSync(pack, { recursive: true, force: true });
console.log(`test release ${version} in ${site}`);
