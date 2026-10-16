// @ts-check
// The onboarding, device and invite tools an MCP caller may reach are a declared list.
// This file keeps its own copy. It does not ask the scanner, and it does not build the
// expectation by calling the function the hold uses.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { MCP_ALLOW } from "../lib/mcp-allow.js";
import { offeredTool } from "../harness/mcp/offered.js";

/** Independent of lib/mcp-allow.js. A change to one and not the other fails. */
const EXPECTED = Object.freeze([
  "flows.kit.library",
  "flows.kit.library.get",
  "flows.kit.propose",
  "onboard.computer.add",
  "onboard.github.finish",
  "onboard.github.start",
  "onboard.join.read",
  "onboard.machine",
  "onboard.member.link",
  "onboard.person.create",
  "onboard.person.lookup",
  "onboard.phone.add",
  "onboard.space.join",
  "onboard.space.open",
  "onboard.space.poll",
  "onboard.status",
  "onboard.windows",
  "pluginagent.decline",
  "pluginagent.grant",
  "pluginagent.on",
  "pluginagent.pending",
  "pluginagent.revoke",
  "pluginagent.status",
  "presence.person.locked",
  "presence.person.renew-allow",
  "records.kits.get",
  "records.kits.library",
  "relay.devices.list",
  "relay.devices.remove",
  "releases.info",
  "sessions.accounts.key",
  "spaces.create",
  "spaces.devices.lend",
  "spaces.devices.list",
  "spaces.devices.remove",
  "spaces.identity.status",
  "spaces.invites.accept",
  "spaces.invites.confirm",
  "spaces.invites.create",
  "spaces.invites.list",
  "spaces.invites.preview",
  "spaces.invites.revoke",
  "spaces.list",
  "spaces.members.computers",
  "spaces.resume",
  "spaces.setup.claim",
  "spaces.setup.save",
  "vault.vaults.create",
  "wink.access",
  "wink.code.ack",
  "wink.pair.server",
  "wink.pair.status",
  "wink.pair.targets",
  "wink.phone.open",
  "wink.phone.pair.answer",
  "wink.phone.pairing",
]);

test("the declared MCP list matches the coverage list, and neither offers a vault value", () => {
  assert.deepEqual([...MCP_ALLOW], [...EXPECTED]);
  for (const banned of ["vault.state", "vault.reveal", "vault.account.export-secret-key", "vault.account.import-secret-key", "vault.request"]) {
    assert.equal(EXPECTED.includes(banned), false, banned);
  }
});

test("every declared onboarding, device and invite tool is offered through MCP", async (t) => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const offered = new Set(d.registry.listTools("mcp").filter((x) => offeredTool(x)).map((x) => x.name));
  const missing = [];
  for (const name of EXPECTED) {
    if (!d.registry.tools.has(name)) continue;
    if (!offered.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], `not offered via MCP: ${missing.join(", ")}`);
});
