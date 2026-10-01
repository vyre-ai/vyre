#!/usr/bin/env node
// bump-version: one command that moves every place a release version lives, together.
//   node scripts/bump-version.mjs 0.2.0         set them all to 0.2.0
//   node scripts/bump-version.mjs --check       exit 1 and name any place that disagrees with package.json
// The places: package.json, package-lock.json (its top-level version and the root package's), and the Claude Code plugin manifest
// (harness/.claude-plugin/plugin.json), which test/cc-plugin.test.js requires to equal the package. Only the version strings change; the
// files keep their formatting. A release tag must equal this version (release.yml checks it), so bump first, then tag.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The version strings in each file: [file, [match index within the file, ...]] as read, for a given root. */
const FILES = ["package.json", "package-lock.json", "harness/.claude-plugin/plugin.json"];

/** @param {string} root @returns {{ file: string, version: string }[]} every version these files carry (the lockfile twice). */
export function read(root) {
  const out = [];
  const j = f => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
  out.push({ file: "package.json", version: j("package.json").version });
  const lock = j("package-lock.json");
  out.push({ file: "package-lock.json (top level)", version: lock.version });
  out.push({ file: 'package-lock.json (packages[""])', version: lock.packages?.[""]?.version });
  out.push({ file: "harness/.claude-plugin/plugin.json", version: j("harness/.claude-plugin/plugin.json").version });
  return out;
}

/** @param {string} root @returns {string[]} what disagrees with package.json */
export function problems(root) {
  const all = read(root), want = all[0].version;
  return all.filter(x => x.version !== want).map(x => `${x.file} says ${x.version}, package.json says ${want}`);
}

/** @param {string} root @param {string} to */
export function bump(root, to) {
  if (!VERSION.test(to)) throw new Error(`${to} is not a version (1.2.3 or 1.2.3-rc.1)`);
  const from = read(root)[0].version;
  const replaceFirst = (file, count) => {
    const p = path.join(root, file);
    let text = fs.readFileSync(p, "utf8"), n = 0;
    text = text.replace(/"version": "[^"]*"/g, m => (n++ < count ? `"version": "${to}"` : m));
    fs.writeFileSync(p, text);
  };
  replaceFirst("package.json", 1);
  replaceFirst("package-lock.json", 2); // the lock's own version, then the root package's
  replaceFirst("harness/.claude-plugin/plugin.json", 1);
  const left = problems(root);
  if (left.length) throw new Error(`after the bump: ${left.join("; ")}`);
  return { from, to };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const arg = process.argv[2];
  if (arg === "--check") {
    const p = problems(root);
    for (const l of p) console.error(`bump-version: ${l}`);
    if (p.length) process.exit(1);
    console.log(`bump-version: every version is ${read(root)[0].version}`);
  } else if (arg) {
    try { const { from, to } = bump(root, arg); console.log(`bump-version: ${from} -> ${to} in ${FILES.join(", ")}`); }
    catch (e) { console.error(`bump-version: ${/** @type {Error} */ (e).message}`); process.exit(1); }
  } else { console.error("usage: node scripts/bump-version.mjs <version> | --check"); process.exit(2); }
}
