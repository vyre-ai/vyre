// @ts-check
// The nothing-central check as a pure function over strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { central, printable } from "./check-apk-nothing-central.mjs";

test("a clean list passes", () => {
  assert.deepEqual(central(["Lsh/vyre/app/MainActivity;", "android.permission.CAMERA", "androidx.core"]), []);
});

test("Firebase and Play services are caught, each string once", () => {
  const bad = central([
    "Lcom/google/firebase/messaging/FirebaseMessagingService;",
    "com.google.android.gms.version",
    "Lcom/google/android/gms/tasks/Task;",
    "com.google.android.gms.version",
    "com.google.android.c2dm.permission.RECEIVE",
    "ok",
  ]);
  assert.equal(bad.length, 5 - 1);
  assert.ok(bad.some((b) => b.rule === "firebase"));
});

test("printable reads strings out of bytes like `strings`", () => {
  const buf = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("com.google.firebase.X"), Buffer.from([0]), Buffer.from("ab"), Buffer.from([0])]);
  assert.deepEqual(printable(buf), ["com.google.firebase.X"]);
});

test("the photo picker's two intent names are text, anything else with gms is not", () => {
  assert.deepEqual(central(["2com.google.android.gms.provider.action.PICK_IMAGES", "5com.google.android.gms.provider.extra.PICK_IMAGES_MAX"]), []);
  assert.equal(central(["com.google.android.gms.provider.action.PICK_IMAGES.evil.Service"]).length, 1);
  assert.equal(central(["Lcom/google/android/gms/tasks/Task;"]).length, 1);
});
