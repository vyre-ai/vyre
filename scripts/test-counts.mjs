#!/usr/bin/env node
// The test-count guard. `node --test` with --test-force-exit ended a file's process early and still exited green, so tests silently never ran. This script:
//   run [globs...]     runs the suite (the repo's globs by default, no force-exit) with the spec reporter and the count reporter, then checks
//   check <file>       compares a counts file the reporter wrote with test/test-counts.json
//   update <file>      records the counts of a full run into test/test-counts.json (a person does this when tests are added or deliberately deleted)
//   diff <base-ref>    fails when test/test-counts.json lowered a file's count and that file's diff removed no test( or it( line
// A check fails when: a file ran fewer tests than it declares (a literal test( or it( at the start of a line), a file ran fewer than the last recorded count, or a recorded file never ran in a full run.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RECORD = path.join(REPO, "test", "test-counts.json");
export const GLOBS = ["core/**/*.test.js", "kernel/**/*.test.js", "records/**/*.test.js", "stores/**/*.test.js", "test/**/*.test.js", "deck/**/*.test.js", "modules/**/*.test.js", "local/*/*.test.js", "relay/**/*.test.js", "names/**/*.test.js", "apps/test/*.test.js", "apps/app/**/*.test.js", "lib/**/*.test.js"];

/** Literal test( and it( registrations at the start of a line in a test file: the least a run must execute. @param {string} file */
export function declared(file) {
  const src = fs.readFileSync(path.join(REPO, file), "utf8");
  return (src.match(/^(test|it)(\.\w+)?\(/gm) || []).filter(m => !/\.(skip|todo|only)\($/.test(m)).length;
}

/** @param {string} f */ const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));

/** The problems in a run. @param {Record<string, number>} ran @param {Record<string, number>} recorded @param {{ full: boolean }} opts @returns {string[]} */
export function problems(ran, recorded, { full }) {
  /** @type {string[]} */ const out = [];
  for (const [file, n] of Object.entries(ran)) {
    if (!fs.existsSync(path.join(REPO, file))) continue;
    const d = declared(file);
    if (n < d) out.push(`${file}: ran ${n} tests, declares ${d}`);
    if (recorded[file] !== undefined && n < recorded[file]) out.push(`${file}: ran ${n}, last recorded ${recorded[file]}`);
  }
  if (full) for (const file of Object.keys(recorded)) if (fs.existsSync(path.join(REPO, file)) && ran[file] === undefined) out.push(`${file}: recorded ${recorded[file]} tests, none ran`);
  return out;
}

/** @param {string} countsFile @param {boolean} full */
function check(countsFile, full) {
  const ran = readJson(countsFile), recorded = fs.existsSync(RECORD) ? readJson(RECORD) : {};
  const bad = problems(ran, recorded, { full });
  const total = Object.values(ran).reduce((a, b) => a + b, 0);
  console.log(`test-counts: ${Object.keys(ran).length} files, ${total} tests ran`);
  if (bad.length) { console.error("test-counts: tests that did not run:\n  " + bad.join("\n  ")); return 1; }
  return 0;
}

/** @param {string} base */
function diff(base) {
  const git = (/** @type {string[]} */ ...a) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" }).stdout || "";
  let before = {}; try { before = JSON.parse(git("show", `${base}:test/test-counts.json`) || "{}"); } catch { /* no record yet */ }
  const now = fs.existsSync(RECORD) ? readJson(RECORD) : {};
  /** @type {string[]} */ const bad = [];
  for (const [file, n] of Object.entries(now)) {
    const b = /** @type {Record<string, number>} */ (before)[file];
    if (b === undefined || n >= b) continue;
    const removed = git("diff", base, "--", file).split("\n").filter(l => /^-\s*(test|it)(\.\w+)?\(/.test(l)).length;
    if (!removed) bad.push(`${file}: recorded count fell from ${b} to ${n} and no test( line was removed`);
  }
  if (bad.length) { console.error("test-counts: " + bad.join("\n  ")); return 1; }
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "run") {
    const out = path.join(os.tmpdir(), `vyre-test-counts-${process.pid}.json`);
    const full = rest.length === 0;
    const r = spawnSync(process.execPath, ["--test", ...(process.env.VYRE_TEST_CONCURRENCY ? [`--test-concurrency=${process.env.VYRE_TEST_CONCURRENCY}`] : []), "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=./scripts/test-count-reporter.mjs", "--test-reporter-destination=stdout", ...(full ? GLOBS : rest)],
      { cwd: REPO, stdio: "inherit", env: { ...process.env, VYRE_TEST_COUNTS_OUT: out } });
    const g = fs.existsSync(out) ? check(out, full) : (console.error("test-counts: the run wrote no counts"), 1);
    fs.rmSync(out, { force: true });
    process.exit(r.status || g);
  } else if (cmd === "check") process.exit(check(rest[0], rest[1] === "--full"));
  else if (cmd === "update") { fs.writeFileSync(RECORD, JSON.stringify(Object.fromEntries(Object.entries(readJson(rest[0])).sort()), null, 1) + "\n"); console.log("recorded " + RECORD); }
  else if (cmd === "diff") process.exit(diff(rest[0] || "origin/work/kernel"));
  else { console.error("usage: test-counts.mjs run [globs] | check <counts.json> [--full] | update <counts.json> | diff <base-ref>"); process.exit(2); }
}
