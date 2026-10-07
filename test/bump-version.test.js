// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bump, problems, read } from "../scripts/bump-version.mjs";
import { SCRATCH } from "./scratch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("bump-version: the repo's package, lockfile and Claude Code plugin all carry one version", () => {
  assert.deepEqual(problems(REPO), []);
});

test("bump-version: one command moves package.json, both lock versions and the plugin manifest, keeps the formatting, and refuses a bad version", t => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "vyre-bump-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const f of ["package.json", "package-lock.json", "harness/.claude-plugin/plugin.json"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  }
  const before = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  assert.deepEqual(bump(root, "9.8.7"), { from: read(REPO)[0].version, to: "9.8.7" });
  assert.deepEqual(read(root).map(x => x.version), ["9.8.7", "9.8.7", "9.8.7", "9.8.7"]);
  assert.deepEqual(problems(root), []);
  // Only the two version strings of the lockfile changed: everything else, byte for byte.
  const after = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  assert.equal(after.split("\n").length, before.split("\n").length);
  assert.equal(after.split(`"9.8.7"`).length - 1, 2);
  // A prerelease is a version too; junk is not, and nothing is written for it.
  bump(root, "9.9.0-rc.2");
  assert.equal(read(root)[3].version, "9.9.0-rc.2");
  assert.throws(() => bump(root, "v1"), /not a version/);
  assert.equal(read(root)[0].version, "9.9.0-rc.2");
  // One that disagrees is named.
  fs.writeFileSync(path.join(root, "harness/.claude-plugin/plugin.json"), fs.readFileSync(path.join(root, "harness/.claude-plugin/plugin.json"), "utf8").replace("9.9.0-rc.2", "0.0.1"));
  assert.match(problems(root)[0], /plugin\.json says 0\.0\.1, package\.json says 9\.9\.0-rc\.2/);
});
