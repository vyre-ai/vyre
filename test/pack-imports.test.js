// @ts-check
// The package ships every file its code imports (0.1.0-rc.1 left packages/module-sdk out, and
// every `vyre` call failed to start). Reads `npm pack --dry-run`'s file list; nothing is packed.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { missingImports, ignoredShipped } from "../scripts/lib/pack-imports.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

const packed = () => JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0].files.map((/** @type {{ path: string }} */ f) => f.path);

test("pack: no file git ignores, such as a Mac build output left in the tree", t => {
  const ignored = ignoredShipped(REPO, packed());
  if (ignored === null) return t.skip("not a git checkout");
  assert.deepEqual(ignored, []);
});

test("pack: every relative import in the shipped files names a shipped file", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const files = JSON.parse(out)[0].files.map((/** @type {{ path: string }} */ f) => f.path);
  assert.ok(files.includes("core/cli/commands/module.js"), "the list is the package's");
  assert.deepEqual(missingImports(REPO, files), []);
});
