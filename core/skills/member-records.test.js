// @ts-check
// The member door's records group (kernel/remote/wire.js CALLS.records) runs under the MEMBER role, which holds records.read/create/update/remove/restore on every type. The types a service keeps its own bookkeeping
// in (the skill library, Flows and their approvals, project templates, watchers) are PROTECTED (kernel/gateway/records.js): a member reads none of them, writes none of them, and finds none of them by a search, an
// aggregate or a query with no type; the owner, an admin and the services keep their access, and the skills door (core/work/member-tools.js) still works for her. Two members, A and B, on a real vyred.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createMemberTools } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ name, /** @type {string} */ says) => `---\nname: ${name}\ndescription: ${says}\n---\n${says}\n`;
/** Run an operation: what it answered, or the refusal. @param {() => Promise<any>} f */
const tried = async (f) => { try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, e }; } };
const nothing = (/** @type {any} */ r) => !r.ok || r.v == null || (Array.isArray(r.v) && r.v.length === 0) || (Array.isArray(r.v && r.v.rows) && r.v.rows.length === 0);

test("a member reads and changes none of another's skill records, a Space draft or an approved Space skill through records.*; the owner and the skills door keep working", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const chainOf = (/** @type {string} */ p) => d.kernel.chains.fromFacts(facts(p));
  const door = createMemberTools({ space, kernel: d.kernel, registry: d.registry }).skills;
  const R = d.kernel.gateway.records;   // what the member door's records group runs: k.gateway.records.*(chain, ...args)
  const tok = async (/** @type {any} */ chain) => ({ token: (await d.kernel.surfaces.open(chain, {})).token });

  // A's personal skill (approved), A's Space-level draft, and an approved Space skill by the owner
  const a1 = await door.draft(chainOf(ANA), { name: "ana-private", level: "personal", body: skill("ana-private", "ANA-PRIVATE-WORDS") });
  await door.approve(chainOf(ANA), { name: "ana-private", level: "personal", version: a1.version });
  const a2 = await door.draft(chainOf(ANA), { name: "ana-space-draft", level: "space", body: skill("ana-space-draft", "ANA-SPACE-DRAFT-WORDS") });
  const o1 = await d.registry.call("skills.draft", { name: "space-approved", level: "space", kind: "skill", body: skill("space-approved", "SPACE-APPROVED-WORDS") }, "cli", await tok(ownerChain));
  assert.ok(!o1.error, JSON.stringify(o1.error));
  const o2 = await d.registry.call("skills.approve", { name: "space-approved", level: "space", version: o1.data.version }, "cli", await tok(ownerChain));
  assert.ok(!o2.error, JSON.stringify(o2.error));

  // the skill rows, as the service that keeps them sees them
  const svcRows = (await d.kernel.records.query(d.kernel.serviceChain("skills"), "skill", { page: { limit: 50 } })).rows;
  const idOf = (/** @type {string} */ name) => String((svcRows.find((/** @type {any} */ r) => r.data.name === name) || {}).id);
  assert.equal(svcRows.length >= 3, true, "the library holds the three versions");

  const B = chainOf(BEN);
  for (const name of ["ana-private", "ana-space-draft", "space-approved"]) {
    const id = idOf(name);
    assert.ok(nothing(await tried(() => R.get(B, "skill", id))), `get ${name}`);
    assert.ok(nothing(await tried(() => R.query(B, "skill", { page: { limit: 50 } }))), `query skill (${name})`);
    assert.ok(nothing(await tried(() => R.aggregate(B, "skill", { group_by: "state" }))), `aggregate skill (${name})`);
    const upd = await tried(() => R.update(B, "skill", id, { state: "approved", body: skill(name, "BEN-WAS-HERE") }, 1));
    assert.equal(upd.ok, false, `update ${name} is refused`);
    assert.equal((await tried(() => R.remove(B, "skill", id, 1))).ok, false, `remove ${name} is refused`);
    assert.equal((await tried(() => R.restore(B, "skill", id))).ok, false, `restore ${name} is refused`);
  }
  const found = await tried(() => R.search(B, { text: "ANA-PRIVATE-WORDS" }));
  assert.ok(nothing(found) || !JSON.stringify(found.v).includes("ANA-PRIVATE-WORDS"), "a search for the words finds nothing");
  const found2 = await tried(() => R.search(B, { text: "ANA-SPACE-DRAFT-WORDS" }));
  assert.ok(nothing(found2) || !JSON.stringify(found2.v).includes("ANA-SPACE-DRAFT-WORDS"));
  // the text is still what the owner approved
  const still = (await d.kernel.records.get(d.kernel.serviceChain("skills"), "skill", idOf("space-approved")));
  assert.match(String(still.data.body), /SPACE-APPROVED-WORDS/);
  // the owner keeps access, and the skills door still works for both members
  assert.ok(!nothing(await tried(() => R.query(ownerChain, "skill", { page: { limit: 50 } }))), "the owner reads the skill records");
  assert.ok((await door.list(chainOf(ANA), {})).skills.some((/** @type {any} */ s) => s.name === "ana-private"));
  assert.ok((await door.list(chainOf(BEN), {})).skills.some((/** @type {any} */ s) => s.name === "space-approved"));
  assert.ok(!(await door.list(chainOf(BEN), {})).skills.some((/** @type {any} */ s) => s.name === "ana-private"));
  void a2;
});

test("a member reads and changes none of the Flow, project-template and watcher records either", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const B = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "relay" });
  const R = d.kernel.gateway.records;
  for (const type of ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run", "project-template", "def-watcher", "skill"]) {
    const planted = await tried(() => R.create(B, type, { name: "planted-by-ben", flow_id: "x", body: "x", state: "approved" }));
    assert.equal(planted.ok, false, `a member cannot create a ${type} record`);
    assert.ok(nothing(await tried(() => R.query(B, type, { page: { limit: 10 } }))), `a member's query of ${type} is empty`);
  }
});
