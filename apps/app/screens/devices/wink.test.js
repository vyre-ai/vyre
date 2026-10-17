import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SOFTWARE_KEY, deviceSub, lendState, list, removeText } from "./wink.js";

test("a computer is lent only when both sides say yes", () => {
  assert.equal(lendState({ spaceAllows: true, meAllows: false }), "waiting");
  assert.equal(lendState({ spaceAllows: true, meAllows: true }), "sharing");
  assert.equal(lendState({ spaceAllows: false, meAllows: true }), "waiting");
});

test("lists read like a sentence", () => {
  assert.equal(list(["Mine"]), "Mine");
  assert.equal(list(["Mine", "Juniper Studio"]), "Mine and Juniper Studio");
  assert.equal(list(["A", "B", "C"]), "A, B and C");
});

test("removal says what happens first", () => {
  assert.match(removeText("Device", "Alex's Mac"), /stops it opening anything of yours/);
  assert.match(removeText("Person", "Dana Reyes"), /Dana loses its projects and servers at once/);
});

test("a device row says its key is in software only when it is", () => {
  assert.deepEqual(deviceSub("Phone", "Now", false), ["Phone, last used Now"]);
  assert.deepEqual(deviceSub("Phone", "Now", undefined), ["Phone, last used Now"]);
  assert.deepEqual(deviceSub("Server", "Now", true), ["Server, last used Now", "This device keeps its key in software"]);
  assert.equal(SOFTWARE_KEY, "This device keeps its key in software");
});
