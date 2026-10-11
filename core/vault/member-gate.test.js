// @ts-check
// The owner gate on the vault's tools, with a stubbed kernel: it fails closed. A chain that cannot be read is refused; a chain with a person who is not the owner anywhere in it is refused, in either order;
// only a module's call and an outside agent's pass call pass without a person.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateTools, MEMBER_ALLOWED, MEMBER_REFUSAL, GATED } from "./member-gate.js";

const OWNER = "per_" + "o".repeat(26), BOB = "per_" + "b".repeat(26);
const hop = (/** @type {string} */ kind, /** @type {string} */ id) => ({ actor: { kind, id } });

/** A ctx whose kernel answers `chain(meta)` with `answer` (a function). Returns the gated tool's runner. */
function rig(/** @type {any} */ kernel) {
  const reg = /** @type {Map<string, any>} */ (new Map());
  const ctx = gateTools({ kernel, tool: (/** @type {string} */ n, /** @type {any} */ d) => reg.set(n, d) });
  ctx.tool("vault.test", { run: async () => "ran" });
  ctx.tool("vault.member.put", { run: async () => "ran" });
  const call = async (/** @type {string} */ name, /** @type {any} */ meta) => { try { return { data: await reg.get(name).run({}, meta) }; } catch (e) { return { error: e }; } };
  return { call, reg };
}
const kernelOf = (/** @type {(meta: any) => any} */ chain) => ({ owner: OWNER, chain: async (/** @type {any} */ m) => chain(m) });

test("a call for the owner passes; a member, a member's assistant or agent, and any chain with a non-owner person are refused", async () => {
  const r = rig(kernelOf(m => ({ hops: m.hops })));
  const ok = async (/** @type {any[]} */ hops) => (await r.call("vault.test", { caller: "cli", token: "t", hops })).data === "ran";
  assert.equal(await ok([hop("person", OWNER)]), true, "the owner");
  assert.equal(await ok([hop("person", OWNER), hop("agent", "assistant")]), true, "the owner's assistant");
  assert.equal(await ok([hop("person", BOB)]), false, "a member");
  assert.equal(await ok([hop("person", BOB), hop("agent", "assistant")]), false, "a member's assistant");
  assert.equal(await ok([hop("person", BOB), hop("agent", "kit")]), false, "a member's named agent");
  assert.equal(await ok([hop("person", OWNER), hop("person", BOB)]), false, "an owner-started chain that passes through a member");
  assert.equal(await ok([hop("person", BOB), hop("person", OWNER)]), false, "a member-started chain that passes through the owner");
  const e = (await r.call("vault.test", { caller: "cli", token: "t", hops: [hop("person", BOB)] })).error;
  assert.equal(e.code, "denied");
  assert.equal(e.message, MEMBER_REFUSAL);
});

test("fails closed for a call that claims a person: an unreadable chain, or facts that did not hold, is refused; a call that claims none is not made for anyone and is unchanged", async () => {
  const thrower = rig(kernelOf(() => { throw new Error("no chain"); }));
  assert.equal((await thrower.call("vault.test", { caller: "cli", token: "t" })).error.code, "denied", "a token whose chain throws is refused");
  assert.equal((await thrower.call("vault.test", { caller: "mcp:agent:kit", kernelFacts: { kind: "agent_session" } })).error.code, "denied", "connection facts whose chain throws are refused");
  const service = rig(kernelOf(() => ({ hops: [hop("service", "vault")] })));
  assert.equal((await service.call("vault.test", { caller: "local", kernelFacts: { kind: "device" } })).error.code, "denied", "facts that did not hold give a service chain with no person: refused");
  assert.equal((await service.call("vault.test", { caller: "cli", token: "gone" })).error.code, "denied", "a token that maps to no person is refused");
  assert.equal((await service.call("vault.test", { caller: "cli", firstParty: true })).data, "ran", "a call that claims no person (the owner's terminal, the daemon) is unchanged");
  assert.equal((await thrower.call("vault.test", { caller: "mcp", firstParty: true, peerSession: "x" })).data, "ran", "so is an owner's local session on the socket");
  assert.equal((await thrower.call("vault.test", { caller: "module:sessions", token: "t" })).data, "ran", "a module's call has no person behind it and passes");
  assert.equal((await thrower.call("vault.test", { caller: "ext:abc" })).data, "ran", "an outside agent's pass call passes");
  const noOwner = rig({ chain: async () => ({ hops: [hop("person", OWNER)] }) });
  assert.equal((await noOwner.call("vault.test", { caller: "cli", token: "t" })).error.code, "denied", "with no owner identity to compare, a claimed person does not pass");
  assert.equal((await rig(null).call("vault.test", { caller: "cli", token: "t" })).data, "ran", "a home with no kernel has no members to keep out");
});

test("the allow-list is by exact name: a name on it passes a member, every other name does not", async () => {
  const r = rig(kernelOf(() => ({ hops: [hop("person", BOB)] })));
  assert.equal((await r.call("vault.member.put", { caller: "cli", token: "t" })).error.code, "denied", "not on the list");
  MEMBER_ALLOWED.add("vault.member.put");
  try { assert.equal((await r.call("vault.member.put", { caller: "cli", token: "t" })).data, "ran"); assert.equal((await r.call("vault.test", { caller: "cli", token: "t" })).error.code, "denied", "and a sibling still is not"); }
  finally { MEMBER_ALLOWED.delete("vault.member.put"); }
  assert.ok(GATED.has("vault.test") && GATED.has("vault.member.put"));
});
