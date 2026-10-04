// A module with a .native or .web file beside it is resolved to that file by Metro, so a name the callers import must be exported by every variant. One that is missing is
// undefined at run time: the RC1 Android crash (webcrypto.native.ts imported fromB64url from "../auth/person", which Metro resolves to person.native.ts on the phone).
// Callers that name the explicit file ("../auth/person.ts") are not affected and not checked.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist-android", "android", "ios", ".expo"]);
const EXT = /\.(?:[cm]?[jt]sx?)$/;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (EXT.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The value names a file exports (types are erased, so they are not counted or required). `star` is true when it re-exports everything from another module. */
function exportsOf(file) {
  const src = strip(readFileSync(file, "utf8"));
  const names = new Set(); let star = false;
  for (const m of src.matchAll(/^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  // export const { a, b: c } = x; and export const [a, b] = x;
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/gm)) for (const part of m[1].split(",")) {
    const t = part.trim().replace(/^\.\.\./, ""); if (t) names.add(t.split(":").pop().split("=")[0].trim());
  }
  for (const m of src.matchAll(/^\s*export\s+default\b/gm)) names.add("default");
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(",")) {
    const t = part.trim(); if (!t || /^type\s/.test(t)) continue;
    names.add(t.split(/\s+as\s+/).pop().trim());
  }
  if (/^\s*export\s*\*\s*(?!as)\s*from/m.test(src)) star = true;
  for (const m of src.matchAll(/^\s*export\s*\*\s*as\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  return { names, star };
}

/** Named value imports of `spec` in a file: `import { a, type B, c as d } from "spec"`. */
function importsOf(file) {
  const src = strip(readFileSync(file, "utf8")); const out = [];
  for (const m of src.matchAll(/import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const named = /\{([^}]*)\}/.exec(m[1]); if (!named) continue;
    const names = named[1].split(",").map((s) => s.trim()).filter((s) => s && !/^type\s/.test(s)).map((s) => s.split(/\s+as\s+/)[0].trim());
    out.push({ spec: m[2], names });
  }
  return out;
}

const files = walk(APP);
/** Platform-split bases: "/abs/path/person" -> { native: file, web: file, plain: file|null }. */
const groups = new Map();
for (const f of files) {
  const m = /^(.*)\.(native|web)\.([cm]?[jt]sx?)$/.exec(f); if (!m) continue;
  const g = groups.get(m[1]) ?? { native: null, web: null, plain: null };
  g[m[2]] = f; groups.set(m[1], g);
}
for (const [base, g] of groups) g.plain = files.find((f) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[cm]?[jt]sx?$`).test(f) && !/\.(native|web)\./.test(f)) ?? null;

test("a platform-split module's variants export what its callers import", () => {
  const problems = [];
  for (const f of files) {
    for (const { spec, names } of importsOf(f)) {
      if (!spec.startsWith(".") || EXT.test(spec)) continue; // a package, or an explicit file
      const base = resolve(dirname(f), spec); const g = groups.get(base); if (!g) continue;
      for (const kind of ["native", "web"]) {
        const variant = g[kind]; if (!variant) continue;
        const { names: have, star } = exportsOf(variant); if (star) continue;
        for (const n of names) if (!have.has(n)) problems.push(`${f.replace(APP + "/", "")} imports { ${n} } from "${spec}", but ${variant.replace(APP + "/", "")} does not export it`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// Metro tries the extensions in order (ts, tsx, js...) and for each one the platform file before the plain one, so scan.ts is found before scan.android.tsx: the Android build bundled expo-camera
// (which is excluded from the build) and died with "Cannot find native module 'ExpoCamera'". A platform file must use the same extension as the plain one beside it.
test("a platform file has the same extension as the plain file beside it", () => {
  const problems = [];
  for (const f of files) {
    const m = /^(.*)\.(android|ios|native|web)\.([cm]?[jt]sx?)$/.exec(f); if (!m) continue;
    const plain = ["ts", "tsx", "js", "jsx", "mjs", "cjs"].filter((e) => e !== m[3] && existsSync(`${m[1]}.${e}`) && !/\.d\.ts$/.test(`${m[1]}.${e}`));
    // a .tsx platform file beats nothing when the plain one is .ts and sorts first; only the plain files that sort before the variant's extension matter
    const ORDER = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
    for (const e of plain) if (ORDER.indexOf(e) < ORDER.indexOf(m[3])) problems.push(`${f.replace(APP + "/", "")} loses to ${m[1].replace(APP + "/", "")}.${e}: use the extension .${e}`);
  }
  assert.deepEqual(problems, []);
});
