// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeSealed, readSealed, removeSealed } from "./store.js";
import { newMasterKey, sealItem, openItem } from "./crypto.js";
import { SCRATCH } from "../../test/scratch.mjs";

/** @param {import("node:test").TestContext} t */
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-vault-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const mode = p => fs.statSync(p).mode & 0o777;

test("store: ensureDir makes private folders and tightens loose ones", t => {
  const dir = path.join(tmp(t), "vault");
  ensureDir(dir);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, "items")), 0o700);
  fs.chmodSync(dir, 0o755); fs.chmodSync(path.join(dir, "items"), 0o777);
  ensureDir(dir);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, "items")), 0o700);
});

test("store: a sealed item is written 0600 with no temporary file left behind", t => {
  const dir = path.join(tmp(t), "vault");
  writeSealed(dir, "item_1", { v: 1, x: "one" });
  writeSealed(dir, "item_1", { v: 1, x: "two" });
  assert.deepEqual(fs.readdirSync(path.join(dir, "items")), ["item_1.json"]);
  assert.equal(mode(path.join(dir, "items", "item_1.json")), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.deepEqual(readSealed(dir, "item_1"), { v: 1, x: "two" });
});

test("store: a failed write leaves the old item and no temporary file", t => {
  const dir = path.join(tmp(t), "vault");
  writeSealed(dir, "a", { v: 1 });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => writeSealed(dir, "a", cyclic));
  assert.deepEqual(fs.readdirSync(path.join(dir, "items")), ["a.json"]);
  assert.deepEqual(readSealed(dir, "a"), { v: 1 });
});

test("store: a missing item reads as null and removing it twice is fine", t => {
  const dir = tmp(t);
  assert.equal(readSealed(dir, "none"), null);
  writeSealed(dir, "gone", { v: 1 });
  removeSealed(dir, "gone");
  removeSealed(dir, "gone");
  assert.equal(readSealed(dir, "gone"), null);
});

test("store: an id that could leave items/ is refused", t => {
  const dir = tmp(t);
  for (const id of ["../key", "a/b", "", ".", "..", "a.json", "x".repeat(65), "a b", /** @type {any} */ (null)]) {
    assert.throws(() => writeSealed(dir, id, {}), /not a valid vault item id/, String(id));
    assert.throws(() => readSealed(dir, id), /not a valid vault item id/);
    assert.throws(() => removeSealed(dir, id), /not a valid vault item id/);
  }
  assert.doesNotThrow(() => writeSealed(dir, "x".repeat(64), {}));
});

test("store: sealItem then writeSealed then readSealed then openItem round-trips", t => {
  const dir = tmp(t);
  const mk = newMasterKey();
  const fields = { username: "someone", password: "hunter2" };
  writeSealed(dir, "it1", sealItem(mk, "it1", "github", fields));
  const raw = fs.readFileSync(path.join(dir, "items", "it1.json"), "utf8");
  assert.ok(!raw.includes("hunter2"));
  assert.deepEqual(openItem(mk, "it1", "github", readSealed(dir, "it1")), fields);
  // Moved into another item's slot, it fails to open.
  writeSealed(dir, "it2", readSealed(dir, "it1"));
  assert.throws(() => openItem(mk, "it2", "github", readSealed(dir, "it2")));
});
