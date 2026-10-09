// @ts-check
// previews/jsx: a React page written for Claude's artifact runtime (a .jsx or .tsx file with `export default function App()`) runs in a preview. This turns the file into JavaScript a browser runs (esbuild's
// WebAssembly build, loaded the first time it is needed; transform only: it bundles nothing, resolves no package and reads no file) and puts it in a small page that mounts its default export. The libraries such
// a page imports (react, recharts, lucide-react, d3 and the rest of Claude's list) are pinned in one table below and reach the browser through an import map, so what a page may import is a reviewed list, not
// whatever it names. An import the table does not have is a plain message on the page, never a silent blank.
import fs from "node:fs";
import path from "node:path";

/** The libraries a page may import, and where the browser gets each (a pinned version; react and react-dom are one copy for all). Claude's artifact list, with the versions it documents where it documents one. */
const R = "react@18.3.1", RD = "react-dom@18.3.1";
const CDN = "https://esm.sh";
export const LIBS = Object.freeze({
  "react": `${CDN}/${R}`, "react/jsx-runtime": `${CDN}/${R}/jsx-runtime`, "react/jsx-dev-runtime": `${CDN}/${R}/jsx-dev-runtime`,
  "react-dom": `${CDN}/${RD}?deps=${R}`, "react-dom/client": `${CDN}/${RD}/client?deps=${R}`,
  "recharts": `${CDN}/recharts@2.15.0?deps=${R},${RD}`,
  "lucide-react": `${CDN}/lucide-react@0.263.1?deps=${R}`,
  "d3": `${CDN}/d3@7.9.0`, "lodash": `${CDN}/lodash@4.17.21`, "papaparse": `${CDN}/papaparse@5.4.1`, "mathjs": `${CDN}/mathjs@12.4.2`,
  "three": `${CDN}/three@0.160.0`, "chart.js": `${CDN}/chart.js@4.4.3`, "date-fns": `${CDN}/date-fns@3.6.0`, "xlsx": `${CDN}/xlsx@0.18.5`,
});
const TAILWIND = "https://cdn.tailwindcss.com/3.4.17";
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
  const loader = LOADER[path.extname(file).toLowerCase()];
  let result;
  try {
    const { transform } = await esbuild();
    const r = await transform(fs.readFileSync(file, "utf8"), { loader, jsx: "automatic", target: "es2022", format: "esm", sourcefile: path.basename(file), logLevel: "silent" });
    const unknown = bareImports(r.code).filter(n => !(n in LIBS));
    result = unknown.length
      ? { ok: /** @type {const} */ (false), error: `This page imports ${unknown.map(n => `"${n}"`).join(", ")}, which Vyre does not provide. It provides: ${Object.keys(LIBS).filter(n => !n.includes("/")).join(", ")}.` }
      : { ok: /** @type {const} */ (true), js: r.code };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const first = err && Array.isArray(err.errors) && err.errors[0];
    result = { ok: /** @type {const} */ (false), error: first ? `${path.basename(file)}${first.location ? `:${first.location.line}` : ""}: ${first.text}` : String(err && err.message || "that file could not be read as JSX").slice(0, 300) };
  }
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
  const imports = JSON.stringify({ imports: LIBS });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${bridge ? '<script src="/__vyre/claude.js"></script>' : ""}<script type="importmap">${imports}</script><script src="${TAILWIND}"></script><style>html,body{margin:0}#vyre-problem{display:none;max-width:560px;margin:48px auto;padding:16px 18px;border:1px solid #dcd9d1;border-radius:12px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#171716;background:#fff}</style></head><body><div id="root"></div><div id="vyre-problem" role="alert"></div><script type="module">
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
