// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, unexpected } from "./check-android-permissions.mjs";

const OUT = `package: sh.vyre.app
uses-permission: name='android.permission.CAMERA'
uses-permission: name='android.permission.INTERNET'
uses-permission-sdk-23: name='android.permission.VIBRATE'
uses-permission: name='sh.vyre.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
uses-permission: name='android.permission.CAMERA'
`;

test("parse: the package and each permission once", () => {
  const { pkg, perms } = parse(OUT);
  assert.equal(pkg, "sh.vyre.app");
  assert.deepEqual(perms, ["android.permission.CAMERA", "android.permission.INTERNET", "android.permission.VIBRATE", "sh.vyre.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"]);
});

test("unexpected: anything off the list, with {package} filled in", () => {
  const { pkg, perms } = parse(OUT);
  const allowed = ["android.permission.CAMERA", "android.permission.INTERNET", "{package}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"];
  assert.deepEqual(unexpected(perms, allowed, pkg), ["android.permission.VIBRATE"]);
  assert.deepEqual(unexpected(parse(OUT + "uses-permission: name='android.permission.RECORD_AUDIO'\n").perms, allowed, pkg).includes("android.permission.RECORD_AUDIO"), true);
});
