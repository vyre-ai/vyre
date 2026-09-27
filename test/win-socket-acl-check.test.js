// @ts-check
// The icacls output parser behind scripts/win-socket-acl-check.mjs, tested off Windows against
// sample text shaped like real icacls output (Microsoft's documented format), since the real
// call only runs in the windows-socket-acl CI job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAcl } from "../scripts/win-socket-acl-check.mjs";

const WHO = { user: "alex", computer: "FV-WIN01" };

test("evaluateAcl: the user, SYSTEM and Administrators pass, in either short or DOMAIN\\name form", () => {
  const out = [
    'C:\\Users\\alex\\AppData\\Local\\Vyre\\sockets FV-WIN01\\alex:(OI)(CI)(F)',
    '                                              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    '                                              BUILTIN\\Administrators:(OI)(CI)(F)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join("\r\n");
  const r = evaluateAcl(out, "C:\\Users\\alex\\AppData\\Local\\Vyre\\sockets", WHO);
  assert.deepEqual(r, { ok: true, violations: [] });
});

test("evaluateAcl: a broader group (Users, Everyone) fails, even alongside the allowed three", () => {
  const out = [
    'C:\\Users\\alex\\AppData\\Local\\Vyre\\sockets FV-WIN01\\alex:(OI)(CI)(F)',
    '                                              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    '                                              BUILTIN\\Users:(OI)(CI)(RX)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join("\r\n");
  const r = evaluateAcl(out, "C:\\Users\\alex\\AppData\\Local\\Vyre\\sockets", WHO);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["BUILTIN\\Users"]);
});

test("evaluateAcl: Everyone or Authenticated Users on the socket file itself fails", () => {
  const out = [
    'C:\\Users\\alex\\AppData\\Local\\Vyre\\sockets\\abcd1234.sock Everyone:(F)',
    '                                                            alex:(F)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join("\r\n");
  const r = evaluateAcl(out, "C:\\Users\\alex\\AppData\\Local\\Vyre\\sockets\\abcd1234.sock", WHO);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["Everyone"]);
});

test("evaluateAcl: no ACE lines (icacls failed to report anything) is vacuously clean, not a crash", () => {
  const r = evaluateAcl("", "C:\\anything", WHO);
  assert.deepEqual(r, { ok: true, violations: [] });
});

test("evaluateAcl: the user's bare name (no computer prefix) also passes", () => {
  const out = 'C:\\dir alex:(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files';
  const r = evaluateAcl(out, "C:\\dir", WHO);
  assert.deepEqual(r, { ok: true, violations: [] });
});
