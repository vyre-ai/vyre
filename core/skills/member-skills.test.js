// @ts-check
// A team member's own skills on the team's server (0.3.3 G03), on a REAL vyred with the kernel on: the member door's skills service (kernel/remote/wire.js CALLS.skills, core/skills/member-service.js). A member
// drafts and approves a personal skill of her own and her turns list it; the owner's and another member's do not; she cannot approve a Space-level skill, cannot read or approve the owner's personal one, cannot
// add a plugin; a person who is not a member, and a chain that is not one person's, get nothing. SHIM(presence) `kernelPresence` accepts any proof for the owner's grants acts, as the other real-daemon suites do.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CALLS } from "../../kernel/remote/wire.js";
import { createMemberTools, MEMBER_TOOLS } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ name, /** @type {string} */ says) => `---\nname: ${name}\ndescription: ${says}\n---\n${says}\n`;

/** @param {any} t */
async function world(t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const svc = createMemberTools({ space, kernel: d.kernel, registry: d.registry }).skills;
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts(facts(person));
  // what a person's own surface sees through the registry (the path a session's list takes)
  const tokenOf = async (/** @type {any} */ chain) => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const listFor = async (/** @type {string} */ person) => (await d.registry.call("skills.list", {}, "cli", await tokenOf(d.kernel.chains.fromFacts({ ...facts(person), path: "direct", session: "s" })))).data;
  return { d, OWNER, space, svc, chainOf, listFor, tokenOf, ownerChain, ownerFacts: { kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" }, as: (/** @type {string} */ person, /** @type {string} */ call, input = {}) => svc[call](chainOf(person), input) };
}

test("skills is a group of the Space kernel's remote calls, and every call of it is a row of the member door's one table", () => {
  assert.deepEqual([...CALLS.skills].sort(), ["approve", "draft", "get", "list", "versions"]);
  assert.deepEqual(Object.keys(MEMBER_TOOLS).filter(k => k.startsWith("skills.")).map(k => k.slice(7)).sort(), [...CALLS.skills].sort());
});

test("a member drafts and approves a personal skill of her own; her list shows it, the owner's and another member's do not", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const drafted = await w.as(ANA, "draft", { name: "ana-own", level: "personal", body: skill("ana-own", "only Ana uses this") });
  assert.equal(drafted.state, "draft", JSON.stringify(drafted));
  assert.ok(!(await w.as(ANA, "list", {})).skills.some((/** @type {any} */ s) => s.name === "ana-own"), "a draft is in nobody's list yet");
  const approved = await w.as(ANA, "approve", { name: "ana-own", level: "personal", version: drafted.version });
  assert.equal(approved.state, "approved", JSON.stringify(approved));
  const hers = (await w.as(ANA, "list", {})).skills;
  assert.ok(hers.some((/** @type {any} */ s) => s.name === "ana-own" && s.level === "personal"), JSON.stringify(hers));
  assert.ok(!(await w.as(BEN, "list", {})).skills.some((/** @type {any} */ s) => s.name === "ana-own"), "Ben's list has no Ana skill");
  const got = await w.as(ANA, "get", { id: "personal/ana-own" });
  assert.match(String(got.text), /only Ana uses this/);
  await assert.rejects(w.as(BEN, "get", { id: "personal/ana-own" }), /No skill|not_found/i, "and Ben cannot read it");
  // her next turn: the registry path a session's skills.list takes, for her, for Ben and for the owner
  const anaTurn = await w.listFor(ANA), benTurn = await w.listFor(BEN);
  assert.ok(anaTurn.skills.some((/** @type {any} */ s) => s.name === "ana-own"), "her turn lists it");
  assert.ok(!benTurn.skills.some((/** @type {any} */ s) => s.name === "ana-own"), "another member's turn does not");
  const ownerTurn = (await w.d.registry.call("skills.list", {}, "cli", await w.tokenOf(w.ownerChain))).data;
  assert.ok(!ownerTurn.skills.some((/** @type {any} */ s) => s.name === "ana-own"), "the owner's turn does not");
  const versions = await w.as(ANA, "versions", {});
  assert.ok(versions.versions.some((/** @type {any} */ v) => v.name === "ana-own"));
  assert.ok(!(await w.as(BEN, "versions", {})).versions.some((/** @type {any} */ v) => v.name === "ana-own"), "Ben's versions do not show Ana's personal skill");
});

test("a member's draft at the Space level stays a draft: she cannot approve it", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const drafted = await w.as(ANA, "draft", { name: "space-wide", level: "space", body: skill("space-wide", "for everyone") });
  assert.equal(drafted.state, "draft");
  await assert.rejects(w.as(ANA, "approve", { name: "space-wide", level: "space", version: drafted.version }), /owner or an admin|not_allowed|only/i);
  assert.ok(!(await w.as(BEN, "list", {})).skills.some((/** @type {any} */ s) => s.name === "space-wide"), "and nobody has it");
});

test("a member cannot read, approve or draft into the owner's personal skills", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => w.d.registry.call(tool, input, "cli", await w.tokenOf(w.ownerChain));
  const d1 = await call("skills.draft", { name: "owner-secret", level: "personal", kind: "skill", body: skill("owner-secret", "owner only") });
  assert.ok(!d1.error, JSON.stringify(d1.error));
  const a1 = await call("skills.approve", { name: "owner-secret", level: "personal", version: d1.data.version });
  assert.ok(!a1.error, JSON.stringify(a1.error));
  assert.ok(!(await w.as(ANA, "list", {})).skills.some((/** @type {any} */ s) => s.name === "owner-secret"), "not in her list");
  await assert.rejects(w.as(ANA, "get", { id: "personal/owner-secret" }), /No skill|not_found/i);
  await assert.rejects(w.as(ANA, "approve", { name: "owner-secret", level: "personal", scope: w.OWNER, version: 1 }), /only|not_allowed|owner/i);
  await assert.rejects(w.as(ANA, "draft", { name: "owner-secret", level: "personal", scope: w.OWNER, body: skill("owner-secret", "mine now") }), /yourself|not_allowed/i);
  assert.ok(!(await w.as(ANA, "versions", {})).versions.some((/** @type {any} */ v) => v.name === "owner-secret"), "and the history shows her nothing of it");
});

test("a plugin is refused for a member, with words; a person who is not a member, and a chain that is not one person's, get nothing", { timeout: 90_000 }, async t => {
  const w = await world(t);
  await assert.rejects(w.as(ANA, "draft", { name: "pl", level: "personal", kind: "plugin", body: JSON.stringify({ name: "pl", description: "x", skills: [] }) }), /plugin can carry code/i);
  await assert.rejects(w.as(ZED, "list", {}), /not found|not_found/i, "a person who is not a member");
  await assert.rejects(w.svc.list(w.d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: ANA, agent: "assistant", session: "s" }), {}), /not found|not_found/i, "an assistant's two-hop chain");
});
