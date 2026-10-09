// @ts-check
// The home asks a lender's computer to sign its lease request, and only a development build can be told not to (S1): a packaged build ignores the switch.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signedLeasesWanted } from "./signed-leases.js";

/** A fixture package folder of either kind. @param {string} stamp */
function fixture(stamp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signed-leases-"));
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "build-kind.js"), `export const BUILD_KIND = "${stamp}";\n`);
  return root;
}
const dirs = /** @type {string[]} */ ([]);
const make = (/** @type {string} */ stamp) => { const d = fixture(stamp); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("signed lease requests are on unless a development build is switched off", () => {
  const dev = make("development"), release = make("release");
  assert.equal(signedLeasesWanted({}, dev), true);
  assert.equal(signedLeasesWanted({ VYRE_SIGNED_LEASES_OFF: "1" }, dev), false);
  assert.equal(signedLeasesWanted({ VYRE_SIGNED_LEASES_OFF: "1" }, release), true);
});

test("the old VYRE_SIGNED_LEASES=0 switch and any value but 1 are ignored in every build", () => {
  const dev = make("development"), release = make("release");
  for (const root of [dev, release]) {
    assert.equal(signedLeasesWanted({ VYRE_SIGNED_LEASES: "0" }, root), true);
    assert.equal(signedLeasesWanted({ VYRE_SIGNED_LEASES_OFF: "0" }, root), true);
    assert.equal(signedLeasesWanted({ VYRE_SIGNED_LEASES_OFF: "true" }, root), true);
  }
});
