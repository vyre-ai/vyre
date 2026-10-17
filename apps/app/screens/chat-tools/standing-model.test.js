import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { standingRows } from "./standing-model.js";

test("a send permission reads as who, how many a day and through what", () => {
  const [r] = standingRows({ permissions: [{ id: "g1", agent: "ads", resource: "vyre://spc/outbox/send/gmail", to: { patterns: ["*@example.com"] }, daily_cap: 20 }] });
  assert.equal(r.id, "g1");
  assert.equal(r.title, "Send by itself");
  assert.equal(r.sub, "To *@example.com · up to 20 a day · through gmail");
});

test("a payment permission names each-payment and daily limits; a long list is cut", () => {
  const [r] = standingRows({ permissions: [{ id: "g2", resource: "vyre://spc/outbox/spend", to: { patterns: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"] }, max_amount: 200, daily_amount: 500 }] });
  assert.equal(r.title, "Pay by itself");
  assert.equal(r.sub, "To a@x.com, b@x.com, c@x.com and 1 more · up to 200 each, 500 a day");
});

test("rows the box sends in a shape not understood are left out", () => {
  assert.deepEqual(standingRows({ permissions: [{ id: "x", resource: "vyre://spc/other/thing" }, { resource: "vyre://spc/outbox/send" }, null] }), []);
  assert.deepEqual(standingRows(null), []);
});
