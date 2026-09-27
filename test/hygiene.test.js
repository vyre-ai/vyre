// @ts-check
// Repository hygiene: nothing personal and no secrets in shipped code.
//
// The forbidden words and the secret pattern live in scripts/lib/hygiene.js, shared with
// scripts/docs-check, which holds the published docs to the same rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { FORBIDDEN, SECRET } from "../scripts/lib/hygiene.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = ["bin", "core", "harness", "local", "deck", "modules"];

function files(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    // dist/ and bin/ hold build output (a packaged app, compiled helpers), not source.
    if (e.name === "node_modules" || e.name === "dist" || e.name === "bin" || e.name.startsWith(".git")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|json|md|mjs|cjs|sh|html|css|swift)$|^vyre$/.test(e.name)) out.push(p);
  }
  return out;
}

test("hygiene: shipped code names no one and carries no secrets", () => {
  const hits = [];
  for (const dir of SHIPPED) for (const f of files(path.join(ROOT, dir))) {
    const text = fs.readFileSync(f, "utf8").toLowerCase();
    for (const w of FORBIDDEN) if (text.includes(w)) hits.push(`${path.relative(ROOT, f)}: personal name`);
    if (SECRET.test(fs.readFileSync(f, "utf8"))) hits.push(`${path.relative(ROOT, f)}: looks like a secret`);
  }
  assert.deepEqual(hits, []);
});

// Coral ("beacon" before 27 Sep 2026) was retired for "needs you" and banned everywhere, docs and
// boards included. Every variant it shipped in: hex (any case), rgb/rgba with any spacing.
const CORAL = /#(ff7a59|e5532f|c2411f)\b|rgba?\(\s*(255\s*,\s*122\s*,\s*89|229\s*,\s*83\s*,\s*47|194\s*,\s*65\s*,\s*31)\b/i;

function everyFile(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".git")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...everyFile(p));
    else if (/\.(js|mjs|cjs|ts|tsx|json|md|html|css|svg|swift|kt|kts|xml|plist|sh)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("hygiene: the retired coral appears nowhere in the repo", () => {
  const self = fileURLToPath(import.meta.url);
  const hits = everyFile(ROOT).filter(f => f !== self && CORAL.test(fs.readFileSync(f, "utf8")))
    .map(f => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test("hygiene: git tracks no node_modules, not even a worktree's symlink to another checkout's", () => {
  // A tracked node_modules symlink dangles on a fresh checkout, and every npx in CI dies with 216.
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return; // not a git checkout (a packed tree): nothing to check
  const hits = r.stdout.split("\0").filter(f => /(^|\/)node_modules(\/|$)/.test(f));
  assert.deepEqual(hits, []);
});
