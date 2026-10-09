// kernel/modules/firstparty.js: what makes a module first party (K6; the one place a module becomes trusted). Not a path, not a name: a signature. A release
// signs the hash of each shipped module's folder with the release key (the same pinned key that signs updates); a module is first party only when its
// `module.sig` verifies over the hash of its folder's present contents under that key. An edited file, an added file or a swapped signature makes it not first
// party, so it runs under the supervisor like any other. Symlinks and anything that is not a regular file are refused outright.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SIG = "module.sig";

/** The hash of a module folder: every regular file but the signature, by relative path, in a fixed order. Throws on a symlink or a special file. @param {string} dir */
export function treeHash(dir) {
  /** @type {[string, string][]} */ const files = [];
  const walk = (/** @type {string} */ d, /** @type {string} */ rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name), r = rel ? `${rel}/${name}` : name, st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw new Error(`${r} is not a plain file`);
      if (st.isDirectory()) walk(p, r); else if (r !== SIG) files.push([r, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")]);
    }
  };
  walk(dir, "");
  return crypto.createHash("sha256").update("vyre-module-tree-v1\n" + JSON.stringify(files)).digest("hex");
}

const semver = (/** @type {string} */ v) => String(v).split(".").map(x => Number.parseInt(x, 10) || 0);
const atLeast = (/** @type {string} */ v, /** @type {string} */ min) => { const a = semver(v), b = semver(min); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return true; };

/** A public key as a KeyObject: a KeyObject, a PEM, or the base64 SPKI DER the release pins (lib/release-sig.js RELEASE_KEY). @param {crypto.KeyObject | string} k */
export const keyOf = k => (typeof k !== "string" ? k : k.includes("BEGIN") ? crypto.createPublicKey(k) : crypto.createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }));

/** @param {{ body: string, sig: string }} doc @param {crypto.KeyObject | string} releaseKey @returns {{ counter: number, minimums: Record<string, string> } | null} null when the signature does not verify */
export function verifyMinimums(doc, releaseKey) {
  try {
    if (!crypto.verify(null, Buffer.from("vyre-module-minimums-v2\n" + doc.body), keyOf(releaseKey), Buffer.from(doc.sig, "base64url"))) return null;
    const d = JSON.parse(doc.body);
    return Number.isInteger(d.counter) && d.minimums && typeof d.minimums === "object" ? d : null;
  } catch { return null; }
}
/** Verify a minimums document and refuse a rollback: below the highest counter already accepted is refused. @returns {{ counter: number, minimums: Record<string, string> } | null} */
export function acceptMinimums(doc, releaseKey, lastCounter = 0) { const d = verifyMinimums(doc, releaseKey); return d && d.counter >= lastCounter ? d : null; }

/**
 * @param {{ releaseKey: crypto.KeyObject | string, minimums?: Record<string, string> | null }} cfg the pinned release public key, and the release-signed minimum versions
 *   (already verified with `verifyMinimums`); a module below its minimum is not first party, however well it is signed
 * @returns {(dir: string) => boolean}
 */
export function createFirstPartyCheck(cfg) {
  const key = keyOf(cfg.releaseKey);
  return dir => {
    try {
      const sig = fs.readFileSync(path.join(dir, SIG), "utf8").trim();
      if (!crypto.verify(null, Buffer.from(treeHash(dir)), key, Buffer.from(sig, "base64url"))) return false;
      if (cfg.minimums) {
        // The version read is the one inside the signed tree, so it cannot be edited without breaking the signature.
        const m = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8"));
        const min = cfg.minimums[m.name];
        if (min === undefined || !atLeast(String(m.version), min)) return false;
      }
      return true;
    } catch { return false; }
  };
}
