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

/** What a release does when it ships a module: sign its folder's hash. @param {string} dir @param {crypto.KeyObject} releasePrivateKey @returns {string} the signature (base64url), also written to module.sig */
export function signModule(dir, releasePrivateKey) {
  const sig = crypto.sign(null, Buffer.from(treeHash(dir)), releasePrivateKey).toString("base64url");
  fs.writeFileSync(path.join(dir, SIG), sig);
  return sig;
}

/** @param {{ releaseKey: crypto.KeyObject | string }} cfg the pinned release public key @returns {(dir: string) => boolean} */
export function createFirstPartyCheck(cfg) {
  const key = typeof cfg.releaseKey === "string" ? crypto.createPublicKey(cfg.releaseKey) : cfg.releaseKey;
  return dir => {
    try {
      const sig = fs.readFileSync(path.join(dir, SIG), "utf8").trim();
      return crypto.verify(null, Buffer.from(treeHash(dir)), key, Buffer.from(sig, "base64url"));
    } catch { return false; }
  };
}
