// The owner check at the end of a server pairing (relay/client/finish.js): success is only for the identity that is pairing, on the path that answers at once and the path that answers after the words.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerIs } from "../relay/client/finish.js";

test("the server's owner answer counts only when it names the identity that is pairing", () => {
  assert.equal(ownerIs({ owner: { kind: "identity", id: "per_aaa" } }, "per_aaa"), true);
  assert.equal(ownerIs({ owner: { kind: "identity", id: "per_bbb" } }, "per_aaa"), false);
  assert.equal(ownerIs({ owner: { kind: "identity" } }, "per_aaa"), false);
  assert.equal(ownerIs({ owner: true }, "per_aaa"), false);
  assert.equal(ownerIs({}, "per_aaa"), false);
  assert.equal(ownerIs(undefined, "per_aaa"), false);
});
