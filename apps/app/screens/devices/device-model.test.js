// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceRefusal, removedToast, rowLine, split, spaceTitle } from "./device-model.js";

const ROWS = [{ space: "s1", displayName: "Harlow Legal", enrolled: true, lent: true }, { space: "s2", label: "northwind", enrolled: false }, { space: "s3", name: "old", enrolled: true, removed: true }];

test("spaces split into those the device reaches and those it does not, and each says so", () => {
  const { inIt, notIn } = split(ROWS);
  assert.deepEqual(inIt.map((r) => r.space), ["s1"]);
  assert.deepEqual(notIn.map((r) => r.space), ["s2", "s3"]);
  assert.equal(rowLine(ROWS[0], "Mac"), "Reaches Harlow Legal on its own. Shared with Harlow Legal.");
  assert.equal(rowLine(ROWS[1], "Mac"), "Not enrolled");
  assert.match(rowLine(ROWS[2], "Mac"), /^Removed/);
  assert.equal(spaceTitle(ROWS[1]), "northwind");
  assert.equal(removedToast("Mac", "Harlow"), "Mac no longer reaches Harlow. Its other spaces are untouched.");
});
test("refusals get plain words", () => {
  assert.match(deviceRefusal("presence_required", ""), /Approve on this device/);
  assert.match(deviceRefusal("device_removed", ""), /already removed/);
  assert.equal(deviceRefusal("x", "box words"), "box words");
});
