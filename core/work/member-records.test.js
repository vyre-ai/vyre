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
import { createDoor } from "../../lib/gateway-door.js";
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
  // the types the team's own tools keep are not hers through the Store's calls: not read, not listed, not written (the owner keeps them)
  assert.equal(await code(w.as(ANA, "records.list", { type: "skill" })), "not_found");
  assert.equal(await code(w.as(ANA, "records.create", { type: "skill", data: { name: "x" } })), "not_found");
  assert.equal(await code(w.as(ANA, "records.get", { urn: `vyre://${w.space}/def-flow/rec_x` })), "not_found");
  assert.equal(await code(w.as(ANA, "records.create", { type: "team-member", data: {} })), "not_allowed", "the project team is kept by the team's own tools");
  assert.ok((await w.as(ANA, "records.types")).types.every((/** @type {any} */ x) => x.name !== "skill" && x.name !== "def-flow"));
  assert.notEqual(await code(w.as(w.OWNER, "records.list", { type: "skill" })), "not_found", "the owner keeps access to the kept types");
  // update and events on a kept type are refused too, by the type in the address
  assert.equal(await code(w.as(ANA, "records.update", { urn: `vyre://${w.space}/skill/rec_x`, patch: { a: 1 }, base_version: 1 })), "not_found");
  assert.equal(await code(w.as(ANA, "records.events", { record: `vyre://${w.space}/def-flow/rec_x` })), "not_found");
  // the Projects screen lists through records.list { type: "project" }: a member gets a page (a project is hers to see; the gateway's ownership rule decides which rows)
  const projects = await w.as(ANA, "records.list", { type: "project", limit: 10 });
  assert.ok(Array.isArray(projects.rows), "a member's project list answers a page, not a refusal: " + JSON.stringify(projects));
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

test("the doing of a task is the doer's: the doer starts and hands in her task, a stranger who is a member does neither", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const made = (await w.as(ANA, "tasks.request", { task: { title: "Draft the letter", doer: ANA, output: { kind: "note" } } })).task;
  assert.ok(made && made.id, JSON.stringify(made));
  assert.ok(await code(w.as(BEN, "tasks.move", { id: made.id, to: "working" })), "another member cannot start Ana's task");
  assert.ok(await code(w.as(BEN, "tasks.submit", { id: made.id, evidence: { note: { text: "done", sources: ["vyre://x/y/z"] } } })), "another member cannot hand in Ana's task");
  assert.equal((await w.as(ANA, "tasks.move", { id: made.id, to: "working" })).task.state, "working");
  const done = (await w.as(ANA, "tasks.submit", { id: made.id, evidence: { note: { text: "done", sources: ["vyre://x/y/z"] } } })).task;
  assert.ok(["needs_check", "done"].includes(done.state), JSON.stringify(done));
});

test("door.open honors a held chain only when it is exactly one person's, for the Space the call names", { timeout: 90_000 }, async t => {
  const w = await world(t);
  const door = createDoor({ kernel: { for: (/** @type {string} */ id) => (id === w.space ? { space: id, hosted: true, gateway: w.d.kernel.gateway, surfaces: w.d.kernel.surfaces } : null) } });
  const chain = w.chainOf(ANA);
  const opened = await door.open({}, { in_space: w.space, in_space_chain: chain });
  assert.equal(opened.chain, chain, "a one-person chain for this Space is the call's chain");
  const hop = { actor: { kind: "agent", id: "kit", space: w.space } };
  for (const [what, bad] of [["a two-hop chain", { ...chain, hops: [...chain.hops, hop] }], ["an agent hop", { ...chain, hops: [hop] }], ["a chain for another Space", { ...chain, space: "spc_zzzzzzzzzzzz" }], ["no hops", { ...chain, hops: [] }], ["a viewer chain", { ...chain, viewer: true }], ["a delegated chain", { ...chain, delegated: true }]]) {
    assert.equal(await code(door.open({}, { in_space: w.space, in_space_chain: bad })), "denied", what);
  }
  assert.equal(await code(door.open({}, { in_space: "spc_zzzzzzzzzzzz", in_space_chain: { ...chain, space: "spc_zzzzzzzzzzzz" } })), "not_found", "a Space this server does not host");
});

test("the audit is a row of the member door: an admin and the owner read it as themselves, a plain member is refused, and a stranger or a chain with an agent in it gets nothing", { timeout: 90_000 }, async t => {
  const w = await world(t);
  assert.ok(MEMBER_TOOLS["records.audit"] && /** @type {any} */ (CALLS).records.includes("audit"), "records.audit is a row and a call of its group");
  assert.ok(!MEMBER_TOOLS["records.audit"].keys.some((/** @type {string} */ k) => ["page", "window", "space"].includes(k)), "the door lets the filters through, never a page size, a window or a Space");
  await w.d.kernel.gateway.grants.setRole(w.ownerChain, { person: ZED, role: "admin" }, { presence: proof() });
  const made = (await w.as(ANA, "records.create", { type: "contact", data: { name: "Jane", age: 40 } })).record;
  // an admin and the owner read it, as themselves
  const byAdmin = await w.as(ZED, "records.audit", { type: "contact" });
  const change = byAdmin.changes.find((/** @type {any} */ x) => x.record === made.urn);
  assert.ok(change, "the admin sees the change");
  assert.equal(change.who, `person:${ANA}`, "and who made it");
  assert.ok((await w.as(w.OWNER, "records.audit", { type: "contact" })).changes.some((/** @type {any} */ x) => x.record === made.urn), "the owner too");
  assert.equal((await w.as(ZED, "records.audit", { changed_by: ANA, type: "contact", limit: 1 })).changes.length, 1, "the filters pass");
  // a plain member, and Ana who made the record, are refused in words
  assert.equal(await code(w.as(BEN, "records.audit", { type: "contact" })), "not_allowed", "a member is refused");
  assert.equal(await code(w.as(ANA, "records.audit", {})), "not_allowed", "even for a record she made herself");
  // a stranger, and a chain that is not one person's (an agent behind an admin), get nothing
  assert.equal(await code(w.as("per_" + "efghijklmnopqrstuvwxyzabcd", "records.audit", {})), "not_found", "a stranger gets nothing");
  const agentChain = { ...w.chainOf(ZED), hops: [...w.chainOf(ZED).hops, { actor: { kind: "agent", id: "kit", space: w.space } }] };
  assert.equal(await code(/** @type {any} */ (w.svc).records.audit(agentChain, {})), "not_found", "an agent behind an admin gets nothing");
});


test("through the member door a member moves a record, relates two, saves her own layout, and is refused the Space's layout and a pipeline", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const { DEAL, RELATIONSHIP, RECORD_LAYOUT } = await import("../../records/core-types.js");
  const clean = (/** @type {any} */ x) => ({ ...x, fields: x.fields.filter((/** @type {any} */ f) => !(x.name === "deal" && f.name === "organization")) });
  await w.d.kernel.gateway.records.define(w.ownerChain, { add_types: [clean(DEAL), RELATIONSHIP, RECORD_LAYOUT] }).catch(() => {});
  for (const k of ["records.move", "records.relationship.add", "records.relationship.remove", "records.layout.set"]) {
    assert.equal(MEMBER_TOOLS[k].tool, "records.serve-update", `${k} is a write of the member door`);
    assert.ok(/** @type {any} */ (CALLS).records.includes(MEMBER_TOOLS[k].call), `${k} is a call of the group`);
  }
  const deal = (await w.as(ANA, "records.create", { type: "deal", data: { name: "Okafor", amount: 1000 } })).record;
  const ref = deal.data.ref;
  assert.notEqual(await code(w.as(ANA, "records.move", { urn: deal.urn, stage: "Qualified", patch: { ref: "DEA-9999" } })), null, "a move cannot change the ID");
  const moved = (await w.as(ANA, "records.move", { urn: deal.urn, stage: "Qualified" })).record;
  assert.equal(moved.data.stage, "Qualified"); assert.equal(moved.data.ref, ref);
  const a = (await w.as(ANA, "records.create", { type: "contact", data: { name: "Ava" } })).record;
  const b = (await w.as(ANA, "records.create", { type: "contact", data: { name: "Sam" } })).record;
  const rel = (await w.as(ANA, "records.relationship.add", { from: a.urn, to: b.urn, kind: "Colleague" })).relationship;
  assert.equal((await w.as(ANA, "records.relationship.list", { urn: a.urn })).relationships.length, 1);
  await w.as(ANA, "records.relationship.remove", { id: rel.id });
  assert.equal((await w.as(ANA, "records.relationship.list", { urn: a.urn })).relationships.length, 0);
  await w.as(ANA, "records.layout.set", { type: "deal", scope: "mine", layout: { columns: ["name"] } });
  { const got = await w.as(ANA, "records.layout.get", { type: "deal" }); const all = await w.as(w.OWNER, "records.list", { type: "record-layout" }); assert.equal(JSON.stringify(got.layout.columns), JSON.stringify(["name"]), `${JSON.stringify(got)} rows: ${JSON.stringify(all.rows.map((/** @type {any} */ r) => r.data))}`); }
  assert.equal(await code(w.as(ANA, "records.layout.set", { type: "deal", scope: "space", layout: { columns: ["name"] } })), "not_allowed");
  for (const k of ["records.pipeline.set", "records.type.update", "records.field.add", "records.link.add", "records.sample.add"]) assert.equal(/** @type {any} */ (MEMBER_TOOLS)[k], undefined, `${k} is not a row of the member door`);
  assert.equal(typeof /** @type {any} */ (w.svc).records["pipeline.set"], "undefined", "and the door has no such call");
  assert.ok((await w.as(w.OWNER, "records.layout.get", { type: "deal" })).layout.columns === undefined, "her layout is hers alone");
});

test("an admin cannot read a member's private note through the raw route; the member and a shared note are read", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const { PLANNER_TYPES } = await import("../planner/types.js");
  await w.d.kernel.gateway.records.define(w.ownerChain, { add_types: PLANNER_TYPES.filter((x) => x.name === "note").map((x) => JSON.parse(JSON.stringify(x))) }).catch((/** @type {any} */ e) => { if (!/exist/i.test(String(e && e.message))) throw e; });
  const noteDef = (await w.d.kernel.gateway.definitions(w.ownerChain)).find((/** @type {any} */ x) => x.name === "note");
  assert.ok(noteDef && noteDef.protected === true && noteDef.fields.some((/** @type {any} */ f) => f.name === "visibility"), `the planner's Note type is defined: ${JSON.stringify(noteDef && noteDef.fields.map((/** @type {any} */ f) => f.name))}`);
  await w.d.kernel.gateway.grants.setRole(w.ownerChain, { person: ZED, role: "admin" }, { presence: proof() });
  const svc = w.d.kernel.gateway.serviceChain("planner");
  const note = async (/** @type {string} */ title, /** @type {any} */ more) => w.d.kernel.gateway.records.create(svc, "note", { title, state: "open", person: BEN, ...more }, { on_behalf: w.chainOf(BEN) });
  const priv = await note("secret", { visibility: "private" }), shared = await note("for all", { visibility: "space" });
  const titles = async (/** @type {string} */ p) => ((await w.d.registry.call("records.list", { type: "note" }, "cli", { token: (await w.d.kernel.surfaces.open(w.chainOf(p), {})).token })).data.rows || []).map((/** @type {any} */ r) => r.data.title).sort();
  assert.deepEqual(await titles(ZED), ["for all"], "an admin reads only what is shared");
  assert.deepEqual(await titles(w.OWNER), ["for all"], "so does the owner");
  const got = await w.d.registry.call("records.get", { urn: priv.urn }, "cli", { token: (await w.d.kernel.surfaces.open(w.chainOf(ZED), {})).token });
  assert.equal(got.data.record, null, "and cannot open the private one");
  assert.ok(shared.urn);
});


test("a private note and an outside calendar's event are private on every kernel route, to an admin and the owner too, and only the writer changes who reads a note", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const { PLANNER_TYPES } = await import("../planner/types.js");
  const { EVENT } = await import("../../records/core-types.js");
  const gw = w.d.kernel.gateway;
  await gw.records.define(w.ownerChain, { add_types: [...PLANNER_TYPES.filter((x) => x.name === "note").map((x) => JSON.parse(JSON.stringify(x))), JSON.parse(JSON.stringify(EVENT))] });
  await gw.grants.setRole(w.ownerChain, { person: ZED, role: "admin" }, { presence: proof() });
  const call = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input) => w.d.registry.call(tool, input, "cli", { token: (await w.d.kernel.surfaces.open(w.chainOf(p), {})).token });
  const contact = (await w.as(ANA, "records.create", { type: "contact", data: { name: "Ava" } })).record;
  // BEN's private note about a contact, and BEN's event from his outside calendar
  const note = await gw.records.create(gw.serviceChain("planner"), "note", { title: "Dentist secret", state: "open", person: BEN, visibility: "private", record: contact.urn }, { on_behalf: w.chainOf(BEN) });
  const ev = (await call(BEN, "records.create", { type: "event", data: { title: "Dentist visit", starts_at: "2026-10-20T09:00:00.000Z", source: "google", record: { urn: contact.urn } } })).data.record;
  assert.ok(ev && ev.urn, "BEN made his event");
  for (const [who, name] of [[ZED, "an admin"], [w.OWNER, "the owner"]]) {
    const chain = w.chainOf(who);
    for (const [type, text] of [["note", "Dentist secret"], ["event", "Dentist visit"]]) {
      assert.equal(await code(gw.records.aggregate(chain, type, { group_by: ["title"], measures: [{ fn: "count" }] })), "not_allowed", `${name}: a total over ${type} is refused`);
      const found = await gw.records.search(chain, { text: text.split(" ")[0], types: [type], page: { limit: 20 } });
      assert.equal(found.rows.length, 0, `${name}: search finds no ${type}`);
      const listed = await gw.records.query(chain, type, { page: { limit: 50 } });
      assert.equal(listed.rows.length, 0, `${name}: list shows no ${type}`);
    }
    const linked = await gw.records.linked(chain, contact.urn, {});
    assert.ok(!JSON.stringify(linked).includes("Dentist"), `${name}: linked lists neither`);
    const audit = await call(who, "records.audit", {});
    assert.ok(!JSON.stringify(audit).includes("Dentist"), `${name}: the audit lists neither`);
    const events = await call(who, "records.events", {});
    assert.ok(!JSON.stringify(events).includes("Dentist"), `${name}: the event log lists neither`);
    assert.equal((await call(who, "records.history", { urn: ev.urn })).error.code, "not_found", `${name}: history of the event is not found`);
    assert.equal((await call(who, "records.log", { urn: ev.urn, kind: "call", text: "x" })).error.code, "not_found", `${name}: logging on the event is not found`);
  }
  // BEN reads both, and the Space's own events are not touched
  assert.equal((await gw.records.query(gw.serviceChain("planner"), "note", { page: { limit: 50 } })).rows.length, 1, "the planner reads it (a member reads her notes through the planner)");
  assert.equal((await gw.records.query(w.chainOf(BEN), "event", { page: { limit: 50 } })).rows.length, 1);
  // sharing a note: only its writer, through the planner (a member reaches the planner through the owner's door; here the writer is an admin, and the owner and a member are refused)
  const item = (await call(ZED, "planner.add", { kind: "note", title: "Shared later", record: contact.urn })).data;
  assert.ok(item && item.id, JSON.stringify(item));
  const owner = await call(w.OWNER, "planner.update", { item: item.id, visibility: "space" });
  assert.ok(owner.error && /writes|wrote|not_found|no such/i.test(JSON.stringify(owner.error)), `the owner cannot share another person's note: ${JSON.stringify(owner)}`);
  assert.ok((await call(ANA, "planner.update", { item: item.id, visibility: "space" })).error, "a member cannot share it");
  assert.ok((await call(w.OWNER, "planner.update", { item: item.id, title: "hijack" })).error, "and the owner cannot edit another person's private note");
  { const mine = await call(ZED, "planner.update", { item: item.id, visibility: "space" }); assert.ok(!mine.error, `its writer can: ${JSON.stringify(mine.error)}`); }
  assert.ok(note.urn);
});
