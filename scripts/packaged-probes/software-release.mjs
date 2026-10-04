#!/usr/bin/env node
// Run INSIDE a packaged tree (packaged-boot-proof.sh, from `docker exec`): node software-release.mjs /opt/vyre
// A release-kind build must refuse a software presence key even with VYRE_SEAL_SOFTWARE=1 and the dev flag set (reviewer-2's DP-1 probe, vault's software signer). Starts a REAL sealing
// process from this tree, tries to enrol a software signer, and exits 0 only when the error code is software_refused and the tree says release.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) { console.error("usage: software-release.mjs <package root>"); process.exit(2); }
const imp = (/** @type {string} */ f) => import(pathToFileURL(path.join(root, f)).href);
const { BUILD_KIND } = await imp("lib/build-kind.js");
if (BUILD_KIND !== "release") { console.error(`the tree says ${BUILD_KIND}, not release`); process.exit(1); }
const { startSealer } = await imp("kernel/seal/client.js");
const { signer, enrolDevice } = await imp("kernel/seal/testing.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swrel-"));
process.env.VYRE_SEAL_SOFTWARE = "1";
const s = startSealer({ dir, timeoutMs: 15000, dev: true, software: true });
let outcome = "";
try { const r = await enrolDevice(s, signer("per_alex", undefined, "software")); outcome = "ENROLLED attested=" + r.attested; } catch (e) { outcome = "refused:" + /** @type {any} */ (e).code; }
await s.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("software signer in a release build ->", outcome);
process.exit(outcome === "refused:software_refused" ? 0 : 1);
