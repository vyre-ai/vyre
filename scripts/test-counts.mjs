#!/usr/bin/env node
// The test-count guard. `node --test` with --test-force-exit ended a file's process early and still exited green, so tests silently never ran. This script:
//   run [globs...]     runs the suite (the repo's globs by default, no force-exit), one process per file with a time limit (VYRE_TEST_FILE_LIMIT_MS, 300 s) that names a hung file and kills it, then checks
//   check <file>       compares a counts file the reporter wrote with test/test-counts.json
//   update <file>      records the counts of a full run into test/test-counts.json (a person does this when tests are added or deliberately deleted)
//   diff <base-ref>    fails when test/test-counts.json lowered a file's count and that file's diff removed no test( or it( line
// A check fails when: a file ran fewer tests than it declares (a literal test( or it( at the start of a line), a file ran fewer than the last recorded count, or a recorded file never ran in a full run.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RECORD = path.join(REPO, "test", "test-counts.json");
export const GLOBS = ["core/**/*.test.js", "kernel/**/*.test.js", "records/**/*.test.js", "stores/**/*.test.js", "test/**/*.test.js", "web/**/*.test.js", "modules/**/*.test.js", "local/*/*.test.js", "relay/**/*.test.js", "names/**/*.test.js", "apps/test/*.test.js", "apps/app/**/*.test.js", "lib/**/*.test.js"];

/** Literal test( and it( registrations at the start of a line in a test file: the least a run must execute. @param {string} file */
export function declared(file) {
  const src = fs.readFileSync(path.join(REPO, file), "utf8");
  return (src.match(/^(test|it)\(/gm) || []).length;
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

/** What kept a hung file's processes open: the live libuv handles of every diagnostic report in the folder, one line each. @param {string} dir */
function openHandles(dir) {
  /** @type {string[]} */ const lines = [];
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith(".json")); } catch { /* no report was written */ }
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      const live = (r.libuv || []).filter((/** @type {any} */ h) => h.is_active && !["signal", "async", "check", "prepare", "idle"].includes(h.type));
      lines.push(`  process ${r.header && r.header.processId} (${String((r.header && r.header.commandLine || []).slice(-1)[0] || "").slice(-70)}): ${live.length} live handle(s)` + live.slice(0, 8).map((/** @type {any} */ h) => `\n    ${h.type}${h.remoteEndpoint ? " to " + JSON.stringify(h.remoteEndpoint) : ""}${h.localEndpoint ? " on " + JSON.stringify(h.localEndpoint) : ""}${h.path ? " " + h.path : ""}${h.pid ? " pid " + h.pid : ""}`).join(""));
      const st = r.javascriptStack && r.javascriptStack.stack; if (st && st.length) lines.push("    at " + st.slice(0, 4).join("\n       "));
    } catch { /* an unreadable report */ }
  }
  return lines.length ? "\n----- what kept it open (node diagnostic report):\n" + lines.join("\n") + "\n" : "\n----- no diagnostic report was written\n";
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

const BOOT_FIRST = ["test/daemon-smoke.test.js", "kernel/boot.test.js"];
const [cmd, ...rest] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "run") {
    const shard = /^(\d+)\/(\d+)$/.exec(process.env.VYRE_TEST_SHARD || "");
    const full = rest.length === 0 && !shard;
    const all = (rest.length === 0 ? GLOBS : rest).flatMap(g => fs.globSync(g, { cwd: REPO })).map(f => f.split(path.sep).join("/")).filter(f => !f.split("/").includes("node_modules")).filter((f, i, a) => a.indexOf(f) === i).sort();
    // The boot tests run first, and always in shard 1, so a broken boot fails in minutes; the other files are sharded as before.
    const boot = BOOT_FIRST.filter(f => all.includes(f)), others = all.filter(f => !boot.includes(f));
    const files = [...(!shard || Number(shard[1]) === 1 ? boot : []), ...others.filter((_, i) => !shard || i % Number(shard[2]) === Number(shard[1]) - 1)];
    const limit = Number(process.env.VYRE_TEST_FILE_LIMIT_MS || 300000), width = Number(process.env.VYRE_TEST_CONCURRENCY || Math.max(2, os.availableParallelism() - 1));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-test-counts-"));
    /** @type {Record<string, number>} */ const ran = {};
    /** @type {string[]} */ const failed = [], hung = [];
    let next = 0;
    // One process per file with a time limit: a file that keeps the process open after its tests (what --test-force-exit used to hide) is named and killed, not left to run the job out.
    const worker = async () => {
      for (let i = next++; i < files.length; i = next++) {
        const f = files[i], out = path.join(dir, `${i}.json`);
        await new Promise(done => {
          // The file runs in its own process group with node's diagnostic report armed on SIGUSR2: a file that keeps the process open after its tests is not only named, the report lists the handles that kept it open.
          const rep = path.join(dir, `rep-${i}`);
          fs.mkdirSync(rep, { recursive: true });
          // (flags, not NODE_OPTIONS: the test runner hands execArgv to the file's process and nothing to the node processes the file starts, some of which run under the permission model)
          const child = spawn(process.execPath, ["--import", path.join(REPO, "scripts", "lib", "trace-timers.mjs"), "--report-on-signal", "--report-signal=SIGUSR2", `--report-directory=${rep}`, "--import", "./test/cleanup-scratch.mjs", "--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=./scripts/test-count-reporter.mjs", "--test-reporter-destination=stdout", f],
            { cwd: REPO, detached: process.platform !== "win32", env: { ...process.env, VYRE_TEST_COUNTS_OUT: out, VYRE_TEST_COUNTS_FILE: f } });
          let buf = ""; child.stdout.on("data", d => buf += d); child.stderr.on("data", d => buf += d);
          const signalGroup = (/** @type {NodeJS.Signals} */ sig) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* gone */ } };
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true; signalGroup("SIGUSR2");
            setTimeout(() => { buf += openHandles(rep); signalGroup("SIGKILL"); }, 2500);
          }, limit);
          child.on("close", code => {
            clearTimeout(timer);
            if (fs.existsSync(out)) Object.assign(ran, readJson(out)); else ran[f] ??= 0;
            if (timedOut) hung.push(f); else if (code) failed.push(f);
            if (timedOut || code) process.stdout.write(`\n===== ${timedOut ? "HUNG (killed after " + limit / 1000 + " s)" : "FAILED"}: ${f}\n${buf}\n`);
            else process.stdout.write(`ok   ${f}\n`);
            done(undefined);
          });
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, files.length) }, worker));
    fs.rmSync(dir, { recursive: true, force: true });
    // No file is allowed to be red: there is no list of known failures. A file that fails or does not finish fails the run.
    if (hung.length) console.error("test-counts: files that did not finish (an open handle or a test that never settles):\n  " + hung.join("\n  "));
    if (failed.length) console.error("test-counts: files that failed:\n  " + failed.join("\n  "));
    const countsFile = process.env.VYRE_TEST_COUNTS_KEEP || path.join(os.tmpdir(), `vyre-test-counts-${process.pid}.json`);
    fs.writeFileSync(countsFile, JSON.stringify(ran, null, 1) + "\n");
    const g = check(countsFile, full); if (!process.env.VYRE_TEST_COUNTS_KEEP) fs.rmSync(countsFile, { force: true });
    process.exit(hung.length || failed.length || g ? 1 : 0);
  } else if (cmd === "check") process.exit(check(rest[0], rest[1] === "--full"));
  else if (cmd === "update") { fs.writeFileSync(RECORD, JSON.stringify(Object.fromEntries(Object.entries(readJson(rest[0])).sort()), null, 1) + "\n"); console.log("recorded " + RECORD); }
  else if (cmd === "diff") process.exit(diff(rest[0] || "origin/work/kernel"));
  else { console.error("usage: test-counts.mjs run [globs] | check <counts.json> [--full] | update <counts.json> | diff <base-ref>"); process.exit(2); }
}
