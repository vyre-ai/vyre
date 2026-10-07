// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { peersFor } from "./peers.js";

test("peersFor: the door the composition root set is passed on, and anything else is no door", () => {
  const door = { space: "harlow", allow: () => true, accept: () => {} };
  assert.equal(peersFor({ peerDoor: () => door }), door);
  assert.equal(peersFor({}), undefined);
  assert.equal(peersFor({ peerDoor: () => null }), undefined);
  assert.equal(peersFor({ peerDoor: () => { throw new Error("wink not started"); } }), undefined);
  assert.equal(peersFor({ peerDoor: () => ({ space: "x", allow: true, accept: () => {} }) }), undefined);
});
