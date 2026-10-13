// The pure half of the Agents home: a row from agents.list, its groups, the one line of role from its instructions, and the shape the list header filters.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { roleLine, statusOf, agentRow, groupOf, sharingOf, AGENT_GROUPS, agentsDef, asRecords, loadGroups, saveGroups } from "./home-model.js";

const NOW = 1_760_000_000_000;

test("the role is the first line of the instructions, without markup, short", () => {
  assert.equal(roleLine("# Intake agent\n\nWelcomes new clients."), "Intake agent");
  assert.equal(roleLine("\n\n  **Drafts** welcome emails for the attorney.  \nMore."), "Drafts welcome emails for the attorney.");
  assert.equal(roleLine("x".repeat(200)).length, 90);
  assert.equal(roleLine(null, "Your agent"), "Your agent");
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
  assert.deepEqual(AGENT_GROUPS.map((g) => g[0]), ["yours", "team", "shared", "builders"]);
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

test("who made it and who it is shared with decide the group: mine, shared with me, else the team's", () => {
  assert.equal(groupOf({ kind: "agent", made_by: "me" }, "me"), "yours");
  assert.equal(groupOf({ kind: "agent", made_by: "bob", shares: [{ person: "me", level: "use" }] }, "me"), "shared");
  assert.equal(groupOf({ kind: "agent", made_by: "bob", shares: [{ person: "cy", level: "use" }] }, "me"), "team");
  assert.equal(groupOf({ kind: "agent", made_by: "bob" }, "me"), "team");
  assert.equal(groupOf({ builtin: true, made_by: "me" }, "me"), "builders");
});

test("sharing: what I may do with it, and with how many it is shared when I can see that", () => {
  assert.deepEqual(sharingOf({ shares: [{ person: "me", level: "edit" }] }, "me"), { mine: "Can edit", count: 1 });
  assert.deepEqual(sharingOf({ shares: [{ person: "me", level: "use" }, { person: "a", level: "edit" }, { person: "b", level: "use" }] }, "me"), { mine: "Can use", count: 3 });
  assert.deepEqual(sharingOf({}, "me"), { mine: "", count: 0 });
  assert.deepEqual(sharingOf({ shares: "x" }, "me"), { mine: "", count: 0 });
  assert.equal(agentRow({ name: "A", kind: "agent", shares: [{ person: "me", level: "use" }] }, "me").mine, "Can use");
});

import { visibleAgents, rowActions, chatHas, COMPUTED_TITLES } from "./home-model.js";
const ME = "per_me", OTHER = "per_other";
const R = (o) => agentRow({ name: "x", kind: "agent", thread: "t", status: "idle", ...o }, ME);

test("another person's assistant never appears, and your own is first", () => {
  const rows = [R({ name: "kit", made_by: ME }), R({ name: "theirs", kind: "assistant", made_by: OTHER }), R({ name: "juno", kind: "assistant", made_by: ME })];
  assert.deepEqual(visibleAgents(rows, ME).map((r) => r.name), ["juno", "kit"]);
});

test("the assistant's menu is Open chat and Settings: no share, delete, move or new chat", () => {
  const a = R({ name: "juno", kind: "assistant", made_by: ME });
  assert.deepEqual(rowActions(a, { me: ME, staff: true, groups: ["Mine"] }).map((x) => x.key), ["chat", "open"]);
});

test("an agent's menu: share and delete only for its maker or staff, pause only when it can pause, no move into computed groups", () => {
  const mine = R({ name: "kit", made_by: ME });
  assert.deepEqual(rowActions(mine, { me: ME, groups: ["Yours", "Shared with you", "Mine"], placed: "Yours" }).map((x) => x.key), ["open", "new-chat", "pause", "share", "delete", "move"]);
  const move = rowActions(mine, { me: ME, groups: ["Yours", "Mine"], placed: "Yours" }).find((x) => x.key === "move");
  assert.equal(move?.to, "Mine");
  const theirs = R({ name: "rev", made_by: OTHER, thread: null });
  assert.deepEqual(rowActions(theirs, { me: ME, chats: 2 }).map((x) => x.key), ["open", "new-chat", "chats"]);
  assert.ok(rowActions(theirs, { me: ME, staff: true }).some((x) => x.key === "delete"), "an owner or admin may delete any agent");
  assert.ok(!rowActions(R({ name: "engineer", builtin: true, made_by: ME }), { me: ME, staff: true }).some((x) => x.key === "delete" || x.key === "share"), "built-in agents are not shared or deleted");
  assert.ok(!rowActions(mine, { me: ME, canDelete: false }).some((x) => x.key === "delete"));
  assert.equal(rowActions(R({ status: "stopped", made_by: ME }), { me: ME }).find((x) => x.key === "pause")?.label, "Resume");
  assert.deepEqual(COMPUTED_TITLES, ["Yours", "Your team's agents", "Shared with you", "Builders"]);
});

test("a chat is with an agent when it lists it; the assistant's pinned chat is not", () => {
  assert.ok(chatHas({ agents: ["kit", "rev"] }, "kit"));
  assert.ok(!chatHas({ agents: ["kit"] }, "rev"));
  assert.ok(!chatHas({ agents: ["kit"], pinned: "assistant" }, "kit"));
});
