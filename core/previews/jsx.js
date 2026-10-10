// @ts-check
// previews/jsx: a React page written for Claude's artifact runtime (a .jsx or .tsx file with `export default function App()`) runs in a preview. This turns the file into JavaScript a browser runs (esbuild's
// WebAssembly build, loaded the first time it is needed; transform only: it bundles nothing, resolves no package and reads no file) and puts it in a small page that mounts its default export. The libraries such
// a page imports (react, recharts, lucide-react, d3 and the rest of Claude's list) are pinned in one table below and reach the browser through an import map, so what a page may import is a reviewed list, not
// whatever it names. An import the table does not have is a plain message on the page, never a silent blank.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * The libraries a page may import: the ones in vendor/manifest.json, built by vendor-src/build.mjs, committed with the release and served by this box from /__vyre/lib/.
 * Nothing is fetched from anyone else, so a box with no internet runs the same page and nothing a CDN changes can change what runs. Each file is checked against its
 * recorded sha256 the first time it is read; a file that does not match is never served.
 */
const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor");
/** @type {{ versions: Record<string, string>, files: Record<string, { file: string, sha256: string, bytes: number }> } | null} */ let manifest = null;
const loadManifest = () => (manifest ||= JSON.parse(fs.readFileSync(path.join(VENDOR, "manifest.json"), "utf8")));
/** The import name -> address table for the page's import map (not Tailwind, which is a script). */
export const libs = () => Object.fromEntries(Object.entries(loadManifest().files).filter(([n]) => n !== "tailwind").map(([n, f]) => [n, `/__vyre/lib/${f.file}`]));
/** The import names a page may use, without the sub-paths. */
export const libNames = () => Object.keys(libs()).filter(n => !n.includes("/"));
/** @type {Map<string, Buffer>} */ const verified = new Map();
/** One vendored file by its name in the manifest, or null: not listed, missing, or not what the manifest recorded. @param {string} file */
export function libFile(file) {
  const hit = verified.get(file);
  if (hit) return hit;
  const entry = Object.values(loadManifest().files).find(f => f.file === file);
  if (!entry) return null;
  let buf;
  try { buf = fs.readFileSync(path.join(VENDOR, entry.file)); } catch { return null; }
  if (crypto.createHash("sha256").update(buf).digest("hex") !== entry.sha256) return null;
  verified.set(file, buf);
  return buf;
}
export const JSX_EXT = /\.(jsx|tsx|ts)$/i;
const LOADER = /** @type {Record<string, "jsx"|"tsx"|"ts">} */ ({ ".jsx": "jsx", ".tsx": "tsx", ".ts": "ts" });

/** @type {Promise<any> | null} */ let ready = null;
const esbuild = () => (ready ||= import("esbuild-wasm").then(async m => { await m.initialize({}); return m; }));

/** The bare module names a piece of JavaScript imports (static, re-exported or dynamic), not the relative ones. @param {string} js */
export function bareImports(js) {
  /** @type {Set<string>} */ const out = new Set();
  for (const m of js.matchAll(/(?:^|[\s;}])(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|(?:^|[\s;}])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)) {
    const n = m[1] || m[2] || m[3];
    if (n && !/^(\.{0,2}\/|[a-z]+:|data:)/i.test(n)) out.add(n);
  }
  return [...out];
}

/**
 * The JavaScript for a piece of .jsx, .tsx or .ts source, or the plain reason it cannot be. `name` is the file's name, for the message and the loader.
 * @param {string} source @param {string} name @returns {Promise<{ ok: true, js: string } | { ok: false, error: string }>}
 */
export async function compile(source, name) {
  const loader = LOADER[path.extname(name).toLowerCase()];
  try {
    const { transform } = await esbuild();
    const r = await transform(source, { loader, jsx: "automatic", target: "es2022", format: "esm", sourcefile: path.basename(name), logLevel: "silent" });
    const unknown = bareImports(r.code).filter(n => !(n in libs()));
    return unknown.length
      ? { ok: /** @type {const} */ (false), error: `This page imports ${unknown.map(n => `"${n}"`).join(", ")}, which Vyre does not provide. It provides: ${libNames().join(", ")}.` }
      : { ok: /** @type {const} */ (true), js: r.code };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const first = err && Array.isArray(err.errors) && err.errors[0];
    return { ok: /** @type {const} */ (false), error: first ? `${path.basename(name)}${first.location ? `:${first.location.line}` : ""}: ${first.text}` : String(err && err.message || "that file could not be read as JSX").slice(0, 300) };
  }
}

const cache = new Map();
/**
 * The JavaScript for a .jsx, .tsx or .ts file, or the plain reason it cannot be. Cached by the file's size and time.
 * @param {string} file @returns {Promise<{ ok: true, js: string } | { ok: false, error: string }>}
 */
export async function build(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { ok: false, error: "that file is not there" }; }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { ok: false, error: "that file could not be read" }; }
  const result = await compile(text, file);
  if (cache.size > 200) cache.clear();
  cache.set(key, result);
  return result;
}

/** The file that is a folder's React page, when it has no index.html: index.jsx, index.tsx, App.jsx or App.tsx. @param {string} root */
export function entryIn(root) {
  for (const n of ["index.jsx", "index.tsx", "App.jsx", "App.tsx"]) { try { if (fs.statSync(path.join(root, n)).isFile()) return n; } catch { /* next */ } }
  return null;
}

/** @param {string} s */ const esc = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
/**
 * The page that mounts a React page's default export. A failure to build or to load is a plain message on the page. `bridge` adds the capability script (a page that declared capabilities).
 * @param {{ title: string, entry: string, bridge: boolean }} o
 */
export function shell({ title, entry, bridge }) {
  const imports = JSON.stringify({ imports: libs() });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${bridge ? '<script src="/__vyre/claude.js"></script>' : ""}<script type="importmap">${imports}</script><script src="/__vyre/lib/tailwind.js"></script><style>html,body{margin:0}#vyre-problem{display:none;max-width:560px;margin:48px auto;padding:16px 18px;border:1px solid #dcd9d1;border-radius:12px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#171716;background:#fff}</style></head><body><div id="root"></div><div id="vyre-problem" role="alert"></div><script type="module">
const problem = (m) => { const e = document.getElementById("vyre-problem"); e.style.display = "block"; e.textContent = m; };
try {
  const [{ default: React }, { createRoot }, mod] = await Promise.all([IMPORT("react"), IMPORT("react-dom/client"), IMPORT(${JSON.stringify("/" + entry)})]);
  if (typeof mod.default !== "function") problem("This page has no default export: export the component to show (export default function App() {...}).");
  else createRoot(document.getElementById("root")).render(React.createElement(mod.default));
} catch (e) { problem(String(e && e.message || e)); }
</script></body></html>`.replaceAll("IMPORT(", "import("); // written apart so a scan for this server's own imports does not read the page's
}

/** A module that says why it could not be built, as the error the shell shows. @param {string} message */
export const failing = message => `throw new Error(${JSON.stringify(message)});\n`;
