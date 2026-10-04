// @ts-check
// The release gate: a build with the placeholder key, or a install script whose key differs from
// release.js, is refused (scripts/check-release-key.mjs).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keyProblems, PLACEHOLDER } from "../scripts/check-release-key.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const tree = (/** @type {import("node:test").TestContext} */ t, /** @type {string} */ relKey, /** @type {string} */ scriptKey, /** @type {string} */ boxKey = relKey) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-key-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, "core", "vyre-core"), { recursive: true }); fs.mkdirSync(path.join(d, "scripts")); fs.mkdirSync(path.join(d, "box"));
  fs.writeFileSync(path.join(d, "box", "vyre"), `RELEASE_KEY=\${VYRE_RELEASE_KEY:-${boxKey}}\n`);
  fs.writeFileSync(path.join(d, "core", "vyre-core", "release.js"), `export const RELEASE_KEY = "${relKey}";\n`);
  fs.writeFileSync(path.join(d, "scripts", "install-mac-server.sh"), `RELEASE_KEY=${scriptKey}\n`);
  return d;
};
const run = (/** @type {string} */ d, /** @type {Record<string,string>} */ env = {}) =>
  spawnSync(process.execPath, [path.join(REPO, "scripts", "check-release-key.mjs"), d], { encoding: "utf8", env: { ...process.env, VYRE_ALLOW_PLACEHOLDER_KEY: "", ...env } });

test("release key: the placeholder is refused, a real one that matches in both places passes", t => {
  assert.equal(run(tree(t, PLACEHOLDER, PLACEHOLDER)).status, 1);
  assert.match(run(tree(t, PLACEHOLDER, PLACEHOLDER)).stderr, /placeholder/);
  const real = "MCowBQYDK2VwAyEA" + "B".repeat(43) + "=";
  assert.equal(run(tree(t, real, real)).status, 0);
  assert.deepEqual(keyProblems(tree(t, real, real)), []);
});

test("release key: an install script with another key than release.js is refused", t => {
  const a = "MCowBQYDK2VwAyEA" + "B".repeat(43) + "=", b = "MCowBQYDK2VwAyEA" + "C".repeat(43) + "=";
  const r = run(tree(t, a, b));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /differs/);
});

test("release key: a dry run may pass the placeholder, out loud", t => {
  const r = run(tree(t, PLACEHOLDER, PLACEHOLDER), { VYRE_ALLOW_PLACEHOLDER_KEY: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /allowed for this dry run/);
});

test("release key: this checkout's two keys agree", () => {
  assert.deepEqual(keyProblems(REPO), [], "the real key is pinned in both places");
});

test("release key: a box wrapper that pins another key than release.js is refused (no box would accept the release)", t => {
  const a = "MCowBQYDK2VwAyEA" + "B".repeat(43) + "=", b = "MCowBQYDK2VwAyEA" + "C".repeat(43) + "=";
  const r = run(tree(t, a, a, b));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /box\/vyre differs/);
});
