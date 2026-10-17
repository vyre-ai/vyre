// @ts-check
// A named import that the file it points at does not export is a link error: the importing module, and everything that loads it (a whole module of the daemon), fails to start. A merge once dropped
// `inviteChainId` from lib/first-run-shape.js while lib/invite-link.js still imported it, and the vault, among others, stopped registering. This walks the server-side code and fails on any
// `import { name } from "./relative.js"` whose target is a plain .js file that does not export that name. A target with `export *` is skipped (its names are not read here).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sourceFiles, ROOT } from "./source-files.js";

const IN_SCOPE = /^(core|lib|kernel)\//;
/** @type {Map<string, { names: Set<string>, star: boolean } | null>} */ const cache = new Map();

/** What a file exports by name. @param {string} rel */
function exportsOf(rel) {
  if (cache.has(rel)) return cache.get(rel) ?? null;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { cache.set(rel, null); return null; }
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // `export const A = 1, B = 2;` declares B too
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+[^;\n]*/g)) for (const d of m[0].matchAll(/,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) names.add(d[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n.trim()); }
  if (/export\s+default\b/.test(text)) names.add("default");
  const out = { names, star: /export\s*\*/.test(text) };
  cache.set(rel, out);
  return out;
}

test("every named import in the server-side code is something the target file exports", () => {
  /** @type {string[]} */ const bad = [];
  for (const file of sourceFiles()) {
    if (!IN_SCOPE.test(file) || !file.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+\.js)"/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
      const ex = exportsOf(target);
      if (!ex || ex.star) continue;
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name && !ex.names.has(name)) bad.push(`${file} imports { ${name} } from ${target}, which does not export it`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
