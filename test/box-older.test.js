// @ts-check
// box/vyre's older(): semver order, including prereleases (#15). The function is cut out of the wrapper and run with sh.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(REPO, "box/vyre"), "utf8");
const FN = SRC.slice(SRC.indexOf("older() {"), SRC.indexOf("# pick_release:"));

/** @param {string} a @param {string} b */
const older = (a, b) => spawnSync("sh", ["-c", `${FN}\nolder "$1" "$2"`, "sh", a, b]).status === 0;

test("older: plain versions compare by number, not by text", () => {
  assert.equal(older("0.2.0", "0.2.1"), true);
  assert.equal(older("0.2.1", "0.2.0"), false);
  assert.equal(older("0.9.0", "0.10.0"), true);
  assert.equal(older("0.2.0", "0.2.0"), false);
});

test("older: a release is above its own prereleases, so a prerelease of the same version is a downgrade (#15)", () => {
  assert.equal(older("0.2.0-rc.2", "0.2.0"), true);
  assert.equal(older("0.2.0", "0.2.0-rc.2"), false);
  assert.equal(older("0.2.0", "0.2.0-e2e.1"), false);
  assert.equal(older("0.2.1-rc.1", "0.2.1"), true);
  assert.equal(older("0.2.0", "0.2.1-rc.1"), true);
});

test("older: prereleases compare identifier by identifier, numbers by value and below words", () => {
  assert.equal(older("0.2.0-rc.2", "0.2.0-rc.10"), true);
  assert.equal(older("0.2.0-rc.10", "0.2.0-rc.2"), false);
  assert.equal(older("0.2.0-rc.1", "0.2.0-rc.1"), false);
  assert.equal(older("0.2.0-1", "0.2.0-a"), true);
  assert.equal(older("0.2.0-alpha", "0.2.0-alpha.1"), true);
  assert.equal(older("0.2.0-beta", "0.2.0-rc"), true);
});

test("older: a date stamp used when a release has no version still compares by number", () => {
  assert.equal(older("20261001120000", "20261002120000"), true);
  assert.equal(older("20261002120000", "20261001120000"), false);
});
