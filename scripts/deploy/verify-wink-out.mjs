// Before the camera page is deployed: the sealed folder of wink-out verifies against the release public key pinned in the repository
// at the commit being deployed (core/vyre-core/release.js RELEASE_KEY), every file matching its manifest, and the service worker is
// stamped with that same key. A placeholder key, a missing manifest, a throwaway-signed build or a folder that fails stops the deploy.
//   node scripts/deploy/verify-wink-out.mjs [wink-out]
import fs from "node:fs";
import path from "node:path";
import { verify } from "../../relay/app/release.js";
import { MANIFEST } from "../../relay/app/manifest.js";
import { PLACEHOLDER } from "../check-release-key.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const dir = path.resolve(process.argv[2] || "wink-out");
const spki = /export const RELEASE_KEY = "([^"]+)"/.exec(fs.readFileSync(path.join(root, "core", "vyre-core", "release.js"), "utf8"))?.[1];
if (!spki) { console.error("no RELEASE_KEY in core/vyre-core/release.js"); process.exit(1); }
if (spki === PLACEHOLDER) { console.error("RELEASE_KEY is still the placeholder: nothing signed by it is a release"); process.exit(1); }
const pub = new Uint8Array(Buffer.from(spki, "base64").subarray(-32));
if (!fs.existsSync(path.join(dir, MANIFEST))) { console.error(`no sealed folder in ${dir}`); process.exit(1); }
try {
  console.log(`verified ${path.basename(dir)}: manifest sha256 ${await verify(dir, pub)}`);
  const sw = fs.existsSync(path.join(dir, "sw.js")) ? fs.readFileSync(path.join(dir, "sw.js"), "utf8") : "";
  if (!sw.includes(`"${Buffer.from(pub).toString("base64url")}"`)) throw new Error("sw.js is not stamped with the pinned release key");
  if (!fs.existsSync(path.join(dir, "index.html"))) throw new Error("no index.html");
} catch (e) { console.error(`FAILED ${path.basename(dir)}: ${/** @type {Error} */ (e).message}`); process.exit(1); }
