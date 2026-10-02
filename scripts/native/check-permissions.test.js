// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAndroid, checkAndroid, checkIos } from "./check-permissions.mjs";

const policy = { android: { allowed: ["android.permission.INTERNET", "{package}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"] }, ios: { allowedKeys: [] } };
const dump = (...p) => `package: sh.vyre.app\n${p.map(n => `uses-permission: name='${n}'`).join("\n")}\npermission: sh.vyre.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION\n`;

test("android: the listed permissions pass, and a declared (not used) permission is not counted", () => {
  const got = parseAndroid(dump("android.permission.INTERNET", "sh.vyre.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"));
  assert.equal(got.pkg, "sh.vyre.app");
  assert.deepEqual(checkAndroid(got, policy), []);
});

test("android: the microphone, camera, location, contacts, photos and storage fail by name", () => {
  const perms = ["RECORD_AUDIO", "CAMERA", "ACCESS_FINE_LOCATION", "READ_CONTACTS", "READ_MEDIA_IMAGES", "READ_EXTERNAL_STORAGE"].map(n => "android.permission." + n);
  const problems = checkAndroid(parseAndroid(dump(...perms)), policy);
  assert.equal(problems.length, 6);
  for (const w of ["microphone", "camera", "location", "contacts", "photos and media", "storage"]) assert.ok(problems.some(p => p.includes(`(${w})`)), w);
});

test("android: any unlisted permission fails too, and a listed sensitive one passes", () => {
  assert.equal(checkAndroid(parseAndroid(dump("android.permission.WAKE_LOCK")), policy).length, 1);
  const mic = { android: { allowed: ["android.permission.RECORD_AUDIO"] } };
  assert.deepEqual(checkAndroid(parseAndroid(dump("android.permission.RECORD_AUDIO")), mic), []);
});

test("android: an empty dump is a failure, not a pass", () => {
  assert.ok(checkAndroid(parseAndroid(""), policy).length > 0);
});

test("ios: sensitive usage keys fail unless listed; other keys are ignored", () => {
  const pl = { CFBundleName: "Vyre", NSFaceIDUsageDescription: "x", NSMicrophoneUsageDescription: "m", NSLocationWhenInUseUsageDescription: "l", NSPhotoLibraryAddUsageDescription: "p" };
  const problems = checkIos([pl], policy);
  assert.deepEqual(problems.map(p => p.split(" ")[0]).sort(), ["NSLocationWhenInUseUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryAddUsageDescription"]);
  assert.deepEqual(checkIos([pl], { ios: { allowedKeys: ["NSMicrophoneUsageDescription", "NSLocationWhenInUseUsageDescription", "NSPhotoLibraryAddUsageDescription"] } }), []);
});
