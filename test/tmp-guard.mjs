#!/usr/bin/env node
// @ts-check
// Suite-level guard against the test suite leaking temp directories. Wired as npm's
// pretest/posttest lifecycle scripts (see package.json), so it wraps the whole `npm test` run
// rather than any one file. "before" snapshots what is inside this checkout's SCRATCH folder
// (test/scratch.mjs); "after" re-lists it and fails loudly if any entry appeared during this run
// and is still there, meaning some test made a temp dir and never cleaned it up. Without this, a
// leak is silent: nothing fails, the folder just sits in $TMPDIR until someone notices hundreds of
// them (as happened here: 427 stale vyre-*/vy-* folders, found and deleted by hand).
//
// This only watches SCRATCH, not the whole of $TMPDIR. Every worktree of this repo is a full copy
// of the same test suite, and on a shared dev machine several are usually running `npm test` at
// once; a global scan would see another worktree's (possibly still-unfixed) leaks appear and
// disappear during this run and misattribute them here. SCRATCH is namespaced per checkout, so it
// only ever contains directories this worktree's own tests made.
//
// Keyed on this script's parent pid, which is the same npm process for both the pretest and the
// posttest of one `npm test` invocation, so two runs of this same worktree at once (rare, but
// possible) each get their own baseline file rather than stomping on each other's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCRATCH, HOMES } from "./scratch.mjs";

const mode = process.argv[2];
if (mode !== "before" && mode !== "after") {
  console.error("usage: tmp-guard.mjs before|after");
  process.exit(2);
}

const STATE = path.join(os.tmpdir(), `.vyre-tmp-guard-${process.ppid}.json`);

function snapshot() {
  try { return fs.readdirSync(SCRATCH).sort(); } catch { return []; }
}

if (mode === "before") {
  fs.writeFileSync(STATE, JSON.stringify(snapshot()));
  try { fs.writeFileSync(HOMES, ""); } catch {}
  process.exit(0);
}

// mode === "after"
let before = [];
try { before = JSON.parse(fs.readFileSync(STATE, "utf8")); }
catch { /* no matching pretest ran; compare against nothing rather than crash the guard */ }
try { fs.rmSync(STATE, { force: true }); } catch {}

const beforeSet = new Set(before);
let added = snapshot().filter(n => !beforeSet.has(n));

// Debounce: SCRATCH is scoped to this checkout, but a second `npm test` of the same worktree
// running concurrently (or a test whose own async cleanup is still mid-flight) could otherwise be
// mistaken for a leak; give it a moment before calling it one.
for (let i = 0; added.length && i < 4; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const stillThere = new Set(snapshot());
  added = added.filter(n => stillThere.has(n));
}

if (added.length) {
  console.error(`tmp-guard: ${added.length} entr${added.length === 1 ? "y" : "ies"} under ${SCRATCH} appeared during this test run and were never cleaned up:`);
  const made = new Map();
  try { for (const l of fs.readFileSync(HOMES, "utf8").split("\n")) { const [n, file, name] = l.split("\t"); if (n) made.set(n, `${file}: ${name}`); } } catch {}
  for (const n of added) console.error("  " + path.join(SCRATCH, n) + (made.has(n) ? `  (made by ${made.get(n)})` : ""));
  console.error("Find the test that created it (grep for mkdtemp/SCRATCH) and clean it up in t.after/finally.");
  process.exit(1);
}
process.exit(0);
