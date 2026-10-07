// @ts-check
// DP-1: the release stamp cannot fail open. scripts/stamp-build-kind.mjs stops the build unless the file says release afterwards, and isPackaged reads the same line.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";
import { isPackaged } from "../kernel/devbuild.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = (/** @type {string} */ f) => spawnSync(process.execPath, [path.join(REPO, "scripts/stamp-build-kind.mjs"), f], { encoding: "utf8" });
const tree = (/** @type {import("node:test").TestContext} */ t, /** @type {string} */ text) => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "bk-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "lib")); fs.writeFileSync(path.join(root, "lib/build-kind.js"), text);
  return root;
};

test("DP-1: the checkout's own file is stamped to release, and the stamped tree is packaged while the checkout is not", t => {
  const dev = tree(t, fs.readFileSync(path.join(REPO, "lib/build-kind.js"), "utf8"));
  assert.equal(isPackaged(dev), false, "the real checkout file says development");
  const r = stamp(path.join(dev, "lib/build-kind.js"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dev, "lib/build-kind.js"), "utf8"), /BUILD_KIND = "release";/);
  assert.equal(isPackaged(dev), true);
});

test("DP-1: a reformatted marker stops the build instead of shipping development", t => {
  for (const text of ["export const BUILD_KIND='development';\n", "export const BUILD_KIND =  \"development\";\n", "// nothing\n", ""]) {
    const root = tree(t, text);
    const r = stamp(path.join(root, "lib/build-kind.js"));
    assert.equal(r.status, 1, JSON.stringify(text));
    assert.match(r.stderr, /the build stops/);
  }
});
