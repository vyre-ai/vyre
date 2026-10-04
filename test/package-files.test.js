// @ts-check
// What `npm pack` ships must hold every file the daemon imports: a packaged box once died at boot ("Cannot find module /opt/vyre/kernel/devbuild.js") because the 0.3
// folders were not in package.json's "files". This walks the packaged folders' non-test sources, follows their relative imports, and checks each target is inside what is packed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const includes = /** @type {string[]} */ (pkg.files).filter(f => !f.startsWith("!"));
const excludes = /** @type {string[]} */ (pkg.files).filter(f => f.startsWith("!")).map(f => f.slice(1));
const inFiles = (/** @type {string} */ rel) => includes.some(d => rel === d || rel.startsWith(d + "/"));
const rx = (/** @type {string} */ g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0002").replace(/\*/g, "[^/]*").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*") + "$");
const excluded = (/** @type {string} */ rel) => excludes.some(g => rx(g).test(rel) || (!g.includes("*") && (rel === g || rel.startsWith(g + "/"))));
const packed = (/** @type {string} */ rel) => inFiles(rel) && !excluded(rel);

/** @param {string} dir @param {(file: string) => void} fn */
function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".build") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn); else if (/\.m?js$/.test(e.name)) fn(p);
  }
}

test("package files: every relative import of the packed daemon code lands on a packed file", () => {
  const problems = new Set();
  for (const top of ["bin", "core", "kernel", "lib", "local", "modules", "harness", "stores", "records"]) {
    if (!fs.existsSync(path.join(ROOT, top))) continue;
    walk(path.join(ROOT, top), f => {
      const from = path.relative(ROOT, f);
      if (!packed(from)) return;
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const to = path.relative(ROOT, path.resolve(path.dirname(f), m[1]));
        if (to.startsWith("..")) continue;
        // a dynamic import in a development-only helper may name an unpacked folder on purpose; those are in unpacked files, not here
        if (!packed(to)) problems.add(`${from} imports ${to}, which is not packed`);
      }
    });
  }
  assert.deepEqual([...problems].sort(), [], "add the folder to package.json files (or stop importing it from packed code)");
});

test("package files: every script the box wrapper runs inside the image (`/opt/vyre/scripts/*` in box/vyre, so every `vyre admin` step) is packed, with its own relative imports", () => {
  const wrapper = fs.readFileSync(path.join(ROOT, "box", "vyre"), "utf8");
  const scripts = [...new Set([...wrapper.matchAll(/\/opt\/vyre\/(scripts\/[A-Za-z0-9._-]+)/g)].map(m => m[1]))];
  assert.ok(scripts.length >= 2, `the wrapper names its image scripts (${scripts.join(", ")})`);
  const problems = [];
  for (const rel of scripts) {
    if (!packed(rel)) problems.push(`box/vyre runs ${rel} but it is not packed: the step would say "this release has no such step" on every image`);
    else for (const m of fs.readFileSync(path.join(ROOT, rel), "utf8").matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) { const to = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), m[1])); if (!packed(to)) problems.push(`${rel} imports ${to}, which is not packed`); }
  }
  assert.deepEqual(problems, []);
});

test("package files: the walk's dev scripts ship but refuse on a release-kind tree (kernel/dev-enrol.test.js proves the refusal), so a release image cannot make a software key", () => {
  for (const s of ["scripts/dev-enrol-software-key.mjs", "scripts/dev-sign-proof.mjs"]) {
    assert.ok(packed(s), `${s} is packed`);
    assert.match(fs.readFileSync(path.join(ROOT, s), "utf8"), /if \(!devSwitch\("1"\)\) die\(2, "this is a release-kind build/, `${s} refuses on a release-kind build before it does anything`);
  }
});
