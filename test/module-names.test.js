// The signed module list (kernel/modules/release-list.js buildModuleList) is keyed by module name, so two module folders with one name make a release that cannot be built and a list that
// could be read two ways. This fails at build time on a duplicate name. The one known duplicate is named in scripts/packaged-boot-known.txt (launch's file; this test and that file
// agree on the folder), with a line saying who rules on it; the exception goes stale loudly, so deleting the duplicate removes the line.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModuleList } from "../kernel/modules/release-list.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN = path.join(REPO, "scripts", "packaged-boot-known.txt");

/** Module folders (relative to root) by manifest name, scanned the way buildModuleList scans. @param {string} root @returns {Map<string, string[]>} */
export function namesIn(root) {
  /** @type {Map<string, string[]>} */ const out = new Map();
  for (const top of ["core", "local", "modules"]) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort()) {
      const mj = path.join(base, d, "module.json");
      if (!fs.existsSync(mj)) continue;
      const name = String(JSON.parse(fs.readFileSync(mj, "utf8")).name);
      out.set(name, [...(out.get(name) || []), `${top}/${d}`]);
    }
  }
  return out;
}

/** Folders the packaged-boot proof leaves out for a known problem, one per line, comments and blanks ignored. @param {string} file @returns {string[]} */
export const knownFolders = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")) : []);

/** The roles a module folder runs in (a manifest without them runs everywhere). @param {string} root @param {string} dir @returns {string[]} */
const rolesOf = (root, dir) => { const m = JSON.parse(fs.readFileSync(path.join(root, dir, "module.json"), "utf8")); return Array.isArray(m.roles) && m.roles.length ? m.roles : ["box", "local"]; };

/**
 * Duplicate names, ignoring folders listed as known. Two folders may share a name only for different machines (disjoint `roles`, like the box's chrome and the Mac's): the signed list
 * carries one entry per folder (`also`). Anything else is a clash. @param {Map<string, string[]>} names @param {string[]} known @param {string} [root] @returns {[string, string[]][]}
 */
export const duplicates = (names, known, root = REPO) => [...names].map(([n, dirs]) => /** @type {[string, string[]]} */ ([n, dirs.filter(d => !known.includes(d))])).filter(([, dirs]) => {
  if (dirs.length < 2) return false;
  const seen = new Set();
  for (const d of dirs) for (const r of rolesOf(root, d)) { if (seen.has(r)) return true; seen.add(r); }
  return false;
});

test("no two module folders share a manifest name (the signed module list is never ambiguous)", () => {
  const known = knownFolders(KNOWN), names = namesIn(REPO);
  const dup = duplicates(names, known);
  assert.deepEqual(dup, [], `two modules are named the same: ${dup.map(([n, d]) => `${n} (${d.join(", ")})`).join("; ")}. Rename one, or ask platform to rule and add its folder to scripts/packaged-boot-known.txt`);
});

test("a known duplicate is still a duplicate: when the clash is fixed, delete its line from scripts/packaged-boot-known.txt", () => {
  const names = namesIn(REPO);
  for (const f of knownFolders(KNOWN)) {
    const clash = [...names].find(([, dirs]) => dirs.includes(f) && dirs.length > 1);
    assert.ok(clash, `${f} is listed as a known problem but shares no name with another module: delete the line`);
  }
});

test("the duplicate check sees what buildModuleList refuses, and sees nothing in a clean tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-names-"));
  try {
    const mod = (/** @type {string} */ dir, /** @type {string} */ name) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); fs.writeFileSync(path.join(root, dir, "module.json"), JSON.stringify({ name, version: "1.0.0" })); };
    mod("core/alpha", "alpha"); mod("local/beta-mac", "beta"); mod("modules/gamma", "gamma");
    assert.deepEqual(duplicates(namesIn(root), [], root), []);
    assert.doesNotThrow(() => buildModuleList(root, { counter: 1, release: "0.0.1" }));
    mod("modules/beta", "beta");
    const dup = duplicates(namesIn(root), [], root);
    assert.deepEqual(dup, [["beta", ["local/beta-mac", "modules/beta"]]]);
    assert.throws(() => buildModuleList(root, { counter: 1, release: "0.0.1" }), /two modules are named beta/);
    assert.deepEqual(duplicates(namesIn(root), ["local/beta-mac"], root), [], "a folder listed as known is set aside");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
