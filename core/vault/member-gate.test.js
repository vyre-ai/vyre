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
  for (const c of ["cli", "local", "capsule", "mcp", "harness"]) assert.equal((await service.call("vault.test", { caller: c, firstParty: true })).data, "ran", `${c} on the owner's own socket, claiming no one`);
  // a label that names a listener or a thread/agent binding is not the owner's socket: with no claim it is refused
  for (const c of ["deck", "mobile", "mcp:thread:t1", "mcp:agent:kit", "harness:thread:t1", "harness:agent:kit", "cli:agent:kit"]) assert.equal((await service.call("vault.test", { caller: c, firstParty: true })).error?.code, "denied", `${c} claiming no one`);
  // a REMOTE caller that claims no one is refused whatever session it shows: a People session proves a device signed in, not whose it is
  for (const c of ["device:abcdef", "web:aaaaaaaaaaaaaaaa", "setup:aaaaaaaaaaaaaaaa", "tailnet", "tailnet-guest:x", "space:bob@spc_x"]) {
    assert.equal((await service.call("vault.test", { caller: c })).error?.code, "denied", `${c} with no token, facts or session`);
    assert.equal((await service.call("vault.test", { caller: c, person: { id: "ps_1", kind: "cookie" } })).error?.code, "denied", `${c} with a People session alone: a member's device holds one too`);
  }
  // the owner's paired device arrives with the facts the daemon computes from its device row; they prove the owner and pass, and a People session beside them changes nothing
  const ownerDevice = rig(kernelOf(() => ({ hops: [hop("person", OWNER)] })));
  assert.equal((await ownerDevice.call("vault.test", { caller: "device:abcdef", person: { id: "ps_1", kind: "cookie" }, kernelFacts: { kind: "device", person: OWNER } })).data, "ran", "a device whose facts name the owner passes");
  // facts or a token decide, a People session does not override them: a member's device with facts that prove a member is refused
  const memberFacts = rig(kernelOf(() => ({ hops: [hop("person", BOB)] })));
  assert.equal((await memberFacts.call("vault.test", { caller: "device:abcdef", person: { id: "ps_1", kind: "cookie" }, kernelFacts: { kind: "device" } })).error?.code, "denied", "a device whose facts name a member is refused whatever session it shows");
  assert.equal((await memberFacts.call("vault.test", { caller: "cli", person: { id: BOB, kind: "cli" }, token: "t" })).error?.code, "denied", "a member's token is refused on any label");
  assert.equal((await thrower.call("vault.test", { caller: "mcp", firstParty: true, peerSession: "x" })).data, "ran", "so is an owner's local session on the socket");
  assert.equal((await thrower.call("vault.test", { caller: "module:sessions" })).data, "ran", "a module's call with no claim (its own work) passes");
  assert.equal((await thrower.call("vault.test", { caller: "module:sessions", token: "t" })).error?.code, "denied", "a module hop that inherited a token whose chain cannot be read is refused");
  const asMember = rig(kernelOf(() => ({ hops: [hop("person", BOB)] })));
  assert.equal((await asMember.call("vault.test", { caller: "module:connectors", token: "member's" })).error?.code, "denied", "a module's call made for a member (it inherited the member's token) is refused like the member's own");
  const asOwner = rig(kernelOf(() => ({ hops: [hop("person", OWNER)] })));
  assert.equal((await asOwner.call("vault.test", { caller: "module:connectors", token: "owner's" })).data, "ran", "and for the owner it passes");
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

test("nobody to keep out: with no member but the owner the gate passes, asked every call; once a second person is a member the full rule applies", async () => {
  let others = false;
  const k = { ...kernelOf(() => ({ hops: [hop("person", BOB)] })), hasOtherMembers: async () => others };
  const r = rig(k);
  const member = { caller: "device:abcdef", token: "t" };
  assert.equal((await r.call("vault.test", member)).data, "ran", "before anyone joins");
  others = true;
  assert.equal((await r.call("vault.test", member)).error?.code, "denied", "the same call, judged after a member joins");
  others = false;
  assert.equal((await r.call("vault.test", member)).data, "ran", "asked every call, nothing remembered");
  const broken = rig({ ...kernelOf(() => ({ hops: [hop("person", BOB)] })), hasOtherMembers: async () => { throw new Error("no"); } });
  assert.equal((await broken.call("vault.test", member)).error?.code, "denied", "a kernel that cannot say refuses");
});

test("a kernel that ran at start and is gone at a call refuses; only a home that ran none is left open", async () => {
  const live = { current: /** @type {any} */ (kernelOf(() => ({ hops: [hop("person", OWNER)] }))) };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const ctx = gateTools({ get kernel() { return live.current; }, tool: (/** @type {string} */ n, /** @type {any} */ d) => reg.set(n, d) });
  ctx.tool("vault.test", { run: async () => "ran" });
  live.current = undefined;
  await assert.rejects(() => reg.get("vault.test").run({}, { caller: "cli", token: "t" }), { code: "denied" });
});
