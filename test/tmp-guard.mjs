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
// It also keeps an eye on bare $TMPDIR, for the prefixes this repo's tests and product code have
// leaked under before (vyre-*, vy-*, vssh-*, computerd-*): a test that forgets SCRATCH should not
// go unnoticed. Because other worktrees share $TMPDIR, an entry only counts when it did not exist
// before this run AND its mtime is after the "before" snapshot. A sibling worktree without this
// fix can still trip it mid-run; the printed name says which test to look at either way.
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

// vyre-presence-<uid> is the Touch ID helper's build cache, meant to stay between runs.
const LEAKY = /^(vyre-|vy-|vssh-|computerd-)(?!presence-\d+$)/;

function snapshot() {
  try { return fs.readdirSync(SCRATCH).sort(); } catch { return []; }
}

function bare() {
  try { return fs.readdirSync(os.tmpdir()).filter(n => LEAKY.test(n)); } catch { return []; }
}

if (mode === "before") {
  fs.writeFileSync(STATE, JSON.stringify({ scratch: snapshot(), bare: bare(), at: Date.now() }));
  try { fs.writeFileSync(HOMES, ""); } catch {}
  process.exit(0);
}

// mode === "after"
let before = { scratch: [], bare: [], at: Date.now() };
try { before = JSON.parse(fs.readFileSync(STATE, "utf8")); }
catch { /* no matching pretest ran; compare against nothing rather than crash the guard */ }
try { fs.rmSync(STATE, { force: true }); } catch {}

const beforeSet = new Set(before.scratch);
let added = snapshot().filter(n => !beforeSet.has(n));
const bareSet = new Set(before.bare);
const newer = n => { try { return fs.statSync(path.join(os.tmpdir(), n)).mtimeMs >= before.at; } catch { return false; } };
let strays = bare().filter(n => !bareSet.has(n) && newer(n));

// Debounce: SCRATCH is scoped to this checkout, but a second `npm test` of the same worktree
// running concurrently (or a test whose own async cleanup is still mid-flight) could otherwise be
// mistaken for a leak; give it a moment before calling it one.
for (let i = 0; (added.length || strays.length) && i < 4; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const stillThere = new Set(snapshot()), stillBare = new Set(bare());
  added = added.filter(n => stillThere.has(n));
  strays = strays.filter(n => stillBare.has(n));
}

const plural = n => `${n} entr${n === 1 ? "y" : "ies"}`;
if (added.length) {
  console.error(`tmp-guard: ${plural(added.length)} under ${SCRATCH} appeared during this test run and were never cleaned up:`);
  const made = new Map();
  try { for (const l of fs.readFileSync(HOMES, "utf8").split("\n")) { const [n, file, name] = l.split("\t"); if (n) made.set(n, `${file}: ${name}`); } } catch {}
  for (const n of added) {
    console.error("  " + path.join(SCRATCH, n) + (made.has(n) ? `  (made by ${made.get(n)})` : ""));
    // What a late write left says which writer outlived its test.
    try { for (const f of fs.readdirSync(path.join(SCRATCH, n), { recursive: true }).slice(0, 20)) console.error("      " + f); } catch {}
  }
}
if (strays.length) {
  console.error(`tmp-guard: ${plural(strays.length)} appeared bare in ${os.tmpdir()} during this test run, outside SCRATCH:`);
  for (const n of strays) console.error("  " + path.join(os.tmpdir(), n));
}

// A leak this run made is still this run's to clean up: sweep every one away (killing any vyred
// still alive inside it first) so it never sits in $TMPDIR until someone notices hundreds of them
// by hand, the way this file's own history says happened before it existed. This never hides the
// leak: it is reported and the run still fails below, whether or not the sweep finds anything to
// kill or remove.
function reap(dir) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(dir, "vyred.pid"), "utf8")); } catch {}
  if (pid && pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error(`tmp-guard: could not remove ${dir}: ${e.message}`); }
}
for (const n of added) reap(path.join(SCRATCH, n));
for (const n of strays) reap(path.join(os.tmpdir(), n));
if (added.length || strays.length) {
  console.error("Find the test that created it (grep for mkdtemp/SCRATCH), make it under SCRATCH, and clean it up in t.after/finally.");
  process.exit(1);
}
process.exit(0);
