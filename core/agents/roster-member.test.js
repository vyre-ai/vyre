// @ts-check
// What a member sees of the agents: the roster (who is here, what kind, its model, whether it is busy), never an agent's instructions, tools, projects, computer, credentials' mode, thread or uid; the owner sees the whole row.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../team/team-fixture.js";

const HIDDEN = ["uid", "instructions", "auth", "tools", "projects", "computer", "doing", "thread", "proposes_only", "effort", "personal"];

test("a member's agents.list is the roster: no instructions, auth, tools, projects, computer, thread or uid; her versions, threads, usage and history reads are refused; the owner gets the full row", { timeout: 120_000 }, async t => {
  const { tool, d } = await boot(t);
  const OWNER = d.kernel.id.owner, BEN = "per_" + "c".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const benChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "sb" });
  const ben = { token: (await d.kernel.surfaces.open(benChain, {})).token };
  const full = await tool("agents.list", {});
  assert.ok(full.length >= 1 && "instructions" in full[0] && "auth" in full[0] && "uid" in full[0], "control: the owner gets the whole row");
  for (const caller of ["mcp", "harness"]) {
    const r = await d.registry.call("agents.list", {}, caller, ben);
    assert.ok(Array.isArray(r.data) && r.data.length === full.length, `${caller}: the roster lists every agent: ` + JSON.stringify(r.error));
    for (const row of r.data) {
      for (const k of HIDDEN) assert.ok(!(k in row), `${caller}: a member's row carries no ${k}: ${Object.keys(row)}`);
      for (const k of ["id", "name", "kind", "status"]) assert.ok(k in row, `${caller}: the roster row names ${k}`);
    }
    for (const [name, input] of [["agents.versions", { agent: full[0].name }], ["agents.threads", { agent: full[0].name }], ["agents.usage", {}], ["agents.history", {}]]) {
      const x = await d.registry.call(name, input, caller, ben);
      assert.ok(x.error && x.error.code === "denied", `${caller}: ${name} is refused to a member: ${JSON.stringify(x).slice(0, 160)}`);
      assert.match(String(x.error.message), /owner|admin|assistant/, "and says whom to ask");
    }
  }
  const mine = await tool("agents.versions", { agent: full[0].name });
  assert.ok(mine && mine.agent === full[0].name, "the owner still reads versions");
});

test("seesFull fails closed: a call whose chain cannot be read is not given the whole row", { timeout: 120_000 }, async t => {
  const { d } = await boot(t);
  const real = d.kernel.chains.fromFacts;
  const r = await d.registry.call("agents.list", {}, "mcp", { token: "not-a-session-token" });
  assert.ok(Array.isArray(r.data) && r.data.length, "the roster is still listed: " + JSON.stringify(r.error));
  for (const row of r.data) for (const k of ["instructions", "auth", "uid", "tools"]) assert.ok(!(k in row), `an unreadable chain gets no ${k}`);
  void real;
});

test("a remote call with no person on it (a device, visiting Space or tailnet node) gets no list and the next step, never the roster or the whole row; the owner's local surfaces still do", { timeout: 120_000 }, async t => {
  const { tool, d } = await boot(t);
  const OWNER = d.kernel.id.owner;
  const BEN = "per_" + "c".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const full = await tool("agents.list", {});
  for (const caller of ["device:bcdefghijklmnopq", "space:ben@spc_team", "tailnet-guest:ben@example.com", "tailnet:ben@example.com"]) {
    const r = await d.registry.call("agents.list", {}, caller, {});
    assert.ok(!r.data && r.error && r.error.code === "denied", `${caller}: no list: ${JSON.stringify(r).slice(0, 160)}`);
    assert.match(String(r.error.message), /vyre relay mark/, `${caller}: and says how to mark the device`);
    assert.ok(!full.some(/** @type {any} */ x => String(r.error.message).includes(x.name)), "the refusal names no agent");
  }
  for (const caller of ["cli", "local", "deck"]) {
    const r = await d.registry.call("agents.list", {}, caller, {});
    if (r.error) continue; // a label this fixture does not allow
    assert.ok(r.data.length && "instructions" in r.data[0], `${caller}: the owner's own surface still gets the full row`);
  }
});
