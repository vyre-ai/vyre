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
import { createMemberTools, MEMBER_TOOLS } from "../work/member-tools.js";
import { guardRecordsCall, MEMBER_BLOCKED_TYPES, MEMBER_READ_ONLY_TYPES } from "../../kernel/remote/member-guard.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ name, /** @type {string} */ says) => `---\nname: ${name}\ndescription: Use this when the person asks about ${name}, which is ${says}\n---\n${says}\n`;
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
  const G = d.kernel.gateway.records, svc = d.kernel.gateway.serviceChain("skills");
  // what the member door's records group runs: k.gateway.records.*(chain, ...args), behind the door's own guard (kernel/remote/server.js wraps each call the same way)
  const trusted = (/** @type {any} */ chain) => { const r = d.kernel.gateway.members.roleOf({ kind: "person", id: chain.hops[0].actor.id, space }); return r === "owner" || r === "admin"; };
  const R = Object.fromEntries(["get", "reference", "query", "aggregate", "search", "create", "update", "remove", "restore"].map(n => [n, guardRecordsCall(n, (/** @type {any} */ c, /** @type {any[]} */ ...a) => /** @type {any} */ (G)[n](c, ...a), trusted)]));
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
  const svcRows = (await G.query(svc, "skill", { page: { limit: 50 } })).rows;
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
  const still = (await G.get(svc, "skill", idOf("space-approved")));
  assert.match(String(still.data.body), /SPACE-APPROVED-WORDS/);
  // the owner keeps access, and the skills door still works for both members
  assert.ok(!nothing(await tried(() => R.query(ownerChain, "skill", { page: { limit: 50 } }))), "the owner reads the skill records");
  assert.ok((await door.list(chainOf(ANA), {})).skills.some((/** @type {any} */ s) => s.name === "ana-private"));
  assert.ok((await door.list(chainOf(BEN), {})).skills.some((/** @type {any} */ s) => s.name === "space-approved"));
  assert.ok(!(await door.list(chainOf(BEN), {})).skills.some((/** @type {any} */ s) => s.name === "ana-private"));
  void a2;
});

test("the door's guard closes every typed records call and the searches and lists for every protected type, for a member; the owner and an admin pass", async () => {
  const log = /** @type {string[]} */ ([]);
  const fake = (/** @type {string} */ n) => async (/** @type {any} */ _c, /** @type {any[]} */ ...a) => { log.push(`${n}:${a[0]}`); return n === "search" ? { rows: [{ type: "skill", id: "1" }, { type: "def-flow", id: "2" }, { type: "contact", id: "3" }] } : n === "definitions" ? [{ name: "skill" }, { name: "contact" }] : { ok: true }; };
  const member = { hops: [{ actor: { kind: "person", id: "m" } }] }, owner = { hops: [{ actor: { kind: "person", id: "o" } }] };
  const trusted = (/** @type {any} */ c) => c === owner;
  for (const type of MEMBER_BLOCKED_TYPES) for (const n of ["get", "reference", "query", "aggregate", "create", "update", "remove", "restore"]) {
    await assert.rejects(guardRecordsCall(n, fake(n), trusted)(member, type, "x"), /not found/, `${n} ${type} is closed to a member`);
    assert.ok(await guardRecordsCall(n, fake(n), trusted)(owner, type, "x"), `${n} ${type} is open to the owner`);
  }
  assert.ok(await guardRecordsCall("query", fake("query"), trusted)(member, "contact", {}), "an ordinary type is open to a member");
  for (const type of MEMBER_READ_ONLY_TYPES) {
    assert.ok(await guardRecordsCall("query", fake("query"), trusted)(member, type, {}), `a member reads ${type}`);
    for (const n of ["create", "update", "remove", "restore"]) {
      await assert.rejects(guardRecordsCall(n, fake(n), trusted)(member, type, "x"), /kept by the team's own tools/, `a member cannot ${n} ${type}`);
      assert.ok(await guardRecordsCall(n, fake(n), trusted)(owner, type, "x"), `the owner can ${n} ${type}`);
    }
  }
  const found = await guardRecordsCall("search", fake("search"), trusted)(member, {});
  assert.deepEqual(found.rows.map((/** @type {any} */ h) => h.type), ["contact"], "a search leaves the protected types out");
  assert.equal((await guardRecordsCall("search", fake("search"), trusted)(owner, {})).rows.length, 3);
  assert.deepEqual(await guardRecordsCall("definitions", fake("definitions"), trusted)(member), [{ name: "contact" }], "the list of types leaves them out");
});

test("every row of the member door's table keeps only protected record types, names its input keys, and serves through an internal tool for modules", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  for (const [door, row] of Object.entries(MEMBER_TOOLS)) {
    for (const type of row.types) assert.ok(MEMBER_BLOCKED_TYPES.has(type), `${door}: ${type} is not in MEMBER_BLOCKED_TYPES`);
    // identity is never an input key. The ONE exception is a row that declares `target: "project"`: it carries the single key `project` (which project the call is about), and its tool resolves that project record itself and refuses unless the chain's person owns it or is on its team (core/work/member-files.test.js calls every such row as a member who is not on the project)
    assert.ok(row.target === undefined || row.target === "project", `${door}: target is "project" or absent`);
    const never = row.target === "project" ? ["person", "agent", "space", "as"] : ["person", "agent", "space", "as", "project"];
    if (row.target === "project") assert.equal(row.keys.filter(k => k === "project").length, 1, `${door}: a project-target row carries the single key project`);
    assert.ok(Array.isArray(row.keys) && !row.keys.some(k => never.includes(k)), `${door}: its input keys are declared (an empty list is a row that takes no input) and never name the person, the agent, the project or the Space (a project-target row names its project, nothing else of those)`);
    const def = /** @type {any} */ (d.registry).tools.get(row.tool);
    assert.ok(def && def.internal === true && def.reach === "modules" && def.crossSpace, `${door}: ${row.tool} is an internal tool for modules that declares crossSpace`);
  }
  createMemberTools({ space: d.kernel.id.space, kernel: d.kernel, registry: d.registry });   // and the daemon would stop at start for a row that is not
});
