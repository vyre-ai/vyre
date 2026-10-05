// The kernel is always on: there is no switch to turn it off, in a release or a development build. A software signer is a development-build thing.
// A software signer is a development-build thing: a release-kind build takes attested signers only (the same packaged-refusal rule as the development stand-in).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPackaged, devSwitch } from "./devbuild.js";
import { start } from "../core/daemon/index.js";
import { tempHome } from "../test/helpers.js";

/** A fixture package folder of either kind. @param {string | null} stamp @param {boolean} [signed] */
function fixture(stamp, signed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbuild-"));
  fs.mkdirSync(path.join(root, "lib"));
  if (stamp !== null) fs.writeFileSync(path.join(root, "lib", "build-kind.js"), `export const BUILD_KIND = "${stamp}";\n`);
  if (signed) fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), "x");
  return root;
}
const dirs = [];
const make = (...a) => { const d = fixture(...a); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("a packaged build is told by a release stamp, no stamp file, or a carried signature", () => {
  for (const root of [make("release"), make(null), make("development", true)]) assert.equal(isPackaged(root), true);
  assert.equal(isPackaged(make("development")), false);
});

test("the development switch is honoured only in a development build", () => {
  assert.equal(devSwitch("1", make("development")), true);
  assert.equal(devSwitch("1", make("release")), false);
});

test("there is no kernel-off mode: VYRE_KERNEL and opts.kernel are not read, so a daemon always runs with the kernel on", { timeout: 90_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  const prior = process.env.VYRE_KERNEL; process.env.VYRE_KERNEL = "0";
  t.after(() => { if (prior === undefined) delete process.env.VYRE_KERNEL; else process.env.VYRE_KERNEL = prior; });
  const d = await start({ root: tempHome(t), kernel: false, log: () => {} });
  t.after(() => d.stop());
  assert.ok(d.kernel, "the kernel is on whatever was asked");
});

import { unattestedAllowed } from "./seal/process.js";
test("a software signer (no attestation) is taken only in a development build asked for it with VYRE_SEAL_UNATTESTED=1; a release-kind build refuses it", () => {
  const dev = make("development"), rel = make("release"), signed = make("development", true);
  assert.equal(unattestedAllowed({ VYRE_SEAL_UNATTESTED: "1" }, dev), true);
  assert.equal(unattestedAllowed({}, dev), false, "not asked for");
  assert.equal(unattestedAllowed({ VYRE_SEAL_UNATTESTED: "true" }, dev), false, "only exactly 1");
  assert.equal(unattestedAllowed({ VYRE_SEAL_UNATTESTED: "1" }, rel), false, "a release stamp ignores it");
  assert.equal(unattestedAllowed({ VYRE_SEAL_UNATTESTED: "1" }, signed), false, "a carried release signature too");
  assert.equal(unattestedAllowed({ VYRE_SEAL_UNATTESTED: "1" }, make(null)), false, "no stamp means packaged");
});
