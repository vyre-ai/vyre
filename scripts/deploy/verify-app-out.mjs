// Before the hosted app is deployed: every sealed folder of app-out (the loader at the root and each v/<sha>) verifies against
// the release public key pinned in the repository at the commit being deployed (core/vyre-core/release.js RELEASE_KEY),
// every file matching its manifest, no file outside it, and the service worker is relay/app/sw.js stamped with that key. A placeholder
// key, a missing manifest, a stray file or one folder that fails stops the deploy.
//   node scripts/deploy/verify-app-out.mjs [app-out]
import fs from "node:fs";
import path from "node:path";
import { MANIFEST, folderOf } from "../../relay/app/manifest.js";
import { PLACEHOLDER } from "../check-release-key.mjs";
import { checkSealed } from "./seal-check.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const dir = path.resolve(process.argv[2] || "app-out");
const spki = /export const RELEASE_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(root, "core", "vyre-core", "release.js"), "utf8"))?.[1];
if (!spki) { console.error("no RELEASE_KEY in core/vyre-core/release.js"); process.exit(1); }
if (spki === PLACEHOLDER) { console.error("RELEASE_KEY is still the placeholder: nothing signed by it is a release"); process.exit(1); }
const pub = new Uint8Array(Buffer.from(spki, "base64").subarray(-32));
// The v/ tree holds only sealed build folders (named by 40 hex): a stray file or folder there would be served too.
if (fs.existsSync(path.join(dir, "v"))) {
  const bad = fs.readdirSync(path.join(dir, "v"), { withFileTypes: true }).filter(e => !e.isDirectory() || !/^[0-9a-f]{40}$/.test(e.name)).map(e => e.name);
  if (bad.length) { console.error(`FAILED v: not a sealed build folder: ${bad.slice(0, 5).join(", ")}`); process.exit(1); }
}
const folders = [dir, ...(fs.existsSync(path.join(dir, "v")) ? fs.readdirSync(path.join(dir, "v")).map(n => path.join(dir, "v", n)) : [])];
if (!fs.existsSync(path.join(dir, MANIFEST))) { console.error(`no sealed folder in ${dir}`); process.exit(1); }
let bad = 0;
for (const f of folders) {
  try {
    if (!fs.existsSync(path.join(f, MANIFEST))) throw new Error("no manifest: a folder that is not sealed would still be served");
    const sha = await checkSealed(f, pub, root, { loader: f === dir });
    // A build folder is named for its manifest, so one folder cannot stand in for another.
    if (f !== dir && path.basename(f) !== folderOf(sha)) throw new Error(`the folder is not named for its manifest (${folderOf(sha)})`);
    console.log(`verified ${path.relative(dir, f) || "."}: manifest sha256 ${sha}`);
  }
  catch (e) { bad++; console.error(`FAILED ${path.relative(dir, f) || "."}: ${e.message}`); }
}
process.exit(bad ? 1 : 0);
