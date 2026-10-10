// @ts-check
// Every test file in the repo is run by the test-counts runner (scripts/test-counts.mjs GLOBS), which is what node.yml's shards call. A file outside every glob is a test that never runs and a green that
// never saw it: 19 such files (scripts/, site/, harness/, examples/, local/**) sat outside until this guard. A test file that must run somewhere else says so in EXTERNAL with the workflow that runs it, and
// that workflow must name the file.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBS } from "../scripts/test-counts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** @type {Record<string, string>} test file -> the workflow (in .github/workflows) that runs it and names it */
const EXTERNAL = {};

const norm = (/** @type {string} */ f) => f.split(path.sep).join("/");
const allTests = () => fs.globSync("**/*.test.*", { cwd: ROOT, exclude: p => /(^|\/)node_modules(\/|$)|^\.git$/.test(p) }).map(norm).filter(f => !f.split("/").includes("node_modules")).sort();

test("every test file is run by the runner's globs, or names the workflow that runs it", () => {
  const covered = new Set(GLOBS.flatMap(g => fs.globSync(g, { cwd: ROOT })).map(norm));
  const workflows = fs.readdirSync(path.join(ROOT, ".github", "workflows")).map(f => [f, fs.readFileSync(path.join(ROOT, ".github", "workflows", f), "utf8")]);
  const never = allTests().filter(f => !covered.has(f) && !(EXTERNAL[f] && workflows.some(([name, text]) => name === EXTERNAL[f] && text.includes(f))));
  assert.deepEqual(never, [], `these test files are outside every runner glob, so no job runs them; add a glob to scripts/test-counts.mjs, or name them in EXTERNAL with the workflow that runs them:\n  ${never.join("\n  ")}`);
});

test("the guard sees tests: the repo has more than a thousand of them", () => {
  assert.ok(allTests().length > 1000, `only ${allTests().length} test files found`);
});

test("an EXTERNAL entry is a real file and a real workflow that still names it", () => {
  for (const [file, wf] of Object.entries(EXTERNAL)) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is gone: remove it from EXTERNAL`);
    assert.ok(fs.readFileSync(path.join(ROOT, ".github", "workflows", wf), "utf8").includes(file), `${wf} no longer names ${file}`);
  }
});
