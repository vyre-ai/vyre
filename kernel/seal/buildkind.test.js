// @ts-check
// The sealing process reads the build stamp itself (it imports nothing outside kernel/seal), and its answer must equal kernel/devbuild.js for every kind of tree.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { devSwitch as sealSwitch } from "./process.js";
import { devSwitch as kernelSwitch } from "../devbuild.js";

test("the sealing process's devSwitch equals kernel/devbuild.js for development, release, unreadable and signed trees", t => {
  const mk = (/** @type {string | null} */ stamp, signed = false) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bk-")); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    fs.mkdirSync(path.join(d, "lib"));
    if (stamp !== null) fs.writeFileSync(path.join(d, "lib", "build-kind.js"), stamp);
    if (signed) fs.writeFileSync(path.join(d, "SHA256SUMS.sig"), "x");
    return d;
  };
  const trees = [mk('export const BUILD_KIND = "development";\n'), mk('export const BUILD_KIND = "release";\n'), mk(null), mk('export const BUILD_KIND = "development";\n', true), mk("garbage")];
  for (const root of trees) for (const v of ["1", "0", "", undefined]) assert.equal(sealSwitch(v, root), kernelSwitch(v, root), `${root} ${v}`);
  assert.equal(sealSwitch("1"), kernelSwitch("1"), "this checkout");
});

test("the default root survives a checkout path with a space", async t => {
  const { pathToFileURL } = await import("node:url");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bk space-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " ")), root = path.resolve(here, "..", "..");
  for (const d of ["kernel", "lib"]) fs.cpSync(path.join(root, d), path.join(base, d), { recursive: true, filter: f => !/\.test\.js$/.test(f) });
  fs.writeFileSync(path.join(base, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(base, "lib", "build-kind.js"), 'export const BUILD_KIND = "development";\n');
  const m = await import(pathToFileURL(path.join(base, "kernel", "seal", "process.js")).href);
  assert.equal(m.devSwitch("1"), true, "a development tree under a path with a space is development");
});
