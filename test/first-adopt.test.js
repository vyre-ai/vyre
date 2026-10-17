// The record of the first adoption (lib/first-adopt.js): who, when, and the one question the vault asks of it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noteFirstAdopt, firstAdoptOf, clearFirstAdopt, firstRunMayCreate, FIRST_ADOPT_MS } from "../lib/first-adopt.js";

const SPACE = "spc_aaaaaaaaaa";

test("the record holds the device and the time, is cleared on release, and answers only inside its bounds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-fa-lib-"));
  assert.equal(firstAdoptOf(root), null);
  noteFirstAdopt(root, "device:d1", 5_000);
  assert.deepEqual(firstAdoptOf(root), { device: "device:d1", at: 5_000 });
  const q = { root, caller: "device:d1", space: SPACE, ownSpace: SPACE, now: 5_000 + 1000 };
  assert.equal(firstRunMayCreate(q), true);
  assert.equal(firstRunMayCreate({ ...q, now: 5_000 + FIRST_ADOPT_MS }), true, "the last moment of the window");
  assert.equal(firstRunMayCreate({ ...q, now: 5_000 + FIRST_ADOPT_MS + 1 }), false, "after ten minutes");
  assert.equal(firstRunMayCreate({ ...q, now: 4_000 }), false, "a clock before the record");
  assert.equal(firstRunMayCreate({ ...q, caller: "device:d2" }), false, "another device");
  assert.equal(firstRunMayCreate({ ...q, caller: "cli" }), false);
  assert.equal(firstRunMayCreate({ ...q, space: "spc_bbbbbbbbbb" }), false, "another space");
  assert.equal(firstRunMayCreate({ ...q, ownSpace: "" }), false, "a server that cannot name its space");
  clearFirstAdopt(root);
  assert.equal(firstAdoptOf(root), null);
  assert.equal(firstRunMayCreate(q), false, "released");
  fs.writeFileSync(path.join(root, "identity", "first-adopt.json"), "not json");
  assert.equal(firstAdoptOf(root), null, "a damaged record is no record");
});
