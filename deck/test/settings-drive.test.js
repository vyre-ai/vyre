// @ts-check
// Settings > Network > VyreDrive: each share's own access (an old box's global one when a share
// does not say).

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { shareAccess, accessWord } from "../js/drive-rows.js";

test("drive rows: a share's own access wins; an old box's global access fills in", () => {
  assert.equal(shareAccess({ name: "projects", access: "rw" }, { access: "ro" }), "rw");
  assert.equal(shareAccess({ name: "projects", access: "ro" }, { access: "rw" }), "ro");
  assert.equal(shareAccess({ name: "projects" }, { access: "rw" }), "rw", "old box: the global access");
  assert.equal(shareAccess({ name: "projects" }, {}), "ro");
  assert.equal(shareAccess(null, undefined), "ro");
  assert.equal(shareAccess({ access: "sideways" }, { access: "rw" }), "rw", "an unknown value is not trusted");
  assert.equal(accessWord("rw"), "Read and write");
  assert.equal(accessWord("ro"), "Read only");
});
