// @ts-check
// The saved Twenty database is two files, `<tag>.dump` and `<tag>.json` (the json carries the image, the dump's sha256 and what the store knows of the types: findGolden refuses a dump without it).
// Both must go through `npm pack` into the release and the box image. The folder is gitignored (it is a build artifact), so this asks npm what it would pack with two stand-in files in it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("npm pack carries both files of the saved Twenty database (dump and json), and package.json names the folder", t => {
  // Stand-in files go into a temporary copy of the package (the real package.json and ignore files), never into the checkout: a repo-wide scan in another test running at the same time read them and found them gone.
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-pack-"));
  t.after(() => fs.rmSync(pkg, { recursive: true, force: true }));
  for (const f of ["package.json", ".npmignore", ".gitignore"]) if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), path.join(pkg, f));
  const dir = path.join(pkg, "stores", "twenty", "golden");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "zz-pack-test.dump"), "x"); fs.writeFileSync(path.join(dir, "zz-pack-test.json"), "{}");
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: pkg, encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const packed = new Set(JSON.parse(r.stdout)[0].files.map((/** @type {any} */ f) => f.path));
  assert.ok(packed.has("stores/twenty/golden/zz-pack-test.dump"), "the dump is packed");
  assert.ok(packed.has("stores/twenty/golden/zz-pack-test.json"), "the json meta file is packed");
  const files = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).files;
  assert.ok(files.includes("stores/twenty/golden"), "package.json lists the folder, so it never depends on an ignore rule");
});
