// Before the hosted app is deployed: every sealed folder of app-out (the loader at the root and each v/<sha>) verifies against
// the release public key pinned in the repository at the commit being deployed (core/vyre-core/release.js RELEASE_KEY),
// every file matching its manifest. A placeholder key, a missing manifest or one folder that fails stops the deploy.
//   node scripts/deploy/verify-app-out.mjs [app-out]
import fs from "node:fs";
import path from "node:path";
import { verify } from "../../relay/app/release.js";
import { MANIFEST } from "../../relay/app/manifest.js";
import { PLACEHOLDER } from "../check-release-key.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const dir = path.resolve(process.argv[2] || "app-out");
const spki = /export const RELEASE_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(root, "core", "vyre-core", "release.js"), "utf8"))?.[1];
if (!spki) { console.error("no RELEASE_KEY in core/vyre-core/release.js"); process.exit(1); }
if (spki === PLACEHOLDER) { console.error("RELEASE_KEY is still the placeholder: nothing signed by it is a release"); process.exit(1); }
const pub = new Uint8Array(Buffer.from(spki, "base64").subarray(-32));
const folders = [dir, ...(fs.existsSync(path.join(dir, "v")) ? fs.readdirSync(path.join(dir, "v")).map(n => path.join(dir, "v", n)) : [])]
  .filter(d => fs.existsSync(path.join(d, MANIFEST)));
if (!folders.length) { console.error(`no sealed folder in ${dir}`); process.exit(1); }
let bad = 0;
for (const f of folders) {
  try { console.log(`verified ${path.relative(dir, f) || "."}: manifest sha256 ${await verify(f, pub)}`); }
  catch (e) { bad++; console.error(`FAILED ${path.relative(dir, f) || "."}: ${e.message}`); }
}
process.exit(bad ? 1 : 0);
