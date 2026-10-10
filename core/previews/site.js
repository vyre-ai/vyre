// @ts-check
// previews/site: a folder of files as a static site that runs without this server. The Preview pane shows a React page (index.jsx, index.tsx, App.jsx or App.tsx, with no index.html) through a small
// page that mounts its default export, the file turned into JavaScript on request, and the reviewed libraries served from /__vyre/lib/. Publish needs the same page as plain files: this makes them with the
// SAME shell, compiler and library table the pane uses (jsx.js), so what is published is what the pane showed. A folder that has an index.html is already a site and comes back as it is.

import { compile, shell, libs, libFile, bareImports, JSX_EXT } from "./jsx.js";

const LIB_DIR = "/__vyre/lib/";
const fail = (/** @type {string} */ message, /** @type {string} */ code = "refused") => Object.assign(new Error(message), { code });
/** A relative import of one of the page's own source files: `./Chart.jsx` becomes `./Chart.js`, the name its compiled file is published under. @param {string} js */
const renamed = js => js.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']*?)\.(?:jsx|tsx|ts)\2/g, "$1$2$3.js$2");

/**
 * @param {{ path: string, content: Buffer }[]} files the folder as it was read (no secret files, no links)
 * @returns {Promise<{ files: { path: string, content: Buffer }[], react: boolean, notes: string[] }>}
 */
export async function siteOf(files) {
  const has = (/** @type {string} */ n) => files.some(f => f.path === n);
  const sources = files.filter(f => JSX_EXT.test(f.path));
  if (has("index.html") || has("index.htm") || !sources.length) return { files, react: false, notes: [] };
  const names = new Set(files.map(f => f.path));
  const entry = ["index.jsx", "index.tsx", "App.jsx", "App.tsx"].find(n => names.has(n));
  if (!entry) return { files, react: false, notes: [] };

  /** @type {{ path: string, content: Buffer }[]} */ const out = [];
  /** @type {Set<string>} */ const wanted = new Set(["react", "react-dom/client", "react/jsx-runtime"]);
  for (const f of files) {
    if (!JSX_EXT.test(f.path)) { out.push(f); continue; }
    const r = await compile(f.content.toString("utf8"), f.path);
    if (!r.ok) throw fail(`${r.error}`);
    for (const n of bareImports(r.js)) wanted.add(n);
    out.push({ path: f.path.replace(JSX_EXT, ".js"), content: Buffer.from(renamed(r.js)) });
  }
  const clash = out.map(f => f.path).filter((p, i, a) => a.indexOf(p) !== i);
  if (clash.length) throw fail(`${clash[0]} is both a source file and its compiled name; rename one of them`);

  // the libraries the page uses, and the ones those use in turn, from the pinned table: each file checked against its recorded hash as it is read
  const table = libs(), have = new Set();
  const take = (/** @type {string} */ name) => {
    const address = table[name];
    if (!address || have.has(address)) return;
    const file = address.slice(LIB_DIR.length);
    const buf = libFile(file);
    if (!buf) throw fail(`the library ${name} is missing from this build of Vyre`);
    have.add(address);
    out.push({ path: `__vyre/lib/${file}`, content: buf });
    for (const n of bareImports(buf.toString("utf8"))) take(n);
  };
  for (const n of wanted) take(n);
  const tw = libFile("tailwind.js");
  if (tw) out.push({ path: "__vyre/lib/tailwind.js", content: tw });

  const title = entry.replace(JSX_EXT, "");
  out.push({ path: "index.html", content: Buffer.from(shell({ title, entry: entry.replace(JSX_EXT, ".js").split("/").map(encodeURIComponent).join("/"), bridge: false })) });
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files: out, react: true, notes: [`React page ${entry} compiled; ${have.size} librar${have.size === 1 ? "y" : "ies"} included`] };
}
