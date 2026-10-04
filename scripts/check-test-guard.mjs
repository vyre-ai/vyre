#!/usr/bin/env node
// Fails when a *.test.js that is staged (--staged), changed in a commit range (<base>..<head>) or listed on the command line does not import scripts/mac-test-guard.mjs as its first code line.
// For a git hook: a new test file without the guard is what let a test run on a person's Mac (team-lead, 5 Oct). pre-commit: `node scripts/check-test-guard.mjs --staged`;
// pre-push: `node scripts/check-test-guard.mjs "$rsha..$lsha"` (or the whole range of new commits). `node scripts/add-mac-guard.mjs` fixes the files.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const arg = process.argv[2];
const git = (/** @type {string[]} */ a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" });
const names = arg === "--staged" ? git(["diff", "--cached", "--name-only", "--diff-filter=AM"]) : arg && /\.\./.test(arg) ? git(["diff", "--name-only", "--diff-filter=AM", arg]) : process.argv.slice(2).join("\n");
const bad = [];
for (const f of names.split("\n").map(s => s.trim()).filter(f => /\.test\.[mc]?js$/.test(f) && !/(^|\/)(fixtures|node_modules)\//.test(f))) {
  const abs = path.join(REPO, f);
  if (!fs.existsSync(abs)) continue;
  let first = "", block = false;
  for (const line of fs.readFileSync(abs, "utf8").split("\n")) {
    const t = line.trim();
    if (block) { if (t.includes("*/")) block = false; continue; }
    if (t === "" || t.startsWith("//") || t.startsWith("#!") || /^["']use strict["'];?$/.test(t)) continue;
    if (t.startsWith("/*")) { if (!t.includes("*/")) block = true; continue; }
    first = t; break;
  }
  if (!/^import\s+["'](?:[./]+\/(?:scripts\/)?|\.\/)mac-test-guard\.mjs["'];?$/.test(first)) bad.push(f);
}
if (bad.length) {
  console.error("These test files do not start with the Mac test guard (a test on a person's Mac is never allowed):\n  " + bad.join("\n  ") + "\nRun: node scripts/add-mac-guard.mjs");
  process.exit(1);
}
