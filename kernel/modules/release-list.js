// kernel/modules/release-list.js: the release's signed list of first-party modules (a packaged box). A release ships three files at the package root: `SHA256SUMS`, its signature
// `SHA256SUMS.sig` (the Ed25519 release key signs it already, lib/release-sig.js), and `modules.json`:
//   { v: 1, counter: N, release: "0.3.0", modules: { "<name>": { version, tree: "<treeHash hex>" } } }
// `modules.json` is one more line in SHA256SUMS, so the one existing signature covers it: no new key and no key in the image build. A module folder is first party when the signed list
// names it, its folder hashes to the listed tree (the same `treeHash` the per-module signature uses) and its module.json says the listed version. `counter` makes a rollback visible:
// the kernel keeps the highest it has accepted (kernel/home.js, in its sealed log) and never goes back to a lower one.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sumsSigned } from "../../lib/release-sig.js";
import { treeHash } from "./firstparty.js";

const MAX = 1_000_000;
/** The pinned key as the base64 SPKI DER string lib/release-sig.js takes, from that string or a KeyObject (tests). @param {any} k */
const der = k => (k === undefined || typeof k === "string" ? k : k.export({ type: "spki", format: "der" }).toString("base64"));
const sha256 = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * Read and verify the signed list under a package root.
 * @param {string} root the package root (where lib/ and kernel/ live) @param {any} [releaseKey] base64 SPKI DER or a public KeyObject, default the compiled key
 * @returns {{ ok: true, counter: number, modules: Record<string, { version: string, tree: string }>, raw: { list: string, sums: string, sig: string } } | { ok: false, why: string }}
 */
export function readReleaseList(root, releaseKey) {
  /** @param {string} f */
  const read = f => { const p = path.join(root, f); const st = fs.lstatSync(p); if (!st.isFile() || st.size > MAX) throw new Error(`${f} is not a plain file`); return fs.readFileSync(p); };
  let sums, sig, list;
  try { sums = read("SHA256SUMS"); } catch { return { ok: false, why: "there is no SHA256SUMS beside this build" }; }
  try { sig = read("SHA256SUMS.sig"); } catch { return { ok: false, why: "SHA256SUMS has no signature" }; }
  try { list = read("modules.json"); } catch { return { ok: false, why: "there is no signed list of modules (modules.json)" }; }
  if (!sumsSigned(sums, sig.toString("utf8"), der(releaseKey))) return { ok: false, why: "SHA256SUMS is not signed by Vyre's release key" };
  const line = sums.toString("utf8").split("\n").map(l => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l)).find(m => m && m[2].replace(/^\.\//, "") === "modules.json");
  if (!line || line[1] !== sha256(list)) return { ok: false, why: "modules.json is not the file the signed SHA256SUMS lists" };
  try {
    const d = JSON.parse(list.toString("utf8"));
    if (d.v !== 1 || !Number.isInteger(d.counter) || d.counter < 0 || !d.modules || typeof d.modules !== "object") return { ok: false, why: "modules.json is not a module list this kernel reads" };
    for (const [n, m] of Object.entries(d.modules)) if (!m || typeof m.version !== "string" || !/^[0-9a-f]{64}$/.test(String(m.tree))) return { ok: false, why: `modules.json has a bad entry for ${n}` };
    return { ok: true, counter: d.counter, modules: d.modules, raw: { list: list.toString("utf8"), sums: sums.toString("utf8"), sig: sig.toString("utf8") } };
  } catch { return { ok: false, why: "modules.json cannot be read" }; }
}

/**
 * Re-verify a list kept in the log (the signed material itself, not a counter someone wrote): the same checks as `readReleaseList`, from strings.
 * @param {{ list: string, sums: string, sig: string }} raw @param {string} [releaseKey] @returns {{ counter: number, modules: Record<string, { version: string, tree: string }> } | null}
 */
export function verifyRawList(raw, releaseKey) {
  try {
    if (!raw || typeof raw.list !== "string" || typeof raw.sums !== "string" || typeof raw.sig !== "string") return null;
    if (!sumsSigned(raw.sums, raw.sig, der(releaseKey))) return null;
    const line = raw.sums.split("\n").map(l => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l)).find(m => m && m[2].replace(/^\.\//, "") === "modules.json");
    if (!line || line[1] !== sha256(raw.list)) return null;
    const d = JSON.parse(raw.list);
    return d.v === 1 && Number.isInteger(d.counter) && d.modules && typeof d.modules === "object" ? { counter: d.counter, modules: d.modules } : null;
  } catch { return null; }
}

/**
 * A check for the Module host: first party when the signed list names this folder's module, its tree and its version. Says why not, once per module, through `say`.
 * @param {{ modules: Record<string, { version: string, tree: string }> }} list @param {(m: string) => void} [say] @returns {(dir: string) => boolean}
 */
export function createListCheck(list, say = () => {}) {
  const told = new Set();
  const no = (/** @type {string} */ name, /** @type {string} */ why) => { if (!told.has(name)) { told.add(name); say(`kernel: ${name} is not first party: ${why}`); } return false; };
  return dir => {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")); } catch { return false; }
    const name = String(m && m.name);
    const e = list.modules[name];
    if (!e) return no(name, "the release's signed list does not name it");
    if (String(m.version) !== e.version) return no(name, `it is version ${m.version}, the signed list says ${e.version}`);
    try { if (treeHash(dir) !== e.tree) return no(name, "it was changed after it was signed"); } catch { return no(name, "its folder holds something that is not a plain file"); }
    return true;
  };
}

/**
 * What the release does at build time: hash every module folder of an UNPACKED package and write the list (the signing happens when the release signs SHA256SUMS, which must list this
 * file). `counter` rises with every release.
 * @param {string} root the unpacked package root @param {{ counter: number, release: string }} o @returns {string} the JSON text
 */
export function buildModuleList(root, o) {
  /** @type {Record<string, { version: string, tree: string }>} */ const modules = {};
  for (const top of ["core", "local", "modules"]) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort()) {
      const dir = path.join(base, d), mj = path.join(dir, "module.json");
      if (!fs.existsSync(mj)) continue;
      const m = JSON.parse(fs.readFileSync(mj, "utf8"));
      if (modules[m.name]) throw new Error(`two modules are named ${m.name}`);
      modules[m.name] = { version: String(m.version), tree: treeHash(dir) };
    }
  }
  return JSON.stringify({ v: 1, counter: o.counter, release: o.release, modules: Object.fromEntries(Object.entries(modules).sort()) }, null, 1) + "\n";
}
