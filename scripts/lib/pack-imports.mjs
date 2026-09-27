// @ts-check
// Every relative import in the shipped package must point at a file the package ships. 0.1.0-rc.1
// shipped core/cli/commands/module.js without packages/module-sdk (package.json "files" left it
// out), and every `vyre` call died with ERR_MODULE_NOT_FOUND. test/pack-imports.test.js checks
// `npm pack --dry-run`'s list; scripts/release-check.sh runs this on the installed folder:
//
//   node scripts/lib/pack-imports.mjs <installed package dir>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static imports and exports ("from" or a bare import "x"), and import("x") with a literal.
const SPECS = /(?:^|[;\s])(?:import|export)\s[^;"'`]*?from\s*["']([^"']+)["']|(?:^|[;\s])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

/**
 * The relative imports in `files` (package-relative paths) that name no file in the list.
 * @param {string} root the folder the paths are relative to
 * @param {string[]} files every file the package ships
 * @returns {string[]} "<file>: <specifier>" for each import that would not resolve
 */
export function missingImports(root, files) {
  const shipped = new Set(files.map(f => f.split(path.sep).join("/")));
  const out = [];
  for (const f of shipped) {
    if (!/\.(m?js)$/.test(f)) continue;
    // Comment lines go first, then template literals: a scaffold's own `import mod from
    // "./index.js"` is text the code writes out, not an import of its own.
    const text = fs.readFileSync(path.join(root, f), "utf8")
      .replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
    for (const m of text.matchAll(SPECS)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || !spec.startsWith(".")) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec.split("?")[0]));
      if (!shipped.has(target)) out.push(`${f}: ${spec}`);
    }
  }
  return out.sort();
}

/** @param {string} dir */
function walk(dir, base = dir, acc = /** @type {string[]} */ ([])) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, base, acc); }
    else acc.push(path.relative(base, p));
  }
  return acc;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node scripts/lib/pack-imports.mjs <package dir>"); process.exit(2); }
  const missing = missingImports(dir, walk(dir));
  for (const m of missing) console.error(`not shipped: ${m}`);
  process.exit(missing.length ? 1 : 0);
}
