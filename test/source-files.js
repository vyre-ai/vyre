// @ts-check
// The source files the "stays single" guards (test/*-single.test.js) read: tracked code, minus tests, vendored code, generated pages, docs, scripts and examples. Falls back to walking the folder
// when this is not a git checkout (the tests also run from a copied tree on the test boxes).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /(^|\/)test\/|\.test\.|^site\/|\/vendor\/|^docs\/|\/fixtures\/|legacy-fixture|^scripts\/|^examples\/|^apps\/app\/(ui\/marks|src\/terminal\/xterm)\//;

/** Every code file path (relative), tests and the like left out. */
export function sourceFiles() {
  /** @type {string[]} */ let all = [];
  try { all = execFileSync("git", ["ls-files"], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").filter(Boolean); } catch { /* not a checkout */ }
  if (all.length < 100) {
    all = [];
    const walk = (/** @type {string} */ dir) => { for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { if (e.name === "node_modules" || e.name === ".git") continue; const rel = dir ? `${dir}/${e.name}` : e.name; if (e.isDirectory()) walk(rel); else all.push(rel); } };
    walk("");
  }
  return all.filter(f => /\.(js|mjs|cjs|ts|tsx)$/.test(f) && !SKIP.test(f));
}

/**
 * Lines of code (not comment lines, trailing // comments cut) where any pattern matches, as `file:line: text`, skipping the files in `allowed`.
 * @param {RegExp[]} patterns @param {Map<string, string>} allowed
 */
export function findInSource(patterns, allowed) {
  /** @type {string[]} */ const found = [];
  for (const f of sourceFiles()) {
    if (allowed.has(f) || [...allowed.keys()].some(a => a.endsWith("/") && f.startsWith(a))) continue;
    let text; try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    text.split("\n").forEach((l, i) => {
      if (/^\s*(\*|\/\/|\/\*)/.test(l)) return;
      const code = l.replace(/\s\/\/.*$/, "");
      if (patterns.some(r => r.test(code))) found.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
  }
  return found;
}
