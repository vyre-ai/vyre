// @ts-check
// The sealing process reads the build stamp itself (it imports nothing outside kernel/seal), and its answer must equal kernel/devbuild.js for every kind of tree.
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
