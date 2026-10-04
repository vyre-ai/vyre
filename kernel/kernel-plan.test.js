import "../scripts/mac-test-guard.mjs";
// A release-kind build always runs with the kernel on and ignores an opt-out (it says so; it does not refuse to start). A development checkout keeps "on when asked".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kernelPlan } from "./devbuild.js";

/** A fixture package folder of either kind. @param {string | null} stamp */
function fixture(stamp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kplan-"));
  fs.mkdirSync(path.join(root, "lib"));
  if (stamp !== null) fs.writeFileSync(path.join(root, "lib", "build-kind.js"), `export const BUILD_KIND = "${stamp}";\n`);
  return root;
}
const release = fixture("release"), dev = fixture("development");
test.after(() => { for (const d of [release, dev]) fs.rmSync(d, { recursive: true, force: true }); });

test("a release-kind build is always on, and an opt-out is ignored and named", () => {
  assert.deepEqual(kernelPlan({}, release, {}), { on: true, ignored: null }, "default: on");
  assert.deepEqual(kernelPlan({}, release, { VYRE_KERNEL: "1" }), { on: true, ignored: null });
  assert.deepEqual(kernelPlan({}, release, { VYRE_KERNEL: "0" }), { on: true, ignored: "VYRE_KERNEL=0" });
  assert.deepEqual(kernelPlan({ kernel: false }, release, {}), { on: true, ignored: "opts.kernel=false" });
  assert.deepEqual(kernelPlan({}, fixture(null), { VYRE_KERNEL: "0" }), { on: true, ignored: "VYRE_KERNEL=0" }, "a folder with no build stamp is a release");
});

test("a development checkout keeps on-when-asked and never reports an ignored opt-out", () => {
  assert.deepEqual(kernelPlan({}, dev, {}), { on: false, ignored: null });
  assert.deepEqual(kernelPlan({}, dev, { VYRE_KERNEL: "1" }), { on: true, ignored: null });
  assert.deepEqual(kernelPlan({ kernel: true }, dev, {}), { on: true, ignored: null });
  assert.deepEqual(kernelPlan({}, dev, { VYRE_KERNEL: "0" }), { on: false, ignored: null });
});
