// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteeMayOpen } from "./invitee-cap.js";

test("one invitation cannot fill the invitee pool, and a second invitation still gets a channel", () => {
  assert.equal(inviteeMayOpen({ pool: 0, forInvite: 0 }), true);
  assert.equal(inviteeMayOpen({ pool: 1, forInvite: 1 }), true);
  assert.equal(inviteeMayOpen({ pool: 2, forInvite: 2 }), false, "two channels is the cap for one invitation");
  assert.equal(inviteeMayOpen({ pool: 2, forInvite: 0 }), true, "the pool still has room for someone else");
  assert.equal(inviteeMayOpen({ pool: 8, forInvite: 0 }), false, "the whole pool is full");
  assert.equal(inviteeMayOpen({ pool: 7, forInvite: 0 }), true);
});
