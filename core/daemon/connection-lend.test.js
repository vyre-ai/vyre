// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lendConnections, endConnections } from "./connection-lend.js";

const rig = (/** @type {any} */ credentials) => {
  /** @type {any[]} */ const calls = [];
  const callModule = async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push({ tool, input }); if (tool === "flows.kit.credentials") return { credentials }; return {}; };
  return { calls, o: { callModule, clock: () => 1000 } };
};
const task = (/** @type {any} */ by) => ({ id: "t1", doer: { kind: "agent", id: "juno" }, assigned_by: by });

test("a task a person approved lends the named connections, naming that person as the approver", async () => {
  const { o, calls } = rig(["gmail"]);
  await lendConnections(o, task({ kind: "person", id: "alex" }));
  const lend = calls.find(c => c.tool === "vault.connections.lend");
  assert.deepEqual({ task: lend.input.task, agent: lend.input.agent, connections: lend.input.connections, approver: lend.input.approver }, { task: "t1", agent: "juno", connections: ["gmail"], approver: "alex" });
  assert.ok(lend.input.until > 1000);
});

test("a task no person approved lends nothing, and never asks the Kit", async () => {
  for (const by of [undefined, { kind: "agent", id: "kit" }, { kind: "person", id: "" }]) {
    const { o, calls } = rig(["gmail"]);
    await lendConnections(o, task(by));
    assert.deepEqual(calls, []);
  }
});

test("a Kit that names no credentials lends nothing", async () => {
  const { o, calls } = rig([]);
  await lendConnections(o, task({ kind: "person", id: "alex" }));
  assert.deepEqual(calls.map(c => c.tool), ["flows.kit.credentials"]);
});

test("ending a task ends its lend, and a task that lent nothing ends quietly", async () => {
  const { o, calls } = rig([]);
  await endConnections(o, "t1");
  assert.deepEqual(calls, [{ tool: "vault.connections.end", input: { task: "t1", reason: "the task is over" } }]);
  await endConnections({ callModule: async () => { throw new Error("none lent"); } }, "t2");
  await endConnections({}, "t3");
});
