// @ts-check
// scripts/deploy/verify-wink-out.mjs: the deploy refuses a build that is not signed by the pinned release key. A throwaway-signed build
// (what a dry run uploads) and an empty folder both fail; the script never prints a key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWinkOut } from "../build-wink-out.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-wink-out.mjs");
const run = dir => spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });

test("verify-wink-out: a throwaway-signed build is refused, and so is an empty folder", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wink-verify-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, "wink-out");
  await buildWinkOut({ release: "0.2.0", out, throwaway: true });
  const bad = run(out);
  assert.notEqual(bad.status, 0, "not the pinned key");
  assert.match(bad.stderr, /FAILED|placeholder/);
  const empty = path.join(tmp, "empty"); fs.mkdirSync(empty);
  const none = run(empty);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no sealed folder/);
});
