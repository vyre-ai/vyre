// @ts-check
// The Space's set-up (an agent, a template, a playbook) is read by a member and written only by an owner or an admin, on every route: the gateway route her own session uses, and the agents tools by whatever label they arrive under.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../team/team-fixture.js";

test("a member reads the Space's agents, templates and playbooks and changes none of them, on the gateway route and through the agents tools; the owner does it all", { timeout: 120_000 }, async t => {
  const { tool, d } = await boot(t);
  const OWNER = d.kernel.id.owner, BEN = "per_" + "c".repeat(26);
  const R = d.kernel.gateway.records;
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(oc, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const bc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "sb" });
  const ben = { token: (await d.kernel.surfaces.open(bc, {})).token };
  await tool("agents.create", { name: "ownerbot", instructions: "OWNER-BRIEF", projects: [] });
  const tpl = await R.create(oc, "template", { name: "Welcome", kind: "email", subject: "Hi", body: "Hello" });
  const pb = await R.create(oc, "playbook", { name: "How we intake", body: "Steps" });
  const agentRow = (await R.query(oc, "agent", { page: { limit: 50 } })).rows.find((/** @type {any} */ r) => r.data.name === "ownerbot");
  assert.ok(agentRow, "control: the owner's agent is a record");
  // read: yes
  for (const [type, id] of [["template", tpl.id], ["playbook", pb.id], ["agent", agentRow.id]]) assert.ok(await R.get(bc, type, id), `a member reads a ${type}`);
  const seen = (await R.get(bc, "agent", agentRow.id)).data;
  assert.ok(!("uid" in seen) && !("tags" in seen) && "name" in seen && "kind" in seen, "a member's agent record has name, kind, owner, model, builtin and no uid or tags: " + Object.keys(seen));
  // write: no, on the gateway route
  for (const [type, id] of [["template", tpl.id], ["playbook", pb.id], ["agent", agentRow.id]]) {
    const v = (await R.get(oc, type, id)).version;
    await assert.rejects(() => R.update(bc, type, id, { name: "TAKEN" }, v), { code: "not_allowed", message: new RegExp(`^Only an owner or an admin can change this ${type}\\. Ask one of them\\.$`) }, `a member updates a ${type}`);
    await assert.rejects(() => R.remove(bc, type, id, v), { code: "not_allowed" }, `a member removes a ${type}`);
  }
  await assert.rejects(() => R.create(bc, "template", { name: "X", kind: "email", body: "x" }), { code: "not_allowed" }, "a member creates a template");
  // the tools, under every label, with the member's token
  // someone else's agent: no change under any label
  for (const caller of ["deck", "cli", "mcp", "harness"]) {
    for (const [name, input] of [["agents.update", { agent: "ownerbot", instructions: "TAKEN" }], ["agents.stop", { agent: "ownerbot" }], ["agents.resume", { agent: "ownerbot" }], ["agents.delete", { agent: "ownerbot" }]]) {
      const r = await d.registry.call(name, input, caller, ben);
      assert.ok(r.error, `${caller}: ${name} of the owner's agent is refused to a member`);
    }
  }
  // the kernel limits what an agent she makes can reach: every project, or the owner's project, is refused; no project is fine
  for (const projects of ["*", ["harlow-legal"]]) assert.ok((await d.registry.call("agents.create", { name: "ben-wide", instructions: "x", projects }, "deck", ben)).error, `a member's agent with projects ${JSON.stringify(projects)} is refused by the kernel`);
  // her own agent: she makes it, changes it and removes it (the decided rule: made, but not an actor of the Space)
  const mine = await d.registry.call("agents.create", { name: "bens-bot", instructions: "BEN-BRIEF", projects: [] }, "deck", ben);
  assert.ok(mine.data && mine.data.name === "bens-bot", "a member makes her own agent: " + JSON.stringify(mine.error));
  const upd = await d.registry.call("agents.update", { agent: "bens-bot", instructions: "BEN-NEW" }, "deck", ben);
  assert.ok(upd.data, "and changes it: " + JSON.stringify(upd.error));
  const del = await d.registry.call("agents.delete", { agent: "bens-bot" }, "deck", ben);
  assert.ok(del.data, "and removes it: " + JSON.stringify(del.error));
  const after = (await tool("agents.list", {})).find((/** @type {any} */ a) => a.name === "ownerbot");
  assert.ok(after && after.instructions === "OWNER-BRIEF", "the owner's agent is unchanged");
  assert.equal((await R.get(oc, "template", tpl.id)).data.name, "Welcome");
  // the owner: all of it
  assert.ok(await R.update(oc, "template", tpl.id, { name: "Welcome 2" }, (await R.get(oc, "template", tpl.id)).version), "the owner changes a template");
  assert.ok((await tool("agents.update", { agent: "ownerbot", instructions: "NEW" })), "the owner changes an agent");
});
