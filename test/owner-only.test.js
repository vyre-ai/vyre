// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerOnly, ownerOnlyArgs, isOwnerOnly } from "../lib/owner-only.js";

test("owner-only: the icacls arguments drop inherited access and grant the one user", () => {
  assert.deepEqual(ownerOnlyArgs("C:\\h", "PC\\alex"), ["C:\\h", "/inheritance:r", "/grant:r", "PC\\alex:(OI)(CI)F"]);
  assert.deepEqual(ownerOnlyArgs("C:\\h\\k", "PC\\alex", false), ["C:\\h\\k", "/inheritance:r", "/grant:r", "PC\\alex:F"]);
});

test("owner-only: nothing runs off Windows, and a failing icacls never throws", () => {
  assert.equal(ownerOnly("/x", true, "linux", () => assert.fail("must not run")), false);
  assert.equal(ownerOnly("C:\\unique-1", true, "win32", () => { throw new Error("no icacls"); }), false);
  let args;
  assert.equal(ownerOnly("C:\\unique-2", true, "win32", (cmd, a) => { args = [cmd, ...a]; }), true);
  assert.equal(args[0], "icacls");
  assert.equal(ownerOnly("C:\\unique-2", true, "win32", () => assert.fail("asked once per path")), true);
});

test("owner-only: a listing that names Everyone or Users is not private", () => {
  const listing = (who) => () => `C:\\h ${who}:(OI)(CI)(F)\n`;
  assert.equal(isOwnerOnly("C:\\h", "win32", listing("PC\\alex")), true);
  assert.equal(isOwnerOnly("C:\\h", "win32", listing("Everyone")), false);
  assert.equal(isOwnerOnly("C:\\h", "win32", listing("BUILTIN\\Users")), false);
  assert.equal(isOwnerOnly("/h", "linux", () => assert.fail("not on linux")), true);
});
