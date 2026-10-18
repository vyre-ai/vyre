// @ts-check
// The Kit assistants port acts only as the person the approval names: no `by`, no call, and a chain that happens to carry another person changes nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { teammatePort } from "./kit-teammates.js";

function rig(existing = /** @type {string[]} */ ([])) {
  /** @type {any[]} */ const calls = [], sessions = [];
  const callAs = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ token) => {
    calls.push({ tool, input, token });
    if (tool === "agents.list") return { data: existing.map(name => ({ name })) };
    if (tool === "agents.create") return { data: { id: "agt_1", name: input.name } };
    return { data: {} };
  };
  const port = teammatePort({ callAs, session: async id => { sessions.push(id); return `token-of-${id}`; }, log: () => {} });
  return { port, calls, sessions };
}
const BYSOMEONE = { hops: [{ actor: { kind: "person", id: "per_someone_else" } }] };

test("with no approver the port is denied and nothing is made or removed, whatever person the chain carries", async () => {
  const r = rig();
  for (const by of [undefined, null, {}, { kind: "agent", id: "x" }, { kind: "person" }, { kind: "person", id: "" }]) {
    await assert.rejects(r.port.create(BYSOMEONE, { name: "helper", instructions: "x", kit: "k", by }), (/** @type {any} */ e) => e.code === "denied");
    await assert.rejects(r.port.remove(BYSOMEONE, "helper", "agt_1", by), (/** @type {any} */ e) => e.code === "denied");
  }
  assert.deepEqual(r.calls, [], "no tool was called");
  assert.deepEqual(r.sessions, [], "and no session was opened");
});

test("with an approver it runs on that person's session only, with no projects, and tags the assistant with its Kit", async () => {
  const r = rig();
  const made = await r.port.create(BYSOMEONE, { name: "helper", instructions: "Do it.", kit: "Front Desk", by: { kind: "person", id: "per_ana" } });
  assert.deepEqual(made, { id: "agt_1" });
  assert.deepEqual(r.sessions, ["per_ana"], "the approver's, never the chain's person");
  assert.ok(r.calls.every(c => c.token === "token-of-per_ana"));
  assert.deepEqual(r.calls.map(c => c.tool), ["agents.list", "agents.create", "agents.update"]);
  assert.deepEqual(r.calls[1].input, { name: "helper", instructions: "Do it.", projects: [] });
  assert.deepEqual(r.calls[2].input, { agent: "helper", tags: ["kit-front-desk"] }, "the Kit is in the visible tags, not in the instructions");
  await r.port.remove(BYSOMEONE, "helper", "agt_1", { kind: "person", id: "per_ana" });
  assert.deepEqual(r.calls.at(-1), { tool: "agents.delete", input: { agent: "helper", id: "agt_1" }, token: "token-of-per_ana" });
});

test("an assistant of that name that is already there is left alone and not claimed", async () => {
  const r = rig(["helper"]);
  const made = await r.port.create(BYSOMEONE, { name: "helper", instructions: "Do it.", kit: "k", by: { kind: "person", id: "per_ana" } });
  assert.deepEqual(made, { id: null, existed: true });
  assert.deepEqual(r.calls.map(c => c.tool), ["agents.list"], "nothing created, nothing tagged");
});
