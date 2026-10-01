// @ts-check
// Reach on the vault's own tools (and the connector, Gate and Google tools swept with them): the tools that
// lock the vault, end access, close an emergency request or open a mailbox row are the person's own, so a
// model, a harness agent (plain or named, with any claim spelling) and a first-party module are refused
// before the tool runs, and the person's own surface is not refused. It boots a registry in a temp home.
// Positive control: the same tool called as "local" gets past the door (it fails later on its input, or runs),
// so a refusal is the reach and not a missing tool. Only the door is tested here; each tool's own behaviour
// has its own tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";

/** Reach "person" in the manifests: reviewer-2's six first, then the rest of the sweep. */
const PERSON = [
  "vault.emergency.remove", "vault.lock", "vault.account.lock", "vault.pass.revoke", "vault.ssh.forget", "vault.agent.revoke",
  "vault.emergency.deny", "vault.offboard", "vault.person.add", "vault.device.sync", "vault.vaults.sync", "google.open",
  "vault.delete", "vault.approve", "vault.revert", "vault.rotate", "vault.device.revoke", "vault.emergency.add", "vault.emergency.request",
  "vault.connections.grant", "gate.said.add", "connectors.disconnect",
];

const PROBE = `export default { async start(ctx) {
  ctx.tool("probe.try", { input: { type: "object", properties: { tool: { type: "string" } } },
    run: async ({ tool }) => { const r = await ctx.call(tool, {}); return { code: r.error && r.error.code }; } });
  return { async stop() {} };
} };`;

test("person-reach vault tools refuse a model, an agent and a module at the door, and admit the person's surface", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.try"] } }, PROBE);
  const d = await start({ presence: present, root, firstPartyRoots: [path.join(root, "modules")], log: () => {} });
  t.after(() => d.stop());
  const door = (tool, caller, meta = {}) => d.registry.call(tool, {}, caller, meta);
  let checked = 0;
  for (const tool of PERSON) {
    assert.ok(d.registry.tools.has(tool), `${tool} is registered`);
    assert.equal(d.registry.tools.get(tool).reach, "person", `${tool} declares reach person`);
    for (const caller of ["mcp", "harness", "mcp:agent:kit", "harness:agent:kit", "module:probe", "hook"]) {
      const r = await door(tool, caller, caller.includes("agent") ? { agent: "kit" } : { thread: "t-1" });
      assert.ok(r.error && ["denied", "no_such_tool"].includes(r.error.code), `${tool} as ${caller}: ${JSON.stringify(r)}`);
    }
    // The module's own call through ctx.call (a first-party module reaches the registry as module:probe).
    const probed = await d.registry.call("probe.try", { tool }, "local");
    assert.ok(probed.data && ["denied", "no_such_tool"].includes(probed.data.code), `${tool} through a module: ${JSON.stringify(probed)}`);
    // Positive control: the person's own surface is past the door.
    const person = await door(tool, "local", {});
    assert.ok(!person.error || !["denied", "no_such_tool"].includes(person.error.code), `${tool} as local was refused at the door: ${JSON.stringify(person)}`);
    checked++;
  }
  assert.equal(checked, PERSON.length);
});

test("an added module that lists vault, Gate, Google, mail and MCP tools in needs.tools is still refused them (not_declared), and reaches the Gate's own door", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const TOOLS = ["vault.list", "vault.put", "vault.request", "vault.totp", "gate.approve", "gate.held", "google.mail.send", "google.mail.read", "mail.send", "mcp.call", "mcp.add", "connectors.list"];
  writeModule(path.join(root, "modules"), "bakery", { vyre: "1", description: "A bakery's orders.", does: { tools: [{ name: "bakery.try", reach: "anyone" }] },
    needs: { tools: [...TOOLS, "gate.request"] } }, `export default { async start(ctx) {
    ctx.tool("bakery.try", { input: { type: "object", properties: { tool: { type: "string" } } },
      run: async ({ tool }) => { const r = await ctx.call(tool, {}); return { code: r.error && r.error.code }; } });
    return { async stop() {} };
  } };`);
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  assert.equal(d.registry.status().find(m => m.name === "bakery")?.state, "running");
  for (const tool of TOOLS) {
    const r = await d.registry.call("bakery.try", { tool }, "local");
    assert.equal(r.data && r.data.code, "not_declared", `${tool}: ${JSON.stringify(r)}`);
  }
  // Positive control: the one door an added module is meant to have, and a first-party module reaching a tool the same way.
  const gate = await d.registry.call("bakery.try", { tool: "gate.request" }, "local");
  assert.notEqual(gate.data && gate.data.code, "not_declared", JSON.stringify(gate));
});
