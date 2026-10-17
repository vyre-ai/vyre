// An item the Gate recorded under the owner's placeholder id (before the owner adopted its claimed identity) is still the owner's item after the adoption, not a member's.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isMemberItem, mayHandle } from "./requester.js";

const OLD = "per_3psmlnhua4uauy6wj7xlph5hrg", NEW = "per_oxo576iuzl5ryivfmfpaolhf4x", MEMBER = "per_member00000000000000000";
const K = { owner: NEW, canonicalPerson: (/** @type {string} */ id) => (id === OLD ? NEW : id), roleOf: (/** @type {string} */ p) => (p === NEW ? "owner" : p === MEMBER ? "member" : null) };

test("a requester stored under the pre-adopt owner id is the owner's item after adopt, a real member's stays hers", () => {
  assert.equal(isMemberItem({ requester: OLD }, K), false, "the old owner id reads as the owner");
  assert.equal(isMemberItem({ requester: NEW }, K), false, "the new owner id is the owner");
  assert.equal(isMemberItem({ requester: MEMBER }, K), true, "a member's item is hers");
  assert.equal(isMemberItem({ requester: OLD }, { owner: NEW }), true, "a kernel with no canonicalPerson compares the ids as given, as before");
});

test("the owner answers an item asked under the pre-adopt id, and the member does not", () => {
  const row = { requester: OLD };
  assert.equal(mayHandle(row, NEW, K), true, "the owner (new id) answers it");
  assert.equal(mayHandle(row, MEMBER, K), false, "a member does not");
  assert.equal(mayHandle({ requester: MEMBER }, NEW, K), false, "the owner still does not see a member's item");
  assert.equal(mayHandle({ requester: MEMBER }, MEMBER, K), true);
});
