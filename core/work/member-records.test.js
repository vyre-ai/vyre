// @ts-check
// A team member's daily work on the team's records and tasks, through the member door's rows (core/work/member-tools.js), on a REAL vyred with the kernel on: the same tool names and input shapes the app's Store
// uses (records.list/get/create/update/me/actors/types/events, tasks.list/get/request/move/submit), run as HER, in the team's Space. The owner works the same calls under his own chain; a person who is not a member
// and a chain that is not one person's get nothing; the gateway's own call shapes (records.get(type, id), tasks.get(id)) still answer as before. SHIM(presence): `kernelPresence` accepts any proof for the owner's grants acts.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CALLS } from "../../kernel/remote/wire.js";
import { createMemberTools, MEMBER_TOOLS } from "./member-tools.js";
import { CONTACT } from "../../kernel/conformance/suite.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** @param {any} t */
async function world(t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [CONTACT] }).catch(() => {});
  const svc = createMemberTools({ space, kernel: d.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts(facts(person));
  /** the door's call as a person's connection makes it: (group, call, args...) */
  const as = (/** @type {string} */ person, /** @type {string} */ door, /** @type {any[]} */ ...args) => { const [g, c] = [door.slice(0, door.indexOf(".")), door.slice(door.indexOf(".") + 1)]; return /** @type {any} */ (svc)[g][c](chainOf(person), ...args); };
  return { d, OWNER, space, svc, as, chainOf, ownerChain };
}
const code = async (/** @type {Promise<any>} */ p) => p.then(() => null, (/** @type {any} */ e) => e && e.code);

test("the records and tasks calls are rows of the member door's table, and the groups carry their names", () => {
  for (const k of ["records.me", "records.actors", "records.types", "records.list", "records.get", "records.events", "records.create", "records.update", "tasks.list", "tasks.get", "tasks.request", "tasks.move", "tasks.submit"]) {
    assert.ok(MEMBER_TOOLS[k], `${k} is a row`);
    const [g, c] = [k.slice(0, k.indexOf(".")), k.slice(k.indexOf(".") + 1)];
    assert.ok(/** @type {any} */ (CALLS)[g].includes(c), `${k} is a call of its group`);
  }
});

test("a member lists, makes, reads and changes records of the team's Space as herself, the owner does the same under his own chain, and a stranger and a chain with an agent in it get nothing", { timeout: 90_000 }, async t => {
  const w = await world(t);
  assert.equal((await w.as(ANA, "records.me")).person, ANA, "the chain's person, never the owner");
  assert.equal((await w.as(w.OWNER, "records.me")).person, w.OWNER);
  assert.ok((await w.as(ANA, "records.actors")).actors.some((/** @type {any} */ a) => a.id === ANA));
  const types = (await w.as(ANA, "records.types")).types;
  assert.ok(types.some((/** @type {any} */ x) => x.name === "contact") && types.every((/** @type {any} */ x) => !x.system), "the team's types, none of the kernel's own");
  const made = (await w.as(ANA, "records.create", { type: "contact", data: { name: "Jane", age: 40 } })).record;
  assert.equal(made.data.name, "Jane");
  const page = await w.as(ANA, "records.list", { type: "contact", limit: 10 });
  assert.equal(page.rows.length, 1);
  const got = (await w.as(ANA, "records.get", { urn: made.urn })).record;
  assert.equal(got.data.name, "Jane");
  const upd = (await w.as(ANA, "records.update", { urn: made.urn, patch: { age: 41 }, base_version: got.version })).record;
  assert.equal(upd.data.age, 41);
  assert.equal(await code(w.as(ANA, "records.update", { urn: made.urn, patch: { age: 42 }, base_version: got.version })), "version_conflict", "a stale base is refused by the kernel");
  assert.equal((await w.as(BEN, "records.get", { urn: made.urn })).record?.data?.name, "Jane", "another member of the Space reads what the kernel lets members read");
  const events = (await w.as(ANA, "records.events", { record: made.urn })).events;
  assert.ok(Array.isArray(events));
  // the owner works the same calls
  assert.equal((await w.as(w.OWNER, "records.list", { type: "contact" })).rows.length, 1);
  // input keys the call does not take are dropped: a member cannot name a Space, a chain or the kernel's system types
  assert.ok((await w.as(ANA, "records.types", { system: true, space: "spc_zzzzzzzzzzzz" })).types.every((/** @type {any} */ x) => !x.system));
  // a stranger (not a member) and a chain with an agent behind it
  assert.equal(await code(w.as(ZED, "records.list", { type: "contact" })), "not_found", "a person who is not a member gets nothing");
  const agentChain = { ...w.chainOf(ANA), hops: [...w.chainOf(ANA).hops, { actor: { kind: "agent", id: "kit", space: w.space } }] };
  assert.equal(await code(/** @type {any} */ (w.svc).records.list(agentChain, { type: "contact" })), "not_found", "a chain that is not one person's gets nothing");
});

test("a member asks for, works and hands in tasks as herself; the gateway's own call shapes still answer as before", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const made = (await w.as(ANA, "tasks.request", { task: { title: "Call Jane", doer: ANA, output: { kind: "note" } } })).task;
  assert.ok(made && made.id, JSON.stringify(made));
  assert.equal((await w.as(ANA, "tasks.list", {})).tasks.some((/** @type {any} */ x) => x.id === made.id), true);
  assert.equal((await w.as(ANA, "tasks.get", { id: made.id })).task.id, made.id);
  const started = (await w.as(ANA, "tasks.move", { id: made.id, to: "working" })).task;
  assert.equal(started.state, "working", JSON.stringify(started));
  const done = (await w.as(ANA, "tasks.submit", { id: made.id, evidence: { note: { text: "called her", sources: ["vyre://x/y/z"] } } })).task;
  assert.ok(["needs_check", "done"].includes(done.state), JSON.stringify(done));
  assert.equal(await code(w.as(ZED, "tasks.list", {})), "not_found");
  // the gateway's own shapes, as a member's home reaches the team through its remote client
  const g = await w.as(ANA, "tasks.get", made.id);
  assert.equal(g && g.id, made.id, "tasks.get(id) is the gateway's, untouched");
  const rec = (await w.as(ANA, "records.create", "contact", { name: "Pat" }));
  assert.equal(rec.data.name, "Pat", "records.create(type, data) is the gateway's, untouched");
  const q = await w.as(ANA, "records.query", "contact", { page: { limit: 5 } });
  assert.ok(Array.isArray(q.rows), "and the calls the table does not name pass through");
});
