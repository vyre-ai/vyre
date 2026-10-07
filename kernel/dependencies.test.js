// @ts-check
// The kernel imports Node's own modules, lib/databox.js and the pinned @noble packages, and nothing else from outside the repo (kernel/DEPENDENCIES.md). This fails on any other bare import under kernel/, and on a
// noble version that is not exact or that differs between the root and the app.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = /^(node:[a-z:/_]+|@noble\/(hashes|ciphers|curves)(\/[A-Za-z0-9._/-]+)?)$/;
const PINNED = { "@noble/hashes": "1.8.0", "@noble/ciphers": "1.3.0", "@noble/curves": "1.9.7" };

/** Every non-test source file under a folder. @param {string} dir @returns {string[]} */
function sources(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(m?js|ts)$/.test(e.name) && !/\.test\.(m?js|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The module names a file imports (static, re-exported, dynamic or required), skipping comments and strings that only mention an import. @param {string} src */
export function importsOf(src) {
  /** @type {string[]} */ const names = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    for (const m of t.matchAll(/^(?:import|export)\b[^"'`]*?\bfrom\s+["']([^"']+)["']|^import\s+["']([^"']+)["']|(?<![\w.$"'`])import\(\s*["']([^"']+)["']\s*\)|(?<![\w.$"'`])require\(\s*["']([^"']+)["']\s*\)/g)) names.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return names;
}

test("kernel imports: only Node's own modules, relative files and the pinned noble packages", () => {
  /** @type {string[]} */ const bad = [];
  for (const file of sources(path.join(root, "kernel"))) {
    for (const name of importsOf(fs.readFileSync(file, "utf8"))) {
      if (name.startsWith(".") || name.startsWith("/")) continue;
      if (!ALLOWED.test(name)) bad.push(`${path.relative(root, file)} imports ${name}`);
    }
  }
  assert.deepEqual(bad, [], "kernel/DEPENDENCIES.md lists what the kernel may import");
});

test("the importer recognises a real import and ignores comments and strings", () => {
  assert.deepEqual(importsOf('import { a } from "left-pad";\nexport * from "x-lib";\n// import y from "nope"\nconst s = "import z from \'no\'";\nconst m = await import("dyn-lib");'), ["left-pad", "x-lib", "dyn-lib"]);
});

test("the noble packages are pinned exactly, the same in the root and the app", () => {
  for (const pkg of ["package.json", "apps/app/package.json"]) {
    const deps = JSON.parse(fs.readFileSync(path.join(root, pkg), "utf8")).dependencies || {};
    for (const [name, v] of Object.entries(PINNED)) assert.equal(deps[name], v, `${pkg}: ${name}`);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, "apps/app/package-lock.json"), "utf8"));
  for (const [name, v] of Object.entries(PINNED)) {
    assert.equal(lock.packages[""].dependencies[name], v, `app lock root: ${name}`);
    assert.equal(lock.packages[`node_modules/${name}`].version, v, `app lock: ${name}`);
    assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-/);
  }
});
