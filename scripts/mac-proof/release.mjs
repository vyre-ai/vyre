// @ts-check
// A test release for the Mac server proof (.github/workflows/mac-server.yml): this checkout packed the
// way vyre.tgz is (npm pack), signed with a THROWAWAY Ed25519 key made here and dropped when this
// process ends. The key is never written anywhere. Its public half replaces RELEASE_KEY inside the
// TEST tarball only, and into a COPY of the install script (run.sh), so both trust it; the production
// key, the script and the checkout are untouched.
//
//   node scripts/mac-proof/release.mjs OUTDIR     writes OUTDIR/site/{vyre.tgz,modules.json,manifest.json,SHA256SUMS,SHA256SUMS.sig}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { signRelease } from "../sign-manifest.mjs";

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
// The kernel's module list is checked against lib/release-sig.js's copy of the key (scripts/check-release-key.mjs keeps the two equal): the test tarball trusts its throwaway key there too.
const sigFile = path.join(top, "lib", "release-sig.js");
const sigSrc = fs.readFileSync(sigFile, "utf8");
const sigPatched = sigSrc.replace(/export const RELEASE_KEY = "[^"]+";/, `export const RELEASE_KEY = "${spki}";`);
if (sigPatched === sigSrc) throw new Error("RELEASE_KEY line not found in lib/release-sig.js");
fs.writeFileSync(sigFile, sigPatched);

execFileSync("tar", ["-czf", path.join(site, "vyre.tgz"), "-C", tree, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const version = JSON.parse(fs.readFileSync(path.join(top, "package.json"), "utf8")).version;
// The signed list of first-party modules, made the way scripts/build-site.sh makes it, from the tarball just packed: without it vyred runs no module (no wink, so no space code).
const scripts = path.dirname(path.dirname(new URL(import.meta.url).pathname)); // this checkout's scripts/ (the tools are the checkout's, the hashes are of the tarball)
const unpacked = path.join(out, "unpacked");
fs.mkdirSync(unpacked, { recursive: true });
execFileSync("tar", ["-xzf", path.join(site, "vyre.tgz"), "-C", unpacked, "--strip-components=1"]);
const counter = execFileSync("node", [path.join(scripts, "release-counter.mjs"), version], { encoding: "utf8" }).trim();
execFileSync("node", [path.join(scripts, "modules-manifest.mjs"), unpacked, "--counter", counter, "--release", version, "--out", path.join(site, "modules.json")]);
fs.rmSync(unpacked, { recursive: true, force: true });
// The same signing code the release's sign job runs, with the throwaway key instead of the pinned one.
signRelease({ dir: site, version, channel: "test", pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), key: spki });
fs.writeFileSync(path.join(out, "release-key.pub"), spki); // the public half only, for the patched script copy
fs.rmSync(tree, { recursive: true, force: true });
fs.rmSync(pack, { recursive: true, force: true });
console.log(`test release ${version} in ${site}`);
