// MA-5: a packaged daemon refuses to start with the kernel off; a development checkout keeps starting as it always has.
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
    assert.ok(!line.includes("\n") && line.includes("VYRE_KERNEL=1"), "one line that says what to do");
  }
});

test("a packaged build with the kernel on starts", () => {
  assert.equal(kernelOffRefusal(true, make("release")), null);
});

test("a development checkout starts with the kernel off, as today: nothing is refused", () => {
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

test("the kernel is on by opts.kernel, else by VYRE_KERNEL=1 exactly; the default is still off", () => {
  assert.equal(kernelWanted({}, {}), false);
  assert.equal(kernelWanted({}, { VYRE_KERNEL: "1" }), true);
  assert.equal(kernelWanted({}, { VYRE_KERNEL: "true" }), false);
  assert.equal(kernelWanted({ kernel: true }, {}), true);
  assert.equal(kernelWanted({ kernel: false }, { VYRE_KERNEL: "1" }), false);
});

test("start() asks before it touches the home: the refusal comes before config.ensure, the lock and the store", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "daemon", "index.js"), "utf8");
  const at = src.indexOf("export async function start(");
  const refusal = src.indexOf("kernelOffRefusal(kernelOn)", at), ensure = src.indexOf("config.ensure(root)", at), lock = src.indexOf("acquire(root)", at);
  assert.ok(refusal > at && refusal < ensure && refusal < lock, "start refuses a packaged kernel-off start first");
});
