// A software signer is a development-build thing: a release-kind build takes attested signers only (the same packaged-refusal rule as the development stand-in).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A fixture package folder of either kind. @param {string | null} stamp @param {boolean} [signed] */
function fixture(stamp, signed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbuild-"));
  fs.mkdirSync(path.join(root, "lib"));
  if (stamp !== null) fs.writeFileSync(path.join(root, "lib", "build-kind.js"), `export const BUILD_KIND = "${stamp}";\n`);
  if (signed) fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), "x");
  return root;
}
const dirs = /** @type {string[]} */ ([]);
const make = (/** @type {string | null} */ stamp, signed = false) => { const d = fixture(stamp, signed); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
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
