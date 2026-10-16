// The test-count guard (scripts/test-counts.mjs) fails when a test file ran fewer tests than it declares or than the last recorded run.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { declared, problems, mustRunProblems, MUST_RUN, NODE_TEST_EXEC_FLAGS } from "../scripts/test-counts.mjs";
import fs from "node:fs";
import path from "node:path";

const FILE = "test/test-counts.test.js";

test("declared counts the test( and it( registrations at the start of a line", () => {
  assert.ok(declared(FILE) >= 3);
});

test("a file that ran fewer tests than it declares fails", () => {
  const d = declared(FILE);
  assert.deepEqual(problems({ [FILE]: d }, {}, { full: false }), []);
  assert.match(problems({ [FILE]: d - 1 }, {}, { full: false })[0], /declares/);
});

test("a file that ran fewer tests than the last recorded count fails, and more passes", () => {
  const d = declared(FILE);
  assert.match(problems({ [FILE]: d }, { [FILE]: d + 5 }, { full: false })[0], /last recorded/);
  assert.deepEqual(problems({ [FILE]: d + 2 }, { [FILE]: d }, { full: false }), []);
});

test("a recorded file that never ran fails a full run only", () => {
  assert.deepEqual(problems({}, { [FILE]: 3 }, { full: false }), []);
  assert.match(problems({}, { [FILE]: 3 }, { full: true })[0], /none ran/);
});

test("a test that must run here and skipped fails; a skip of another test, or a test that ran, does not", () => {
  const must = { "core/runner/hardening.test.js": ["fscrypt workspace"], "core/runner/lent-wire.test.js": ["*"] };
  assert.deepEqual(mustRunProblems({ "core/runner/hardening.test.js": ["fscrypt workspace: opens with the leased key"] }, must), ['core/runner/hardening.test.js: skipped "fscrypt workspace: opens with the leased key" where it must run']);
  assert.deepEqual(mustRunProblems({ "core/runner/lent-wire.test.js": ["anything"] }, must).length, 1, "* names every test of the file");
  assert.deepEqual(mustRunProblems({ "core/runner/hardening.test.js": ["macOS: something"], "test/other.test.js": ["x"] }, must), []);
  assert.deepEqual(mustRunProblems({}, must), []);
});

test("test/must-run.json names real test files", () => {
  const list = JSON.parse(fs.readFileSync(MUST_RUN, "utf8")).tests;
  assert.ok(Object.keys(list).length >= 5);
  for (const f of Object.keys(list)) assert.ok(fs.existsSync(path.join(path.dirname(MUST_RUN), "..", f)), `${f} is in must-run.json and is gone`);
});

test("the runner passes type stripping on Node 22 so apps/app tests can import .ts", async () => {
  if (process.features.typescript) return;
  assert.deepEqual(NODE_TEST_EXEC_FLAGS, ["--experimental-strip-types"]);
  const { spawnSync } = await import("node:child_process");
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const r = spawnSync(process.execPath, ["scripts/test-counts.mjs", "run", "apps/app/src/auth/paired.test.js"], {
    encoding: "utf8",
    cwd: repo,
    timeout: 120_000,
    env: Object.fromEntries(Object.entries({ ...process.env, VYRE_TEST_FILE_LIMIT_MS: "60000" }).filter(([k]) => !["NODE_TEST_CONTEXT", "VYRE_TEST_SHARD", "VYRE_TEST_COUNTS_KEEP", "VYRE_MUST_RUN"].includes(k))),
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("a red file's first failing test and its error block are in the runner's summary, not only its name", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-detail-"));
  const f = path.join(dir, "red.test.js");
  fs.writeFileSync(f, 'import test from "node:test"; import assert from "node:assert/strict";\ntest("passes", () => {});\ntest("the answer is wrong", () => { assert.equal(41, 42, "the answer was off by one"); });\n');
  try {
    const r = spawnSync(process.execPath, ["scripts/test-counts.mjs", "run", f], { encoding: "utf8", cwd: path.join(path.dirname(new URL(import.meta.url).pathname), ".."), env: Object.fromEntries(Object.entries({ ...process.env, VYRE_TEST_FILE_LIMIT_MS: "60000" }).filter(([k]) => !["NODE_TEST_CONTEXT", "VYRE_TEST_SHARD", "VYRE_TEST_COUNTS_KEEP", "VYRE_MUST_RUN"].includes(k))) });
    const summary = r.stderr.slice(r.stderr.indexOf("the first failure of each red file"));
    assert.ok(summary.startsWith("the first failure"), `no first-failure section in: ${r.stderr.slice(-400)}`);
    assert.match(summary, /the answer is wrong/, "the failing test's name");
    assert.match(summary, /the answer was off by one/, "its error message");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
