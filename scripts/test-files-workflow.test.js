// @ts-check
// .github/workflows/test-files.yml runs the test files a person names, on a runner. What it must keep: only a by-hand trigger, the inputs never spliced into a script (they reach it as environment), two slots, and an
// input check that refuses anything but test files of core/, lib/, test/ and kernel/ and a plain ref. The check step is run for real here with good and bad inputs.
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/test-files.yml"), "utf8");

test("it is a by-hand workflow with read-only contents, no secret, and two slots", () => {
  assert.match(yml, /\non:\n  workflow_dispatch:\n/);
  assert.ok(!/\n  (push|pull_request|pull_request_target|schedule|workflow_call):/.test(yml), "nothing else starts it");
  assert.match(yml, /\npermissions:\n  contents: read\n/);
  assert.ok(!/secrets\./.test(yml) && !/environment:/.test(yml));
  assert.match(yml, /group: test-files-\$\{\{ github\.run_number % 2 \}\}/, "two groups, so two at a time");
  assert.match(yml, /cancel-in-progress: false/);
});

test("the inputs reach a script only as environment, never spliced into it", () => {
  for (const m of yml.matchAll(/\$\{\{ *inputs\.(ref|files) *\}\}/g)) {
    const before = yml.slice(0, m.index), line = before.slice(before.lastIndexOf("\n") + 1);
    assert.match(line, /^\s*(REF|FILES|ref): $/, `inputs.${m[1]} is on an env or with line, not in a run script`);
  }
});

/** The input-check step's script. */
const script = (() => {
  const at = yml.indexOf("- name: Check the inputs");
  const run = yml.indexOf("        run: |\n", at) + "        run: |\n".length;
  const end = yml.indexOf("\n      - uses: actions/checkout", run);
  return yml.slice(run, end).split("\n").map(l => l.slice(10)).join("\n");
})();
const check = (/** @type {string} */ ref, /** @type {string} */ files) => spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "", REF: ref, FILES: files }, encoding: "utf8" });

test("the check lets a ref and test files or globs of the four folders through", () => {
  for (const [ref, files] of [["main", "lib/invite-link.test.js"], ["work/0.5.3/host53/space", "core/identity/*.test.js test/docs-check.test.js"], ["a1b2c3d4e5f6", "kernel/golden/*.test.js"], ["v0.5.3", "test/{a,b}.test.js"]]) {
    const r = check(ref, files);
    assert.equal(r.status, 0, `${ref} ${files}: ${r.stdout}${r.stderr}`);
  }
});

test("the check refuses another folder, a way up, a script that is no test, a bare folder glob, a hostile ref and nothing at all", () => {
  for (const [ref, files] of [
    ["main", "scripts/x.test.js"], ["main", "core/../scripts/x.test.js"], ["main", "/etc/passwd.test.js"], ["main", "core/identity/*"], ["main", "core/signins.js"], ["main", "core/a.test.js; rm -rf x"],
    ["main", "core/$(id).test.js"], ["main", ""], ["main", Array.from({ length: 41 }, (_, i) => `lib/a${i}.test.js`).join(" ")],
    ["", "lib/a.test.js"], ["../x", "lib/a.test.js"], ["-x", "lib/a.test.js"], ["main; id", "lib/a.test.js"], ["a b", "lib/a.test.js"],
  ]) assert.notEqual(check(ref, files).status, 0, `${JSON.stringify([ref, files.slice(0, 40)])} should be refused`);
});
