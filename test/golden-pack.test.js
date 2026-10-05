// @ts-check
// The saved Twenty database is two files, `<tag>.dump` and `<tag>.json` (the json carries the image, the dump's sha256 and what the store knows of the types: findGolden refuses a dump without it).
// Both must go through `npm pack` into the release and the box image. The folder is gitignored (it is a build artifact), so this asks npm what it would pack with two stand-in files in it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("npm pack carries both files of the saved Twenty database (dump and json), and package.json names the folder", () => {
  const dir = path.join(REPO, "stores", "twenty", "golden");
  const made = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const dump = path.join(dir, "zz-pack-test.dump"), meta = path.join(dir, "zz-pack-test.json");
  fs.writeFileSync(dump, "x"); fs.writeFileSync(meta, "{}");
  try {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, r.stderr);
    const packed = new Set(JSON.parse(r.stdout)[0].files.map((/** @type {any} */ f) => f.path));
    assert.ok(packed.has("stores/twenty/golden/zz-pack-test.dump"), "the dump is packed");
    assert.ok(packed.has("stores/twenty/golden/zz-pack-test.json"), "the json meta file is packed");
    const files = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).files;
    assert.ok(files.includes("stores/twenty/golden"), "package.json lists the folder, so it never depends on an ignore rule");
  } finally {
    fs.rmSync(dump, { force: true }); fs.rmSync(meta, { force: true });
    if (made) fs.rmSync(dir, { recursive: true, force: true });
  }
});
