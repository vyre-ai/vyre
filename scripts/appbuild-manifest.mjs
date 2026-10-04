#!/usr/bin/env node
// scripts/appbuild-manifest.mjs <unpacked package root> --release X.Y.Z [--out FILE]
// The release's list of the web app's files (lib/app-build.js): the sha256 of every file under apps/app/dist of the UNPACKED tarball, so the hashes are of what a box will hold. It is made with
// no key and listed in SHA256SUMS, so the release key's one signature covers it. A package with no apps/app/dist makes no list (exit 0, nothing written).
import fs from "node:fs";
import path from "node:path";
import { buildAppList } from "../lib/app-build.js";

const args = process.argv.slice(2);
const root = args[0];
const opt = (/** @type {string} */ n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const release = opt("--release"), out = opt("--out");
if (!root || !release) { console.error("usage: appbuild-manifest.mjs <unpacked package root> --release X.Y.Z [--out FILE]"); process.exit(2); }
const dist = path.join(root, "apps", "app", "dist");
if (!fs.existsSync(dist)) { console.error("appbuild-manifest: no apps/app/dist in the package; no app list"); process.exit(0); }
const text = buildAppList(dist, release);
if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
