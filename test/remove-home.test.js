// @ts-check
// removeHome retries, and when a folder still will not go it names what is left (names only).

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { removeHome } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";

test("removeHome removes a folder, and a missing one is fine", () => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-rm-"));
  fs.mkdirSync(path.join(dir, "a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "calls.log"), "x\n");
  removeHome(dir);
  assert.equal(fs.existsSync(dir), false);
  removeHome(dir);
});

test("a folder that will not go is reported with the names left in it, never their contents", { skip: process.platform === "win32" || process.getuid?.() === 0 }, t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-rm-"));
  const stuck = path.join(dir, "late");
  fs.mkdirSync(stuck);
  fs.writeFileSync(path.join(stuck, "calls.log"), "SECRET-CONTENT\n");
  fs.chmodSync(stuck, 0o500); // the files inside cannot be unlinked
  t.after(() => { fs.chmodSync(stuck, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => removeHome(dir), e => {
    assert.match(e.message, /left in vyre-rm-/);
    assert.match(e.message, /late\/, late\/calls\.log|late\/calls\.log/);
    assert.ok(!e.message.includes("SECRET-CONTENT"), "no contents");
    return true;
  });
});
