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

test("a delivery starts the Flow in the route's own Space and no other", async () => {
  const { startFlows } = await import("./flow-body.js");
  const calls = [];
  const space = id => ({ flows: { handleWeb: async (path, o) => { calls.push([id, path, o.body, o.trust, o.key]); } } });
  const host = { spaces: () => ["spc_a", "spc_b"], get: s => ({ spc_a: space("A"), spc_b: space("B") })[s] ?? null };
  const lines = [];
  await startFlows(host, "orders", { space: "spc_a" }, "d1", '{"amount":80}', l => lines.push(l));
  assert.deepEqual(calls, [["A", "hook-orders", { amount: 80 }, "untrusted", "d1"]], "only Space A's Flow was called, untrusted, with the delivery id as its key");
  assert.deepEqual(lines, []);
});

test("a route with no recorded Space starts nothing and says so once; a Flow that cannot start is logged, not thrown", async () => {
  const { startFlows } = await import("./flow-body.js");
  const calls = [], lines = [], told = new Set();
  const host = { spaces: () => ["spc_a"], get: () => ({ flows: { handleWeb: async () => { calls.push(1); } } }) };
  await startFlows(host, "orders", {}, "d1", "{}", l => lines.push(l), told);
  await startFlows(host, "orders", { space: null }, "d2", "{}", l => lines.push(l), told);
  await startFlows(host, "orders", null, "d3", "{}", l => lines.push(l), told);
  assert.deepEqual(calls, [], "nothing started");
  assert.equal(lines.length, 1, "told once");
  assert.match(lines[0], /no Space is recorded/);
  const bad = { get: () => ({ flows: { handleWeb: async () => { throw Object.assign(new Error("boom"), { code: "busy" }); } } }) };
  const l2 = [];
  await startFlows(bad, "orders", { space: "spc_a" }, "d4", "{}", l => l2.push(l));
  assert.match(l2[0], /could not start on d4 \(boom\)/);
  const nf = { get: () => ({ flows: { handleWeb: async () => { throw Object.assign(new Error("no Flow"), { code: "not_found" }); } } }) };
  const l3 = [];
  await startFlows(nf, "orders", { space: "spc_a" }, "d5", "{}", l => l3.push(l));
  assert.deepEqual(l3, [], "no Flow at that path is silent");
});
