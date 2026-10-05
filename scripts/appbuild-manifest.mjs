#!/usr/bin/env node
// scripts/appbuild-manifest.mjs <unpacked package root> --release X.Y.Z --counter N [--out FILE]
// The release's list of the web app's files (lib/app-build.js): the sha256 of every file under apps/app/dist of the UNPACKED tarball, so the hashes are of what a box will hold. It is made with
// no key and listed in SHA256SUMS, so the release key's one signature covers it. A package with no apps/app/dist makes no list (exit 0, nothing written).
import fs from "node:fs";
import path from "node:path";
import { buildAppList } from "../lib/app-build.js";

const args = process.argv.slice(2);
const root = args[0];
const opt = (/** @type {string} */ n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const release = opt("--release"), out = opt("--out"), counter = Number.parseInt(opt("--counter") || "", 10);
if (!root || !release || !Number.isInteger(counter) || counter < 0) { console.error("usage: appbuild-manifest.mjs <unpacked package root> --release X.Y.Z --counter N [--out FILE]"); process.exit(2); }
const dist = path.join(root, "apps", "app", "dist");
if (!fs.existsSync(dist)) { console.error("appbuild-manifest: no apps/app/dist in the package; no app list"); process.exit(0); }
// The two files the daemon makes rather than reads (core/daemon/app.js): made here from the same inputs and listed, so the signed list covers every byte under /app/ (MW-5).
// sw.js is only deterministic when the export's precache.json carries its build id; without one the daemon would stamp its own, so there is no list.
const pre = JSON.parse(fs.readFileSync(path.join(dist, "precache.json"), "utf8"));
if (typeof pre.build !== "string" || !pre.build) { console.error("appbuild-manifest: precache.json has no build id, so sw.js cannot be signed"); process.exit(1); }
const { appWorker, appManifest } = await import("../core/daemon/app.js");
const generated = {
  "sw.js": appWorker({ dir: dist, template: fs.readFileSync(path.join(root, "core", "daemon", "app-sw.js"), "utf8") }),
  "manifest.webmanifest": appManifest({ dir: dist, deckManifest: path.join(root, "web", "manifest.webmanifest") }),
};
const text = buildAppList(dist, release, counter, generated);
if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
