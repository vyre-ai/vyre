// @ts-check
// The idle perf gate (scripts/perf-check) runs as its own job of node.yml on a GitHub-hosted runner, one run that must pass, and the release depends on it through release.yml's call of node.yml.
// Its budgets were calibrated on a quiet hosted runner; run in shard 1 beside five busy self-hosted runners it measured the neighbours (18 Oct 2026).
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = fs.readFileSync(path.join(ROOT, ".github/workflows/node.yml"), "utf8");
const release = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
/** The text of one top-level job. @param {string} yml @param {string} name */
const job = (yml, name) => { const a = yml.indexOf(`\n  ${name}:\n`); assert.ok(a >= 0, `job ${name}`); const m = /\n  [a-z][a-z0-9-]*:\n/.exec(yml.slice(a + 1)); return yml.slice(a, m ? a + 1 + m.index : undefined); };

test("perf-check is its own job on a hosted runner, never self-hosted, and runs it once", () => {
  const perf = job(node, "perf");
  assert.match(perf, /runs-on: ubuntu-24\.04\n/);
  assert.ok(!/self-hosted|linux-heavy|CI_SELF_HOSTED/.test(perf), "the shared runners are not where the budgets hold");
  assert.equal((perf.match(/npm run perf-check/g) || []).length, 1, "one run, no retry loop");
  assert.ok(!/continue-on-error|\|\| true|retry|attempt/.test(perf), "a run that fails fails the job");
  assert.match(perf, /needs\.select\.outputs\.all == 'true'/, "it runs wherever the whole suite runs");
});

test("the test job no longer runs perf-check, so it is not measured beside busy runners", () => {
  assert.ok(!/npm run perf-check/.test(job(node, "test")));
});

test("the release depends on it: release.yml calls node.yml and the release job needs that call to succeed", () => {
  assert.match(release, /\n  node:\n    uses: \.\/\.github\/workflows\/node\.yml\n/);
  assert.match(release, /needs\.node\.result == 'success'/);
});

test("the budgets are the ones scripts/perf-check holds (this change moves the job, not the numbers)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/perf-check"), "utf8");
  assert.match(src, /under 0\.9% of one core \(p95/);
  assert.match(src, /1\.8% sustained/);
});
