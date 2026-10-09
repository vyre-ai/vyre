// Builds the libraries a React preview may import into ../vendor (one ES module each, react shared through the page's import map) and writes
// ../vendor/manifest.json with each file's sha256. Run on a build machine: `node core/previews/vendor-src/build.mjs` (needs node and npm; installs into a scratch folder).
// The built files are committed; the server checks every file against the manifest before it serves it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";


const src = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(src, "..", "vendor");
// the exact versions are installed into a scratch folder, so no package manifest sits in the repo
const here = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-preview-libs-"));
const wanted = JSON.parse(fs.readFileSync(path.join(src, "versions.json"), "utf8")).versions;
fs.writeFileSync(path.join(here, "package.json"), JSON.stringify({ private: true, dependencies: wanted }));
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: here, stdio: "inherit" });
const require = createRequire(path.join(here, "package.json"));
const pkgVersion = n => JSON.parse(fs.readFileSync(path.join(here, "node_modules", n, "package.json"), "utf8")).version;

// import name -> { from: what to bundle, cjs: list the names of a CommonJS module so they can be named exports }
const LIBS = {
  "react": { from: "react", cjs: true },
  "react/jsx-runtime": { from: "react/jsx-runtime", cjs: true },
  "react/jsx-dev-runtime": { from: "react/jsx-dev-runtime", cjs: true },
  "react-dom": { from: "react-dom", cjs: true },
  "react-dom/client": { from: "react-dom/client", cjs: true },
  "recharts": { from: "recharts" },
  "lucide-react": { from: "lucide-react" },
  "d3": { from: "d3" },
  "lodash": { from: "lodash", cjs: true },
  "papaparse": { from: "papaparse", cjs: true },
  "mathjs": { from: "mathjs" },
  "three": { from: "three" },
  "chart.js": { from: "chart.js" },
  "chart.js/auto": { from: "chart.js/auto" },
  "date-fns": { from: "date-fns" },
  "xlsx": { from: "xlsx" },
};
const EXTERNAL = ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client"];
const fileOf = name => name.replace(/[\/]/g, "__") + ".js";

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const esbuildNs = await import(path.join(here, "node_modules", "esbuild-wasm", "lib", "main.js"));
const esbuild = esbuildNs.default || esbuildNs;
await esbuild.initialize({});
const files = {};
for (const [name, lib] of Object.entries(LIBS)) {
  let entry;
  if (lib.cjs) {
    const m = require(lib.from);
    const names = Object.keys(m).filter(k => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default");
    entry = `import m from ${JSON.stringify(lib.from)};\nexport default m;\n${names.length ? `export const { ${names.join(", ")} } = m;\n` : ""}`;
  } else entry = `export * from ${JSON.stringify(lib.from)};\n`;
  // react and react-dom stay external for the libraries that use them; they bundle their own copy only when they ARE react
  const external = EXTERNAL.filter(e => e !== lib.from);
  // A CommonJS library's own require("react") would become a call the browser cannot make; this turns it into an import the page's import map answers.
  const viaMap = { name: "via-import-map", setup(b) {
    b.onResolve({ filter: /.*/ }, a => {
      if (!external.includes(a.path)) return null;
      if (a.namespace === "ext") return { path: a.path, external: true };
      return { path: a.path, namespace: "ext" };
    });
    b.onLoad({ filter: /.*/, namespace: "ext" }, a => ({ contents: `export * from ${JSON.stringify(a.path)}; export { default } from ${JSON.stringify(a.path)};`, loader: "js" }));
  } };
  const r = await esbuild.build({ plugins: [viaMap], stdin: { contents: entry, resolveDir: path.join(here, "node_modules"), loader: "js" }, bundle: true, format: "esm", platform: "browser", target: "es2022",
    minify: true, write: false, legalComments: "none", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
  const buf = Buffer.from(r.outputFiles[0].contents);
  const f = fileOf(name);
  fs.writeFileSync(path.join(out, f), buf);
  files[name] = { file: f, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}
// Tailwind's in-browser build: one classic script that reads the page's classes.
const tw = fs.readFileSync(path.join(here, "node_modules", "@tailwindcss/browser/dist/index.global.js"));
fs.writeFileSync(path.join(out, "tailwind.js"), tw);
files["tailwind"] = { file: "tailwind.js", sha256: crypto.createHash("sha256").update(tw).digest("hex"), bytes: tw.length };
const versions = Object.fromEntries(["react", "react-dom", "recharts", "lucide-react", "d3", "lodash", "papaparse", "mathjs", "three", "chart.js", "date-fns", "xlsx", "@tailwindcss/browser"].map(n => [n, pkgVersion(n)]));
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ versions, files }, null, 2) + "\n");
console.log(Object.entries(files).map(([n, f]) => `${n} ${(f.bytes / 1024).toFixed(0)}k`).join("\n"));
process.exit(0);
