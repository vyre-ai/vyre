// The pure half of the Agents home: a row from agents.list, its groups, the one line of role from its instructions, and the shape the list header filters.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { roleLine, statusOf, agentRow, groupOf, AGENT_GROUPS, agentsDef, asRecords, loadGroups, saveGroups } from "./home-model.js";

const NOW = 1_760_000_000_000;

test("the role is the first line of the instructions, without markup, short", () => {
  assert.equal(roleLine("# Intake agent\n\nWelcomes new clients."), "Intake agent");
  assert.equal(roleLine("\n\n  **Drafts** welcome emails for the attorney.  \nMore."), "Drafts welcome emails for the attorney.");
  assert.equal(roleLine("x".repeat(200)).length, 90);
  assert.equal(roleLine(null, "Your assistant"), "Your assistant");
  assert.equal(roleLine("   ", "Agent"), "Agent");
});

test("status: paused when its thread is stopped, running when it is doing something, else idle", () => {
  assert.equal(statusOf({ status: "stopped" }), "Paused");
  assert.equal(statusOf({ status: "running", doing: "drafting" }), "Running now");
  assert.equal(statusOf({ status: "idle" }), "Idle");
  assert.equal(statusOf({}), "Idle");
});

test("a row carries what the list shows", () => {
  const r = agentRow({ name: "Intake", kind: "agent", projects: ["Doe trust"], model: "sonnet-5.5", instructions: "# Intake\nWelcomes clients.", status: "running", personal: true, thread: "t1" });
  assert.deepEqual([r.name, r.role, r.model, r.works, r.status, r.group, r.canPause], ["Intake", "Intake", "sonnet-5.5", "Works on Doe trust", "Running now", "yours", true]);
  assert.equal(agentRow({ name: "A", kind: "agent" }).model, "Default model");
  assert.equal(agentRow({ name: "A", kind: "agent" }).canPause, false);
});

test("groups: the built-in Engineer is a builder, a personal agent and the assistant are yours, the rest are the team's", () => {
  assert.equal(groupOf({ builtin: true, kind: "agent" }), "builders");
  assert.equal(groupOf({ kind: "assistant" }), "yours");
  assert.equal(groupOf({ personal: true, kind: "agent" }), "yours");
  assert.equal(groupOf({ kind: "agent" }), "team");
  assert.deepEqual(AGENT_GROUPS.map((g) => g[0]), ["yours", "team", "builders"]);
});

test("the list header filters agents as it filters records: kind, model, status", () => {
  const rows = [agentRow({ name: "A", kind: "assistant", model: "m1" }), agentRow({ name: "B", kind: "agent", model: "m2", status: "stopped" })];
  const def = agentsDef(rows);
  assert.deepEqual(def.fields.find((f) => f.name === "model").options, ["m1", "m2"]);
  assert.deepEqual(def.fields.find((f) => f.name === "status").options, ["Running now", "Idle", "Paused"]);
  const recs = asRecords(rows);
  assert.equal(recs[1].data.status, "Paused");
  assert.equal(recs[0].id, "A");
});

test("a person's own groups are kept where they put them, and a bad store reads as none", () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadGroups(store), { groups: [], placed: {} });
  saveGroups(store, { groups: [{ name: "Intake team" }], placed: { Intake: "Intake team" } });
  assert.deepEqual(loadGroups(store), { groups: [{ name: "Intake team" }], placed: { Intake: "Intake team" } });
  assert.deepEqual(loadGroups({ getItem: () => "{not json", setItem() {} }), { groups: [], placed: {} });
  assert.doesNotThrow(() => saveGroups({ getItem() { return null; }, setItem() { throw new Error("full"); } }, { groups: [], placed: {} }));
});
