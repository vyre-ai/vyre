// @ts-check
// "Used by" asks Flows which Flows use a Connection, as the person looking, and a missing or failing Flows module shows no Flow rows rather than an error.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { UsedBy } from "./used-by.js";

const vault = /** @type {any} */ ({ db: { prepare: () => ({ all: () => [] }) }, row: (/** @type {string} */ n) => (n === "practice" ? { name: n } : null), releases: { views: () => [] }, access: null, links: { list: async () => ({ links: [] }) } });

test("the Flows that use a Connection are rows of its list, asked for as the person, with an off Flow marked", async () => {
  /** @type {any[]} */ const calls = [];
  const ctx = { call: async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opts) => {
    calls.push([tool, input, opts]);
    return tool === "flows.connections" ? { data: { connections: [{ connection: "practice", flows: [{ id: "f1", label: "New matter", active: true }, { id: "f2", label: "Old intake", active: false }] }] } } : { data: { apps: [] } };
  } };
  const r = await new UsedBy(vault, ctx).list({ item: "practice" });
  assert.deepEqual(r.users.map(u => [u.kind, u.id, u.label]), [["flow", "f1", "the Flow New matter"], ["flow", "f2", "the Flow Old intake (off)"]]);
  assert.deepEqual(calls.find(c => c[0] === "flows.connections"), ["flows.connections", { connection: "practice" }, { relay: true }]);
  assert.equal(r.restarts, 0);
});

test("a Flows module that is missing or throws leaves no Flow rows and no error", async () => {
  for (const call of [async () => { throw new Error("no flows"); }, async () => ({ error: { code: "no_such_tool" } })]) {
    const r = await new UsedBy(vault, { call }).list({ item: "practice" });
    assert.deepEqual(r.users, []);
  }
});
