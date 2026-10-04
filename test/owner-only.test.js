// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerOnly, ownerOnlyArgs, sddlIsOwnerOnly, sidFromWhoami, systemRoot } from "../lib/owner-only.js";

const SID = "S-1-5-21-111-222-333-1001";

test("owner-only: the current user's SID is read from whoami's csv", () => {
  assert.equal(sidFromWhoami(`"PC\\alex","${SID}"\r\n`), SID);
  assert.equal(sidFromWhoami("nothing"), null);
});

test("owner-only: grant by SID first, then drop inherited access, in two calls", () => {
  assert.deepEqual(ownerOnlyArgs("C:\\h", SID), [["C:\\h", "/grant:r", `*${SID}:(OI)(CI)F`], ["C:\\h", "/inheritance:r"]]);
  assert.deepEqual(ownerOnlyArgs("C:\\h\\k", SID, false)[0], ["C:\\h\\k", "/grant:r", `*${SID}:F`]);
});

test("owner-only: Windows tools are run by full path from SystemRoot, never by name", () => {
  assert.equal(systemRoot({ SystemRoot: "D:\\Win" }), "D:\\Win");
  assert.equal(systemRoot({ SystemRoot: ".\\evil" }), "C:\\Windows");
  assert.equal(systemRoot({}), "C:\\Windows");
  const cmds = [];
  const run = (cmd, a) => { cmds.push(cmd); return cmd.endsWith("whoami.exe") ? `"PC\\alex","${SID}"` : ""; };
  assert.equal(ownerOnly("C:\\unique-1", true, "win32", run, { SystemRoot: "C:\\Windows" }), true);
  assert.deepEqual(cmds, ["C:\\Windows\\System32\\whoami.exe", "C:\\Windows\\System32\\icacls.exe", "C:\\Windows\\System32\\icacls.exe"]);
});

test("owner-only: nothing runs off Windows, and a failing tool never throws", () => {
  assert.equal(ownerOnly("/x", true, "linux", () => assert.fail("must not run")), false);
  assert.equal(ownerOnly("C:\\unique-2", true, "win32", () => { throw new Error("no icacls"); }), false);
  assert.equal(ownerOnly("C:\\unique-3", true, "win32", () => "no sid here"), false);
});

test("owner-only: the SDDL check looks at trustees, in any language", () => {
  assert.equal(sddlIsOwnerOnly(`D:PAI(A;OICI;FA;;;${SID})`), true);
  assert.equal(sddlIsOwnerOnly(`D:PAI(A;OICI;FA;;;${SID})(A;OICI;0x1200a9;;;BU)`), false);
  assert.equal(sddlIsOwnerOnly("D:PAI(A;OICI;FA;;;WD)"), false);
  assert.equal(sddlIsOwnerOnly("D:PAI(A;OICI;FA;;;AU)"), false);
  assert.equal(sddlIsOwnerOnly("D:PAI(A;OICI;FA;;;S-1-5-32-545)"), false);
  for (const t of ["IU", "NU", "BG", "S-1-5-4", "S-1-5-2", "S-1-5-32-546"]) assert.equal(sddlIsOwnerOnly(`D:PAI(A;OICI;FA;;;${t})`), false, t);
  assert.equal(sddlIsOwnerOnly("D:PAI(D;OICI;FA;;;WD)(A;OICI;FA;;;SY)"), true, "a deny for Everyone does not open the folder");
});
