// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { publishPeer } from "./peer-file.js";
import { SCRATCH } from "../../../../test/scratch.mjs";

test("the pinned address is written once, as a plain address, readable by others and replaced when vyred moves", () => {
  const file = path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-peer-")), "vyred-peer");
  assert.equal(publishPeer(null, file), false);
  assert.equal(fs.existsSync(file), false, "no pin, no file");
  assert.equal(publishPeer("::ffff:172.20.0.5", file), true);
  assert.equal(fs.readFileSync(file, "utf8"), "172.20.0.5\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(publishPeer("172.20.0.9", file), true);
  assert.equal(fs.readFileSync(file, "utf8"), "172.20.0.9\n");
  assert.equal(publishPeer("172.20.0.9", "/nonexistent-dir/x"), false, "a failed write is false, never a throw");
});
