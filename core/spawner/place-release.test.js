// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "place-release.sh");
const run = (/** @type {string} */ root, /** @type {string} */ rel) => spawnSync("sh", [SCRIPT, root, rel], { encoding: "utf8" });

test("place-release: the three signed files are copied to the package root as plain files, and a file the host no longer has is removed", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-place-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "pkg"), rel = path.join(base, "rel");
  fs.mkdirSync(root); fs.mkdirSync(rel);
  for (const f of ["SHA256SUMS", "SHA256SUMS.sig", "modules.json"]) fs.writeFileSync(path.join(rel, f), `${f} 1\n`);
  fs.writeFileSync(path.join(rel, "shell.json"), "not placed");
  assert.equal(run(root, rel).status, 0);
  for (const f of ["SHA256SUMS", "SHA256SUMS.sig", "modules.json"]) assert.equal(fs.readFileSync(path.join(root, f), "utf8"), `${f} 1\n`);
  assert.ok(!fs.existsSync(path.join(root, "shell.json")), "only the three files");
  // The next release has no list: the old one does not linger.
  fs.rmSync(path.join(rel, "modules.json"));
  run(root, rel);
  assert.ok(!fs.existsSync(path.join(root, "modules.json")));
  assert.ok(fs.existsSync(path.join(root, "SHA256SUMS")));
});

test("place-release: a link in the published folder is never followed, and a development checkout (no folder) places nothing", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-place-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "pkg"), rel = path.join(base, "rel");
  fs.mkdirSync(root); fs.mkdirSync(rel);
  fs.writeFileSync(path.join(base, "secret"), "secret\n");
  fs.symlinkSync(path.join(base, "secret"), path.join(rel, "modules.json"));
  run(root, rel);
  assert.ok(!fs.existsSync(path.join(root, "modules.json")), "a link is not copied");
  const dev = fs.mkdtempSync(path.join(base, "dev-"));
  assert.equal(run(dev, path.join(base, "no-such-folder")).status, 0);
  assert.deepEqual(fs.readdirSync(dev), []);
});
