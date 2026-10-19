import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowBody, flowPath } from "./flow-body.js";

test("a JSON object body reaches the Flow as it is, a list or a bare value as value, and text as text", () => {
  assert.deepEqual(flowBody('{"amount":80,"email":"pat@example.com","items":[1,2]}'), { amount: 80, email: "pat@example.com", items: [1, 2] });
  assert.deepEqual(flowBody("[1,2]"), { value: [1, 2] });
  assert.deepEqual(flowBody("7"), { value: 7 });
  assert.deepEqual(flowBody("plain words"), { text: "plain words" });
  assert.deepEqual(flowBody(""), { text: "" });
});

test("a long text and a wide object are cut, not refused", () => {
  assert.equal(flowBody("x".repeat(50_000)).text.length, 20_000);
  assert.equal(flowBody(JSON.stringify({ s: "y".repeat(50_000) })).s.length, 20_000);
  const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])));
  assert.equal(Object.keys(flowBody(wide)).length, 200);
});

test("the Flow path for a route is a valid web trigger path", () => {
  assert.equal(flowPath("northwind-orders"), "hook-northwind-orders");
  assert.match(flowPath("a".repeat(40)), /^[a-z0-9][a-z0-9-]{0,63}$/);
});
