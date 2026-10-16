// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { keychainWriteCommand } from "./sealed-key.js";

test("the seal key is written on stdin, never on the keychain command's arguments", () => {
  const hex = "ab".repeat(32);
  const cmd = keychainWriteCommand("desk", hex);
  assert.deepEqual(cmd.argv, ["-i"]);
  assert.equal(cmd.argv.join(" ").includes(hex), false);
  assert.equal(cmd.stdin.includes(hex), true);
  assert.equal(cmd.stdin.includes("vyre-seal"), true);
});
