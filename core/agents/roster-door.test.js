// @ts-check
// A team member's roster over the member door (core/work/member-tools.js "agents.roster" -> agents.serve): the Space's agents with id, name, kind, role, model and status, never an agent's instructions, tools, projects, computer
// or sign-in; a person who is not a member gets nothing. On a REAL vyred with the kernel on. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CALLS } from "../../kernel/remote/wire.js";
import { createMemberTools, MEMBER_TOOLS } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("agents.roster is a row of the member door's table and a call of the Space kernel's remote group", () => {
  assert.deepEqual([...CALLS.agents], ["roster"]);
  assert.ok(MEMBER_TOOLS["agents.roster"]);
});

test("a member's roster has the Space's agents by name and status and none of their instructions, tools or sign-in; a non-member gets nothing", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(oc, { person: ANA, role: "member" }, { presence: proof() });
  const tok = async () => ({ token: (await d.kernel.surfaces.open(oc, {})).token });
  const made = await d.registry.call("agents.create", { name: "research", kind: "agent", instructions: "SECRET-INSTRUCTIONS-TEXT", projects: [] }, "cli", await tok());
  assert.ok(!made.error, JSON.stringify(made.error));
  const tools = createMemberTools({ space, kernel: d.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "relay" });
  const roster = await tools.agents.roster(chainOf(ANA), {});
  assert.ok(Array.isArray(roster) && roster.some((/** @type {any} */ a) => a.name === "research"), JSON.stringify(roster).slice(0, 300));
  const json = JSON.stringify(roster);
  assert.ok(!json.includes("SECRET-INSTRUCTIONS-TEXT") && !/instructions|"auth"|"tools"|"projects"|"computer"|"uid"/.test(json), `a member's roster carries no instructions, tools, projects, computer, sign-in or uid: ${json.slice(0, 300)}`);
  for (const a of roster) assert.deepEqual(Object.keys(a).filter(k => !["id", "name", "kind", "role", "model", "status"].includes(k)), [], `${a.name}: only the roster's fields`);
  await assert.rejects(tools.agents.roster(chainOf(ZED), {}), /not found/i, "a person who is not a member gets nothing");
  // the owner's own session still gets the full row
  const full = await d.registry.call("agents.list", {}, "cli", await tok());
  assert.ok(JSON.stringify(full.data).includes("SECRET-INSTRUCTIONS-TEXT"), "the owner's agents.list is unchanged");
});
