// The checks the two deploy verifiers share (verify-app-out.mjs, verify-wink-out.mjs). A sealed folder is only what its signed
// manifest lists, plus the manifest, its signature and, at the root of a loader, the service worker, which is written after sealing
// and so must equal relay/app/sw.js stamped with the pinned key, byte for byte. Anything else in the folder (a file the manifest
// does not list, a symlink, a second service worker in a build folder) stops the deploy: Cloudflare serves every file in the folder.
import fs from "node:fs";
import path from "node:path";
import { verify } from "../../relay/app/release.js";
import { MANIFEST, SIGNATURE } from "../../relay/app/manifest.js";

/** The service worker a release must carry: the repository's relay/app/sw.js with the pinned public key stamped in. @param {string} root @param {Uint8Array} pub */
export function expectedSw(root, pub) {
  return fs.readFileSync(path.join(root, "relay", "app", "sw.js"), "utf8").replace("{{RELEASE_PUB}}", Buffer.from(pub).toString("base64url"));
}

/** Every regular file under dir as a posix path; a symlink or anything else is an error. @param {string} dir @param {(rel: string) => boolean} [skip] */
export function walk(dir, skip = () => false, rel = "") {
  /** @type {string[]} */ const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    if (e.isDirectory()) out.push(...walk(dir, skip, r));
    else if (e.isFile()) out.push(r);
    else throw new Error(`${r} is not a regular file`);
  }
  return out;
}

/**
 * Verify one sealed folder against the pinned key and refuse any file the manifest does not list.
 * @param {string} dir @param {Uint8Array} pub @param {string} repoRoot
 * @param {{ loader: boolean }} o loader: the folder is a root that carries the stamped sw.js (and, for the app, a v/ tree sealed separately)
 * @returns {Promise<string>} the manifest's sha256
 */
export async function checkSealed(dir, pub, repoRoot, { loader }) {
  const sha = await verify(dir, pub);
  const listed = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")).files));
  const extra = walk(dir, r => loader && (r === "v" || r.startsWith("v/"))).filter(r => !listed.has(r) && r !== MANIFEST && r !== SIGNATURE && !(loader && r === "sw.js"));
  if (extra.length) throw new Error(`files the signed manifest does not list: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ` and ${extra.length - 5} more` : ""}`);
  if (loader) {
    const sw = path.join(dir, "sw.js");
    if (!fs.existsSync(sw)) throw new Error("no sw.js");
    if (fs.readFileSync(sw, "utf8") !== expectedSw(repoRoot, pub)) throw new Error("sw.js is not relay/app/sw.js stamped with the pinned release key");
  }
  return sha;
}
