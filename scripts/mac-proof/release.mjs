// @ts-check
// A test release for the Mac server proof (.github/workflows/mac-server.yml): this checkout packed the
// way vyre.tgz is (npm pack), signed with a THROWAWAY Ed25519 key made here and dropped when this
// process ends. The key is never written anywhere. Its public half replaces RELEASE_KEY inside the
// TEST tarball only, and into a COPY of the install script (run.sh), so both trust it; the production
// key, the script and the checkout are untouched.
//
//   node scripts/mac-proof/release.mjs OUTDIR     writes OUTDIR/site/{vyre.tgz,manifest.json,SHA256SUMS,SHA256SUMS.sig}

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

// A stand-in Vyre.app (the real one comes from capsule-mac.yml): a bundle with one Mach-O, so the
// installer's signing step runs for real. It ships unsigned; core signs it with its own identity.
const app = path.join(top, "Vyre.app", "Contents");
fs.mkdirSync(path.join(app, "MacOS"), { recursive: true });
fs.copyFileSync("/usr/bin/true", path.join(app, "MacOS", "Vyre"));
fs.writeFileSync(path.join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>sh.vyre.capsule</string><key>CFBundleExecutable</key><string>Vyre</string><key>CFBundleName</key><string>Vyre</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
execFileSync("codesign", ["--remove-signature", path.join(app, "MacOS", "Vyre")], { stdio: "ignore" }); // /usr/bin/true is Apple-signed: start from unsigned

execFileSync("tar", ["-czf", path.join(site, "vyre.tgz"), "-C", tree, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const version = JSON.parse(fs.readFileSync(path.join(top, "package.json"), "utf8")).version;
// The same signing code the release's sign job runs, with the throwaway key instead of the pinned one.
signRelease({ dir: site, version, channel: "test", pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), key: spki });
fs.writeFileSync(path.join(out, "release-key.pub"), spki); // the public half only, for the patched script copy
fs.rmSync(tree, { recursive: true, force: true });
fs.rmSync(pack, { recursive: true, force: true });
console.log(`test release ${version} in ${site}`);
