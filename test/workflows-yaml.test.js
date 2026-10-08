// @ts-check
// Every .github/workflows/*.yml (and the composite actions) must be valid YAML with a trigger and jobs. A step name with an unquoted
// colon once made release.yml invalid, so no release or dry run could start, and the text tests that read the file as a string did not see it.
// The parser is PyYAML through python3 (the test box and the Linux runners have it; the repo takes no YAML dependency). Where python3
// or PyYAML is missing the test is skipped, and says so.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const have = spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" }).status === 0;
const PARSE = 'import sys, json, yaml\nd = yaml.safe_load(open(sys.argv[1]))\nprint(json.dumps({"keys": [str(k) for k in d] if isinstance(d, dict) else None, "jobs": sorted(d["jobs"]) if isinstance(d, dict) and isinstance(d.get("jobs"), dict) else None}))';

/** @param {string} dir @returns {string[]} */
function ymls(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? ymls(path.join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

test("every GitHub workflow parses as YAML, with a trigger and jobs", { skip: have ? false : "python3 with PyYAML is not here" }, () => {
  const files = ymls(path.join(REPO, ".github", "workflows"));
  assert.ok(files.length > 10, "the workflows were found");
  /** @type {string[]} */ const bad = [];
  for (const f of files) {
    const r = spawnSync("python3", ["-c", PARSE, f], { encoding: "utf8" });
    const rel = path.relative(REPO, f);
    if (r.status !== 0) { bad.push(`${rel}: ${String(r.stderr).trim().split("\n").slice(-3).join(" ")}`); continue; }
    const j = JSON.parse(r.stdout);
    if (!j.keys || !(j.keys.includes("on") || j.keys.includes("True"))) bad.push(`${rel}: no trigger (on:)`);
    if (!j.jobs || !j.jobs.length) bad.push(`${rel}: no jobs`);
  }
  assert.deepEqual(bad, []);
});

test("the composite actions parse as YAML too", { skip: have ? false : "python3 with PyYAML is not here" }, () => {
  const files = ymls(path.join(REPO, ".github", "actions"));
  /** @type {string[]} */ const bad = [];
  for (const f of files) {
    const r = spawnSync("python3", ["-c", "import sys, yaml; yaml.safe_load(open(sys.argv[1]))", f], { encoding: "utf8" });
    if (r.status !== 0) bad.push(`${path.relative(REPO, f)}: ${String(r.stderr).trim().split("\n").slice(-2).join(" ")}`);
  }
  assert.deepEqual(bad, []);
});
