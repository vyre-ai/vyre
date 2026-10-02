// @ts-check
// release: seals the camera page that wink.vyre.run serves (team/0.2.2/wink-registry.md section 3), the way
// relay/app/release.js seals the app's loader: every file in one signed manifest (SRI hashes, Ed25519), the entry
// pinned by SRI in index.html, and the app's own service worker (relay/app/sw.js) stamped with the release public
// key, which installs the page only when that key signed it. No dependencies.
//
//   node relay/wink/release.js build --release 0.2.0 [--key <file>] [--out <dir>]
//   node relay/wink/release.js verify <folder> --pub <file>
//
// The page's files are found by following the entry's imports, so the sealed tree is exactly what the page loads
// and is laid out like the repo (relay/wink/wink.js at /relay/wink/wink.js, deck/js/scan.js at /deck/js/scan.js):
// nothing is rewritten. The key defaults to $VYRE_RELEASE_KEY (a raw seed file or a PKCS8 PEM) and never lives here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealed, verify, publicOf, rawKey } from "../app/release.js";
import { sri } from "../app/manifest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
export const ENTRY = "relay/wink/wink.js";
export const STYLE = "relay/wink/wink.css";
// Code the page loads at run time without a static import the walk can see: the decode worker is made with new URL().
const EXTRA = ["deck/js/scan-worker.js"];

/** The relative specifiers a module imports: static, dynamic with a string, and new URL("./x", import.meta.url). @param {string} src */
export function specifiers(src) {
  const out = new Set();
  for (const m of src.matchAll(/(?:^|[\s;}])import\s+(?:[^"'`;]*?\sfrom\s+)?["'`]([^"'`]+)["'`]/gm)) out.add(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/new URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url/g)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:\*|\{[^}]*\})\s+from\s+["'`]([^"'`]+)["'`]/gm)) out.add(m[1]);
  return [...out].filter(s => s.startsWith("."));
}

/**
 * Every repo file the page loads, as repo-relative paths with forward slashes.
 * @param {string[]} [entries] @param {string} [root]
 */
export function closure(entries = [ENTRY, ...EXTRA], root = ROOT) {
  /** @type {Set<string>} */ const seen = new Set();
  /** @param {string} rel */
  const walk = rel => {
    if (seen.has(rel)) return;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) throw new Error(`${rel} is imported but is not in the repo`);
    seen.add(rel);
    if (!/\.m?js$/.test(rel)) return;
    for (const s of specifiers(fs.readFileSync(file, "utf8"))) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), s));
      if (next.startsWith("..")) throw new Error(`${rel} imports ${s}, which is outside the repo`);
      walk(next);
    }
  };
  for (const e of entries) walk(e);
  return [...seen].sort();
}

/**
 * The page into <out>/. Returns { release, manifest, files }.
 * @param {{ release: string, key: string, out: string, created?: number, root?: string }} o
 */
export async function build(o) {
  const root = o.root || ROOT;
  /** @type {Record<string, Uint8Array>} */ const files = {};
  for (const rel of closure(undefined, root)) files[rel] = new Uint8Array(fs.readFileSync(path.join(root, rel)));
  files[STYLE] = new Uint8Array(fs.readFileSync(path.join(root, STYLE)));
  let html = fs.readFileSync(path.join(root, "relay/wink/index.html"), "utf8");
  html = html.replace("{{wink.js}}", await sri(files[ENTRY])).replace("{{wink.css}}", await sri(files[STYLE]));
  files["index.html"] = new Uint8Array(Buffer.from(html));
  fs.rmSync(o.out, { recursive: true, force: true });
  fs.mkdirSync(o.out, { recursive: true });
  const manifest = await sealed(files, o.out, { release: o.release, key: o.key, out: o.out, created: o.created, entry: [ENTRY, STYLE] });
  const pub = Buffer.from(publicOf(o.key)).toString("base64url");
  const sw = fs.readFileSync(path.join(root, "relay/app/sw.js"), "utf8").replace("{{RELEASE_PUB}}", pub);
  fs.writeFileSync(path.join(o.out, "sw.js"), sw);
  return { release: o.release, manifest, files: Object.keys(files).length + 1 };
}

async function main(argv) {
  const [cmd, arg] = argv;
  const flag = n => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : undefined; };
  const key = flag("key") || process.env.VYRE_RELEASE_KEY || process.env.VYRE_SIGNING_KEY || "";
  if (cmd === "build" && flag("release")) return console.log(JSON.stringify(await build({ release: String(flag("release")), key, out: flag("out") || "wink-out" })));
  if (cmd === "verify" && arg && flag("pub")) return console.log(await verify(arg, new Uint8Array(Buffer.from(fs.readFileSync(String(flag("pub")), "utf8").trim(), "base64url"))));
  console.error("usage: release.js build --release x.y.z [--key f] [--out dir] | verify <folder> --pub <file>");
  process.exitCode = 2;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => { console.error(`wink release: ${e.message}`); process.exitCode = 1; });
}
export { rawKey };
