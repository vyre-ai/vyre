// @ts-check
// The owner's door for computers.update and computers.update.status, on the REAL kernel's chains (test/kernel-rig.js): the owner passes; an admin, a member and the owner's assistant (an agent session
// vouched by the owner) are refused; so are an agent, a module and an MCP caller, whose hops the kernel names by kind. A refusal happens before the updater, so nothing is stopped or removed.
// The chains are the kernel's own objects, not hand-made ones: what assertOwner reads (the hops, the first actor's kind and id) is what the kernel produces.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../test/kernel-rig.js";
import { assertOwner } from "./update.js";

test("the update door on the real kernel's chains: only the owner, in person, passes", async () => {
  const rig = await createRig({ people: { per_adm: "admin", per_mem: "member" } });
  /** @type {Record<string, any>} */
  const chains = {
    owner: rig.ownerChain,
    admin: rig.person("per_adm"),
    member: rig.person("per_mem"),
    assistant: rig.assistant(rig.owner, "juno"),
    // hops the kernel gives callers that are not a person
    agent: { hops: [{ actor: { kind: "agent", id: "ads", space: rig.space } }] },
    module: { hops: [{ actor: { kind: "module", id: "flows" } }] },
    mcp: { hops: [{ actor: { kind: "mcp", id: "client" } }] },
  };
  const kernel = { owner: rig.owner, canonicalPerson: (/** @type {string} */ x) => x, chain: async (/** @type {any} */ meta) => chains[meta.who] || null };
  /** The updater and the driver, spied: nothing may reach them from a refused call. */
  let touched = 0;
  const tool = async (/** @type {string} */ who) => { await assertOwner(kernel, { who }); touched++; };
  await tool("owner");
  assert.equal(touched, 1, "the owner is allowed");
  for (const who of ["admin", "member", "assistant", "agent", "module", "mcp", "nobody"]) {
    await assert.rejects(() => tool(who), e => /** @type {any} */ (e).code === "denied", `${who} is refused`);
  }
  assert.equal(touched, 1, "a refusal leaves the updater untouched");
});
