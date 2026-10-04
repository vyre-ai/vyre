// @ts-check
// release-shell: the signed module list and the app build record ride INSIDE shell.json (the one release file every updater since 0.2 already fetches, verifies under the release signature
// and publishes), so a server updated by an old updater, which knows nothing of modules.json or appbuild.json, still receives them. shell.json carries them as two exact-text fields:
//   { v: 1, version, files: [...], modulesJson: "<the text of modules.json>", appbuildJson: "<the text of appbuild.json>" }
// Nothing here trusts shell.json by itself: the files are returned only when SHA256SUMS is signed by the release key, shell.json is the file that signed list names, and each embedded text
// hashes to the line the same signed list holds for modules.json or appbuild.json. Anything else yields nothing, so a tampered or missing list never starts a module. Pure: no feature state.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sumsSigned } from "./release-sig.js";

const MAX = 8_000_000;
const sha256 = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest("hex");
/** The hash a SHA256SUMS text holds for a file name, or null. @param {string} sums @param {string} name */
const lineFor = (sums, name) => { const m = sums.split("\n").map(l => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l)).find(x => x && x[2].replace(/^\.\//, "") === name); return m ? m[1] : null; };

/**
 * The module list and app record carried by a shell.json, verified.
 * @param {{ sums: Buffer, sig: Buffer, shell: Buffer }} f @param {string} [key] base64 SPKI DER, default the compiled release key
 * @returns {{ ok: true, modules: Buffer | null, appbuild: Buffer | null } | { ok: false, why: string }}
 */
export function deriveFromShell({ sums, sig, shell }, key) {
  if (!sumsSigned(sums, sig.toString("utf8"), key)) return { ok: false, why: "SHA256SUMS is not signed by Vyre's release key" };
  const text = sums.toString("utf8");
  if (lineFor(text, "shell.json") !== sha256(shell)) return { ok: false, why: "shell.json is not the file the signed SHA256SUMS lists" };
  let j;
  try { j = JSON.parse(shell.toString("utf8")); } catch { return { ok: false, why: "shell.json cannot be read" }; }
  /** @param {unknown} s @param {string} name */
  const take = (s, name) => { if (typeof s !== "string") return null; const b = Buffer.from(s, "utf8"); return lineFor(text, name) === sha256(b) ? b : null; };
  return { ok: true, modules: take(j && j.modulesJson, "modules.json"), appbuild: take(j && j.appbuildJson, "appbuild.json") };
}

/** A plain file's bytes under a folder, or null (never through a link, never over 8 MB). @param {string} dir @param {string} f */
export function plain(dir, f) {
  try { const p = path.join(dir, f); const st = fs.lstatSync(p); return st.isFile() && st.size <= MAX ? fs.readFileSync(p) : null; } catch { return null; }
}

/**
 * One of a package's signed release files: the copy at the package root (placed by place-release.sh) when there is one, else the copy the host published in deck/release, else (for the module list
 * and the app record) the text carried by the published shell.json, verified. Null when none of them exists or verifies.
 * @param {string} root the package root @param {"SHA256SUMS" | "SHA256SUMS.sig" | "modules.json" | "appbuild.json"} name @param {string} [key]
 */
export function releaseFile(root, name, key) {
  const rel = path.join(root, "deck", "release");
  // The sums and their signature: what the host publishes NOW (deck/release) before the copy placed at the root when the container started, which on a server an old updater is updating
  // is the previous release's. Both are signature-checked by the callers, so the order decides only which is current.
  if (name === "SHA256SUMS" || name === "SHA256SUMS.sig") return plain(rel, name) || plain(root, name);
  const sums = plain(rel, "SHA256SUMS") || plain(root, "SHA256SUMS"), sig = plain(rel, "SHA256SUMS.sig") || plain(root, "SHA256SUMS.sig"), shell = plain(rel, "shell.json");
  const d = sums && sig && shell ? deriveFromShell({ sums, sig, shell }, key) : null;
  const derived = d && d.ok ? (name === "modules.json" ? d.modules : d.appbuild) : null;
  const pub = plain(rel, name), placed = plain(root, name);
  // One source of truth: where the verified shell.json carries the file, THAT copy is the one used. A separately fetched file the host published beside it that differs is refused (null: no list, no
  // module starts). A copy placed at the root when the container started is only ever a previous release's leftover: it is ignored here, never allowed to block a valid published release (RS-1).
  if (derived) return pub && !pub.equals(derived) ? null : derived;
  // No shell.json copy: the first of the published and the placed file that is the one the signed sums list, else whichever exists (the callers refuse it against the sums themselves).
  const want = sums ? lineFor(sums.toString("utf8"), name) : null;
  const both = [pub, placed].filter(/** @returns {b is Buffer} */ b => b !== null);
  return both.find(b => want && sha256(b) === want) || both[0] || null;
}

/**
 * The files whose published copy (deck/release) differs from the text the verified shell.json carries. Empty when they agree, or when there is nothing to compare.
 * @param {string} root @param {string} [key] @returns {string[]}
 */
export function shellMismatch(root, key) {
  const rel = path.join(root, "deck", "release");
  const sums = plain(rel, "SHA256SUMS") || plain(root, "SHA256SUMS"), sig = plain(rel, "SHA256SUMS.sig") || plain(root, "SHA256SUMS.sig"), shell = plain(rel, "shell.json");
  if (!sums || !sig || !shell) return [];
  const d = deriveFromShell({ sums, sig, shell }, key);
  if (!d.ok) return [];
  /** @type {string[]} */ const bad = [];
  for (const [name, b] of /** @type {[string, Buffer | null][]} */ ([["modules.json", d.modules], ["appbuild.json", d.appbuild]])) {
    const own = plain(rel, name);
    if (b && own && !own.equals(b)) bad.push(name);
  }
  return bad;
}

/**
 * Write the module list and app record a verified shell.json carries into a package root (what place-release.sh does at a container's start). Returns what it wrote.
 * @param {string} root @param {string} [key]
 */
export function placeFromShell(root, key) {
  /** @type {string[]} */ const wrote = [];
  const rel = path.join(root, "deck", "release");
  const sums = plain(rel, "SHA256SUMS") || plain(root, "SHA256SUMS"), sig = plain(rel, "SHA256SUMS.sig") || plain(root, "SHA256SUMS.sig"), shell = plain(rel, "shell.json");
  if (!sums || !sig || !shell) return wrote;
  const d = deriveFromShell({ sums, sig, shell }, key);
  if (!d.ok) return wrote;
  for (const [name, b] of /** @type {[string, Buffer | null][]} */ ([["modules.json", d.modules], ["appbuild.json", d.appbuild]])) {
    if (!b || plain(root, name)) continue;
    const p = path.join(root, name);
    fs.writeFileSync(p + ".new", b, { mode: 0o644 });
    fs.renameSync(p + ".new", p);
    wrote.push(name);
  }
  return wrote;
}
