// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowFromCalls } from "../lib/flow-from-calls.js";
import { checkFlow } from "../kernel/flows/schema.js";

const cat = { types: { client: { name: "client" }, matter: { name: "matter" } }, actions: { "email.send": { risk: "outward.send" } } };

test("R031-42: record writes become steps, a variable becomes a trigger read, a returned id becomes a step read, and what cannot be a step is said", () => {
  const r = flowFromCalls({ name: "Open a matter", variables: { client: "Dana Whitfield" }, calls: [
    { tool: "mcp__plugin_vyre_vyre__work_call", input: { tool: "clients.find", input: { where: { name: "Dana Whitfield" }, limit: 5 } } },
    { tool: "work_call", input: { tool: "matters.create", input: { data: { title: "Estate of Whitfield", client_name: "Dana Whitfield" } } }, returns: { id: "m-123" } },
    { tool: "work.call", input: { tool: "matters.update", input: { id: "m-123", patch: { stage: "Open" } } } },
    { tool: "planner_add", input: { title: "Call Dana" } },
    { tool: "email.send", input: { to: "dana@example.com" }, resource: "vyre://spc/email/outbox" },
    { tool: "work_call", input: { tool: "gadgets.create", input: { data: {} } } },
  ] }, cat);
  assert.equal(r.flow.name, "open_a_matter");
  assert.deepEqual(r.flow.trigger, { on: "manual" });
  assert.deepEqual(r.flow.steps.map((/** @type {any} */ s) => [s.id, s.kind]), [["s1", "find"], ["s2", "create"], ["s3", "update"], ["s5", "call"]]);
  assert.equal(r.flow.steps[0].where, "record.name == trigger.client");
  assert.deepEqual(r.flow.steps[1].set, { title: "Estate of Whitfield", client_name: { expr: "trigger.client" } });
  assert.deepEqual(r.flow.steps[2].record, { expr: "steps.s2.record.id" });
  assert.deepEqual(r.flow.steps[3].input, { to: "dana@example.com" });
  assert.deepEqual(r.inputs, ["client"]);
  assert.deepEqual(r.unmapped.map(u => [u.n, u.tool]), [[4, "planner.add"], [6, "gadgets.create"]]);
  assert.match(r.unmapped[1].why, /no record type for gadgets/);
  assert.deepEqual(checkFlow(r.flow).filter(p => !/call|resource|action/.test(p.message)), []);
});

test("R031-42: an action without its address is unmapped with the reason", () => {
  const r = flowFromCalls({ name: "x", calls: [{ tool: "email_send", input: {} }] }, cat);
  assert.equal(r.flow.steps.length, 0);
  assert.match(r.unmapped[0].why, /give its resource address/);
});
