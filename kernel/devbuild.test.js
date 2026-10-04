// MA-5: the kernel is on by default; a packaged daemon refuses to start with it off and ignores VYRE_KERNEL=0; a development checkout may turn it off with VYRE_KERNEL=0.
// A software signer is a development-build thing: a release-kind build takes attested signers only (the same packaged-refusal rule as the development stand-in).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPackaged, devSwitch, kernelOffRefusal, kernelWanted, KERNEL_OFF_REFUSAL } from "./devbuild.js";

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

test("a packaged build (a release stamp, no stamp file, or a carried signature) refuses to start with the kernel off, with one plain line", () => {
  for (const root of [make("release"), make(null), make("development", true)]) {
    assert.equal(isPackaged(root), true);
    const line = kernelOffRefusal(false, root);
    assert.equal(line, KERNEL_OFF_REFUSAL);
    assert.ok(!line.includes("\n"), "one plain line");
  }
});

test("a packaged build with the kernel on starts", () => {
  assert.equal(kernelOffRefusal(true, make("release")), null);
});

test("a development checkout may start with the kernel off: nothing is refused", () => {
  const dev = make("development");
  assert.equal(isPackaged(dev), false);
  assert.equal(kernelOffRefusal(false, dev), null);
  assert.equal(kernelOffRefusal(true, dev), null);
  assert.equal(kernelOffRefusal(false), null, "this checkout is a development build");
});

test("the development switch is honoured only in a development build", () => {
  assert.equal(devSwitch("1", make("development")), true);
  assert.equal(devSwitch("1", make("release")), false);
});

test("the kernel is ON by default; opts.kernel decides when given; VYRE_KERNEL=0 turns it off in a development build only", () => {
  const dev = make("development"), rel = make("release");
  assert.equal(kernelWanted({}, {}, dev), true, "on by default");
  assert.equal(kernelWanted({}, { VYRE_KERNEL: "1" }, dev), true);
  assert.equal(kernelWanted({}, { VYRE_KERNEL: "0" }, dev), false, "the one-release flag in a development build");
  assert.equal(kernelWanted({}, { VYRE_KERNEL: "0" }, rel), true, "a packaged build ignores it");
  assert.equal(kernelWanted({}, { VYRE_KERNEL: "false" }, dev), true, "only exactly 0");
  assert.equal(kernelWanted({ kernel: true }, { VYRE_KERNEL: "0" }, dev), true);
  assert.equal(kernelWanted({ kernel: false }, {}, dev), false);
  assert.equal(kernelOffRefusal(kernelWanted({ kernel: false }, {}, rel), rel), KERNEL_OFF_REFUSAL, "asked off in a packaged build: refused");
});

test("start() asks before it touches the home: the refusal comes before config.ensure, the lock and the store", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "daemon", "index.js"), "utf8");
  const at = src.indexOf("export async function start(");
  const refusal = src.indexOf("kernelOffRefusal(kernelOn", at), ensure = src.indexOf("config.ensure(root)", at), lock = src.indexOf("acquire(root)", at);
  assert.ok(refusal > at && refusal < ensure && refusal < lock, "start refuses a packaged kernel-off start first");
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

import { start } from "../core/daemon/index.js";
import { tempHome } from "../test/helpers.js";
import { KERNEL_FLAG_IGNORED } from "./devbuild.js";
test("a release-kind build with VYRE_KERNEL=0 does not refuse and does not turn the kernel off: it says the variable is ignored and runs with the kernel on", { timeout: 90_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  const prior = process.env.VYRE_KERNEL; process.env.VYRE_KERNEL = "0";
  t.after(() => { if (prior === undefined) delete process.env.VYRE_KERNEL; else process.env.VYRE_KERNEL = prior; });
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root: tempHome(t), packageRoot: make("release"), log: (/** @type {string} */ m) => { lines.push(m); } });
  t.after(() => d.stop());
  assert.ok(d.kernel, "the kernel is on");
  assert.ok(lines.includes(KERNEL_FLAG_IGNORED), "one clear line at start: " + lines.slice(0, 5).join(" | "));
});
