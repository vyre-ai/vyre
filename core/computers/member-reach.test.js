// @ts-check
// A member's computers tools act on HER agents' computers and no one else's: she lists, reads, checks out, restarts, pauses, limits, renames, takes over and gives back only the computer of an agent she
// made. The owner (and an admin) reach every computer as before. The person is read from the verified chain, whatever label the call arrives under; a chain that cannot be read reaches nothing.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../team/team-fixture.js";

/** The tools a member may call on a computer, with the input each takes for `agent`. */
const TOOLS = agent => [
  ["computers.get", { agent }], ["computers.checkout", { agent }], ["computers.release", { agent }], ["computers.restart", { agent }], ["computers.pause", { agent }],
  ["computers.limits", { agent, cpus: 2 }], ["computers.rename", { computer: agent, name: "Taken" }], ["computers.takeover", { agent, surface: "deck:ben" }], ["computers.giveback", { agent, surface: "deck:ben" }],
  ["computers.stop", { agent }], ["computers.resume", { agent }], ["computers.watch", { agent, surface: "deck:ben" }],
];

test("a member reaches only the computers of agents she made; the owner reaches all; an unreadable chain reaches none", { timeout: 120_000 }, async t => {
  const { tool, d } = await boot(t);
  const OWNER = d.kernel.id.owner, BEN = "per_" + "c".repeat(26);
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(oc, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const bc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "sb" });
  const ben = { token: (await d.kernel.surfaces.open(bc, {})).token };
  await tool("agents.create", { name: "ownerbot", instructions: "OWNER-BRIEF", projects: [], computer: true });
  const mine = await d.registry.call("agents.create", { name: "bens-bot", instructions: "BEN-BRIEF", projects: [], computer: true }, "deck", ben);
  assert.ok(mine.data, "control: a member makes her own agent: " + JSON.stringify(mine.error));

  const names = r => (r.data.computers || []).map((/** @type {any} */ c) => c.agent).sort();
  const all = await tool("computers.list", {});
  assert.ok(all.computers.length >= 2, "control: the owner lists every computer: " + JSON.stringify(all.computers.map((/** @type {any} */ c) => c.agent)));
  const ownerSees = all.computers.map((/** @type {any} */ c) => c.agent);
  assert.ok(ownerSees.includes("ownerbot") && ownerSees.includes("bens-bot"), "the owner sees her own and the member's");

  for (const caller of ["deck", "cli", "mcp", "harness"]) {
    const l = await d.registry.call("computers.list", {}, caller, ben);
    assert.ok(l.data, `${caller}: a member lists computers: ${JSON.stringify(l.error)}`);
    assert.deepEqual(names(l), ["bens-bot"], `${caller}: a member lists only the computer of the agent she made`);
    for (const [name, input] of TOOLS("ownerbot")) {
      const r = await d.registry.call(name, input, caller, ben);
      assert.ok(r.error, `${caller}: ${name} on the owner's agent is refused to a member: ${JSON.stringify(r.data)}`);
      if (r.error.code === "denied" || /did not make/.test(String(r.error.message))) continue;   // refused by the reach rule, or earlier by the tool's own caller rule
      assert.fail(`${caller}: ${name} on the owner's agent was not refused by the reach rule: ${JSON.stringify(r.error)}`);
    }
  }
  // the reach rule's words say what to do next
  const refused = await d.registry.call("computers.get", { agent: "ownerbot" }, "deck", ben);
  assert.equal(refused.error.code, "denied");
  assert.match(String(refused.error.message), /did not make.*(owner|admin|computers\.list)/);

  // her own agent's computer: the reach rule lets her through (the tool may still answer something else, never "did not make")
  for (const [name, input] of TOOLS("bens-bot")) {
    const r = await d.registry.call(name, input, "deck", ben);
    assert.ok(!(r.error && /did not make/.test(String(r.error.message))), `${name} on her own agent is not refused by the reach rule: ${JSON.stringify(r.error)}`);
  }
  assert.ok((await d.registry.call("computers.get", { agent: "bens-bot" }, "deck", ben)).data, "she reads her own computer");

  // the owner's computer label is untouched, the owner still renames and reads it
  const labels = (await tool("computers.list", {})).computers.find((/** @type {any} */ c) => c.agent === "ownerbot");
  assert.ok(labels && labels.label !== "Taken", "a member's rename did not reach the owner's computer");
  assert.ok(await tool("computers.rename", { computer: "ownerbot", name: "Mine" }), "the owner renames any computer");
  assert.ok(await tool("computers.get", { agent: "ownerbot" }), "the owner reads any computer");

  // a token that does not verify is no one: nothing is reached
  const bad = await d.registry.call("computers.list", {}, "mcp", { token: "not-a-session-token" });
  assert.deepEqual(bad.data ? names(bad) : [], [], "a chain that cannot be read lists no computer");
  const badGet = await d.registry.call("computers.get", { agent: "ownerbot" }, "mcp", { token: "not-a-session-token" });
  assert.ok(badGet.error, "and reads none");
});
