#!/usr/bin/env node
// scripts/modules-manifest.mjs <unpacked package root> --counter N --release X.Y.Z [--out FILE]
// The release's list of first-party modules: the hash of every shipped module folder, in the file the release signs (modules.json must be one of the lines of SHA256SUMS before it is
// signed). Run it on the UNPACKED package (the tarball's own contents), so the hashes are of what a box will hold. It uses the kernel's own hash, so the boot check agrees by construction.
import fs from "node:fs";
import { buildModuleList } from "../kernel/modules/release-list.js";

const args = process.argv.slice(2);
const root = args[0];
const opt = (/** @type {string} */ n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const counter = Number.parseInt(opt("--counter") || "", 10), release = opt("--release");
if (!root || !Number.isInteger(counter) || counter < 0 || !release) { console.error("usage: modules-manifest.mjs <unpacked package root> --counter N --release X.Y.Z [--out FILE]"); process.exit(2); }
const text = buildModuleList(root, { counter, release });
const out = opt("--out");
if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
