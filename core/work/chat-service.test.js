// @ts-check
// The member session door (0.3.3 J9), on a REAL vyred with the kernel on and a REAL hosted team Space: a person who joined the team has no session of their own on the server, so their own chats are a
// service of the Space's remote server (kernel/remote wire CALLS.chat, core/work/chat-service.js). Each member starts their own chat, finds their own pinned assistant, sees the chats they are in and no
// one else's; a person who is not a member, a chain that is not one person's, and another Space's chain get nothing. Stand-in, labelled: SHIM(presence) `kernelPresence` accepts any proof for the owner's
// grants acts, as the other real-daemon suites do (a headless test has no hardware signer).
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CALLS } from "../../kernel/remote/wire.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const OWNER = "per_" + "abcdefghijklmnopqrstuvwxyz", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** A daemon, a hosted team Space with the owner and two members, and the member door's chat service for it. @param {any} t */
async function world(t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await firm.gateway.grants.setRole(owner, { person, role: "member" }, { presence: proof() });
  const handle = /** @type {any} */ (d.registry.modules.get("work")).handle;
  assert.equal(typeof handle.peerService, "function", "the work module offers its member chat service to the peer door");
  const svc = handle.peerService({ space: firm.space, kernel: firm.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person, space = firm.space) => (space === firm.space ? firm.kernel : d.kernel).chains.fromFacts(facts(person));
  return { d, firm, svc, owner, chainOf, as: (/** @type {string} */ person, /** @type {string} */ call, input = {}) => svc[call](chainOf(person), input) };
}

test("chat is a group of the Space kernel's remote calls", () => {
  assert.deepEqual(CALLS.chat, ["persistent", "pin", "list", "get", "create"]);
});

test("a member starts their own chat and sees it; another member does not see it", { timeout: 90_000 }, async t => {
  const { as } = await world(t);
  const made = await as(ANA, "create", { title: "Ana's notes" });
  assert.match(String(made.chat), /^chat_/, JSON.stringify(made));
  const mine = await as(ANA, "list", {});
  assert.ok(mine.chats.some((/** @type {any} */ c) => c.chat === made.chat && c.open === true), "Ana sees the chat she started, open");
  const theirs = await as(BEN, "list", {});
  assert.ok(!theirs.chats.some((/** @type {any} */ c) => c.chat === made.chat && c.open === true), "Ben is not in it");
  const got = await as(ANA, "get", { chat: made.chat });
  assert.ok(got.people.includes(ANA));
  await assert.rejects(as(BEN, "get", { chat: made.chat }), /not_found|no such chat/i, "Ben cannot open Ana's chat");
});

test("a member's pinned assistant chat is their own: a second ask returns the same one, and the other member has their own", { timeout: 90_000 }, async t => {
  const { as } = await world(t);
  const none = await as(ANA, "persistent", { kind: "assistant" });
  assert.equal(none.allowed, true);
  assert.equal(none.chat ?? null, null);
  const made = await as(ANA, "create", { title: "Assistant" });
  await as(ANA, "pin", { kind: "assistant", chat: made.chat });
  assert.equal((await as(ANA, "persistent", { kind: "assistant" })).chat, made.chat);
  assert.equal((await as(BEN, "persistent", { kind: "assistant" })).chat ?? null, null, "Ben has none of his own yet");
});

test("a member who shares a chat with another sees it: the shared chat is in both lists", { timeout: 90_000 }, async t => {
  const { as } = await world(t);
  const made = await as(ANA, "create", { title: "Huddle", people: [BEN] });
  for (const person of [ANA, BEN]) assert.ok((await as(person, "list", {})).chats.some((/** @type {any} */ c) => c.chat === made.chat && c.open === true), `${person.slice(4, 8)} is in the shared chat`);
});

test("nobody else gets anything: a non-member, an agent's or a delegated chain, another Space's chain, and an input that names a Space or a person", { timeout: 90_000 }, async t => {
  const { svc, d, firm, chainOf, as } = await world(t);
  await assert.rejects(svc.list(chainOf(ZED), {}), /not found/i, "a person who is not a member");
  const agent = { space: firm.space, hops: [{ actor: { kind: "person", id: ANA, space: firm.space } }, { actor: { kind: "agent", id: "kit", space: firm.space } }] };
  await assert.rejects(svc.list(agent, {}), /not found/i, "a chain with an agent hop");
  await assert.rejects(svc.list({ ...chainOf(ANA), delegated: true }, {}), /not found/i, "a delegated chain");
  await assert.rejects(svc.list({ ...chainOf(ANA), viewer: true }, {}), /not found/i, "a viewer");
  await assert.rejects(svc.list({ space: d.kernel.id.space, hops: [{ actor: { kind: "person", id: ANA, space: d.kernel.id.space } }] }, {}), /not found/i, "a chain of the home's Space");
  const made = await as(ANA, "create", { title: "Mine", space: d.kernel.id.space, as: OWNER });
  assert.match(String(made.chat), /^chat_/);
  const home = await d.registry.call("work.chat.list", {}, "cli", {});
  assert.ok(!JSON.stringify(home).includes(String(made.chat)), "the home's own list never shows the team's chat: the call ran in the team's Space");
});

test("the boundary: work.chat.serve is the daemon's door alone, runs only in a Space under a member's chain, and the five calls are the whole list", { timeout: 90_000 }, async t => {
  const { d, svc } = await world(t);
  assert.deepEqual(Object.keys(svc).sort(), [...CALLS.chat].sort(), "the service answers exactly the wire's list");
  for (const caller of ["cli", "mcp", "device:abcdefghijklmnop", "module:sneaky", "space:per_zed@spc_abcdefghijkl", "capsule"]) {
    const r = await d.registry.call("work.chat.serve", { call: "list", input: {} }, caller, {});
    assert.ok(r.error, `${caller} is refused: ${JSON.stringify(r).slice(0, 160)}`);
  }
  const bare = await d.registry.call("work.chat.serve", { call: "list", input: {} }, "module:vyred", { door: true });
  assert.ok(bare.error && /member door/.test(String(bare.error.message)), `the daemon itself, outside a Space and without a member's chain, is refused: ${JSON.stringify(bare)}`);
  assert.equal(svc.keys, undefined, "a chat key call is not on the list");
  assert.equal(svc.rename, undefined);
});
