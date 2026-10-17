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
  "onboard.github.finish",
  "onboard.github.start",
  "onboard.join.read",
  "onboard.machine",
  "onboard.member.link",
  "onboard.person.lookup",
  "onboard.space.join",
  "onboard.space.open",
  "onboard.space.poll",
  "onboard.status",
  "onboard.windows",
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
  "wink.access",
  "wink.pair.server",
  "wink.pair.status",
  "wink.pair.targets",
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

test("an agent cannot answer a pairing question: the pick is the person's own", async (t) => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const offered = new Set(d.registry.listTools("mcp").filter((x) => offeredTool(x)).map((x) => x.name));
  for (const name of ["wink.server.pair.answer"]) {
    assert.equal(MCP_ALLOW.includes(name), false, `${name} is not on the MCP list`);
    assert.equal(offered.has(name), false, `${name} is not offered to a model`);
    for (const caller of ["mcp", "harness", "mcp:agent:kit"]) {
      const r = /** @type {any} */ (await d.registry.call(name, { yes: true, pick: 1 }, caller));
      assert.ok(r.error, `${caller} ${name}`);
      assert.notEqual(r.error.code, "held_for_approval", `${caller} ${name} is refused, not held for a tap on a card that names no device`);
    }
  }
});
