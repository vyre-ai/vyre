// @ts-check
// Repository hygiene: nothing personal and no secrets in shipped code.
//
// The forbidden words and the secret pattern live in scripts/lib/hygiene.js, shared with
// scripts/docs-check, which holds the published docs to the same rules.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { FORBIDDEN, SECRET } from "../scripts/lib/hygiene.js";
import { discover } from "../core/modules/index.js";

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

test("hygiene: every shipped module's manifest is one discover() finds no problem with", () => {
  // A camelCase tool or event name (or any other validate() problem) used to take the whole
  // module down with no line anywhere saying so (teammates, 2026-09-28); this catches it in CI
  // before it ships, not only when someone happens to call discover() by hand.
  const found = discover(["core", "local", "modules"].map(d => path.join(ROOT, d)));
  const bad = found.filter(f => f.problems.length).map(f => `${path.relative(ROOT, f.dir)}: ${f.problems.join("; ")}`);
  assert.deepEqual(bad, []);
});

// lib/caller.js (isPerson/isAgent/agentName/isOwnerDevice) exists because module after module
// hand-wrote its own copy of "is this the person?" and several got it backwards - "no agent name
// means the person" admits a bare model session, the harness, a guest and a hook, none of which
// is an owner surface or device (cohesion audit, 2026-09-28). This freezes today's known copies
// (allowlist only shrinks, boundaries.test.js's own convention) so a NEW one is caught here
// instead of found the same way, by hand, months later.
const OWN_PERSON_SET = /=\s*new Set\(\[\s*"cli"/;
const KNOWN_OWN_PERSON_SETS = new Set([
  "core/presence/index.js",  // the canonical home PERSON_SURFACES lives in
  "core/daemon/index.js",    // kernel's own dispatch, not a module hand-rolling the concept
  "local/hands-chrome-mac/caller.js", // the standalone Chrome package's sanctioned copy: caller.test.js compares it to core/presence PERSON_SURFACES
  "core/harness/rules.js", "core/link/box.js", "core/link/mac.js",
]);
test("hygiene: no new hand-rolled copy of PERSON_SURFACES (a Set of exactly cli/local/deck/capsule)", () => {
  const hits = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".js") || e.name.endsWith(".test.js")) continue;
      const rel = path.relative(ROOT, p);
      if (rel.startsWith("lib" + path.sep)) continue; // lib/caller.js is the point of this test
      if (OWN_PERSON_SET.test(fs.readFileSync(p, "utf8")) && !KNOWN_OWN_PERSON_SETS.has(rel)) hits.push(rel);
    }
  };
  for (const dir of ["core", "local"]) walk(path.join(ROOT, dir));
  assert.deepEqual(hits, [], "import isPerson from lib/caller.js instead of a new local copy of its Set");
});
