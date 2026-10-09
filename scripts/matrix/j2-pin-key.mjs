#!/usr/bin/env node
// scripts/matrix/j2-pin-key.mjs <key-dir>: for the J2b candidate on a CI runner only. Makes a throwaway Ed25519 key (good.pem, good.pub in <key-dir>) and pins its public half
// in this checkout where the daemon's copy of the release key is pinned, so build-site.sh can sign the candidate with it (VYRE_SIGNING_KEY) and the
// box boots the candidate's modules like a release's. The real key and its secret are never involved; nothing here is kept outside the runner.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (!process.env.CI) { console.error("j2-pin-key.mjs: runs on a CI runner only (CI is unset)"); process.exit(2); }
const dir = process.argv[2];
if (!dir) { console.error("usage: j2-pin-key.mjs <key-dir>"); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const kp = crypto.generateKeyPairSync("ed25519");
const pub = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
fs.writeFileSync(path.join(dir, "good.pem"), kp.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(path.join(dir, "good.pub"), pub);
const sigFile = "lib/release-sig.js";
const OLD = /^export const RELEASE_KEY = "(.*)";/m.exec(fs.readFileSync(sigFile, "utf8"))?.[1];
if (!OLD) { console.error("j2-pin-key: could not read the pinned key"); process.exit(1); }
let swapped = 0;
// The same four files scripts/dev-sign.mjs swaps: build-site.sh refuses a tree whose copies of the key differ.
for (const f of ["core/vyre-core/release.js", "box/vyre", "lib/release-sig.js", "scripts/install-mac-server.sh"]) {
  if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, "utf8");
  if (t.includes(OLD)) { fs.writeFileSync(f, t.split(OLD).join(pub)); swapped++; }
}
console.log(`j2-pin-key: ${swapped} files pinned to the throwaway key`);
