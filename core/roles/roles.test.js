import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { tempHome } from "../../test/helpers.js";
import { bootKernel } from "../../kernel/boot.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { start } from "../daemon/index.js";
import { checkRole, expandRole } from "../../lib/roles/definition.js";
import { customForInvite } from "../../lib/roles/invite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", ADA = "per_ada";
const sealer = { presenceCheck: async ({ proof, op, fields }) => (proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_payload") };
const proofFor = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const chainOf = (k, person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct", session: "s1" });
const LEAD = { name: "lead", label: "Lead", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "budget", kind: "number", label: "Budget" }, { name: "city", kind: "text", label: "City" }] };
const role = (extra = {}) => ({ label: "Intake", base: "member", can: ["view", "create", "edit"], ...extra });

async function rig() {
  const k = await bootKernel({ db: new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-roles-")), "kernel.db")), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer });
  const o = chainOf(k, OWNER, "d-o");
  const give = async (chain, person, r, custom) => { const m = { person, role: r, ...(custom ? { custom } : {}) }; return k.gateway.grants.setRole(chain, m, { presence: proofFor("grants.role", m, `vyre://${SPACE}/member/${person}`) }); };
  await k.gateway.records.define(o, { add_types: [LEAD] });
  const types = await k.gateway.definitions(o);
  const assign = (person, def) => give(o, person, def.base, { id: def.id, grants: expandRole(def, { space: SPACE, person, types }) });
  return { k, o, give, assign, types, R: k.gateway.records, b: chainOf(k, BOB, "d-b") };
}

test("checks: wider than the base is refused in words, above admin is refused, unknown things are refused with the choices", () => {
  assert.throws(() => checkRole(role({ can: ["view", "customize"] })), { code: "too_wide", message: /Admin/ }, "Member base cannot hold an Admin switch");
  assert.throws(() => checkRole(role({ base: "admin" })), { message: /starts from Member/ }, "an Admin-based role would still rank as an Admin");
  assert.throws(() => checkRole(role({ base: "owner" })), { message: /starts from Member/ });
  assert.throws(() => checkRole(role({ base: "guest" })), { message: /Member or Admin/ });
  assert.throws(() => checkRole(role({ can: ["upgrade"] })), { message: /The choices are/ }, "no owner-only switch exists");
  assert.throws(() => checkRole(role({ label: "Admin" })), { message: /built-in/ });
  assert.throws(() => checkRole(role({ where: { kind: "projects" } })), { message: /Name the projects/ });
  assert.throws(() => checkRole(role({ ends: 5 })), { message: /future/ });
  assert.throws(() => checkRole(role({ hidden_fields: { lead: ["budget"] } })), { message: /how much of lead/ });
  assert.throws(() => checkRole(role({ data: { lead: "edit" }, hidden_fields: { lead: ["nope"] } }), { types: [LEAD] }), { message: /no field "nope"/ });
  assert.throws(() => checkRole(role({ data: { ghost: "read" } }), { types: [LEAD] }), { message: /no record type/ });
  assert.equal(checkRole(role()).id, "intake");
});

test("a hidden field is omitted on a read and refused on a write; a type set to none is unreachable", async () => {
  const { k, assign, o, R, b } = await rig();
  const r = checkRole(role({ data: { lead: "edit" }, hidden_fields: { lead: ["budget"] } }), { types: [LEAD] });
  await assign(BOB, r);
  const lead = await R.create(o, "lead", { name: "Harlow", budget: 5000, city: "Riverton" });
  const seen = await R.get(b, "lead", lead.id);
  assert.equal(seen.data.name, "Harlow");
  assert.equal("budget" in seen.data, false, "omitted on a read");
  await assert.rejects(() => R.update(b, "lead", lead.id, { budget: 1 }, 1), { code: "field_not_allowed" });
  const none = checkRole(role({ label: "Blind", data: { lead: "none" } }), { types: [LEAD] });
  await assign(ADA, none);
  assert.equal(await R.get(chainOf(k, ADA, "d-a"), "lead", lead.id).catch(() => null), null, "a type set to none is unreachable");
});

test("only what they made: a role limited to its own records sees its own and not the owner's", async () => {
  const { assign, o, R, b } = await rig();
  await assign(BOB, checkRole(role({ label: "Mine", where: { kind: "mine" } })));
  const theirs = await R.create(o, "lead", { name: "Theirs" });
  const mine = await R.create(b, "lead", { name: "Mine" });
  const ids = (await R.query(b, "lead", { page: { limit: 10 } })).rows.map(x => x.id);
  assert.deepEqual(ids, [mine.id]);
  assert.ok(!ids.includes(theirs.id));
});

test("projects they are on stay as Member has them; chosen projects limit records to those projects", () => {
  const seats = expandRole(checkRole(role({ where: { kind: "my_projects" } })), { space: SPACE, person: BOB });
  assert.ok(seats.every(g => !g.resource.where), "the seat rule, not a grant predicate, limits a Member to the projects they are on");
  const chosen = expandRole(checkRole(role({ where: { kind: "projects", projects: ["p1", "p2"] } })), { space: SPACE, person: BOB });
  assert.ok(chosen.some(g => g.resource.where && g.resource.where[0].attr === "project" && g.resource.where[0].value.length === 2));
});

test("an end date: the role's grants stop working when it passes", async () => {
  const { assign, o, R, b } = await rig();
  const lead = await R.create(o, "lead", { name: "Harlow" });
  await assign(BOB, checkRole(role({ label: "Short", ends: Date.now() + 1500 })));
  assert.equal((await R.get(b, "lead", lead.id)).data.name, "Harlow", "before the end");
  await new Promise(r => setTimeout(r, 2200));
  assert.equal(await R.get(b, "lead", lead.id).catch(() => null), null, "after the end the grants no longer cover it");
});

test("MAY_SET holds for custom roles: an admin gives a Member-based role, never an admin", async () => {
  const { k, give, o, types } = await rig();
  await give(o, ADA, "admin");
  const a = chainOf(k, ADA, "d-a");
  const mem = checkRole(role());
  await give(a, BOB, mem.base, { id: mem.id, grants: expandRole(mem, { space: SPACE, person: BOB, types }) });
  const adm = { ...mem, id: "lead", base: "admin" };
  await assert.rejects(() => give(a, "per_cat", "admin", { id: adm.id, grants: expandRole(mem, { space: SPACE, person: "per_cat", types }) }), { code: "not_allowed" }, "an admin cannot make an admin, custom or not");
});

test("roles.*: create, list with holders, assign, remove refused while held, then removed; refusals name a next step", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const ok = async (tool, input) => { const r = await call(tool, input, { root, caller: "cli" }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const refused = async (tool, input) => { const r = await call(tool, input, { root, caller: "cli" }); assert.ok(r.error, `${tool} should be refused: ${JSON.stringify(r)}`); return r.error; };

  const cat = await ok("roles.catalogue", {});
  assert.deepEqual(cat.builtin.map(x => x.id), ["owner", "admin", "member", "guest"]);
  assert.equal((await refused("roles.create", { role: role({ can: ["view", "customize"] }) })).code, "too_wide");
  assert.match((await refused("roles.create", { role: role({ base: "owner" }) })).message, /starts from Member/);
  const made = (await ok("roles.create", { role: role() })).role;
  assert.equal(made.id, "intake");
  assert.equal((await refused("roles.create", { role: role() })).code, "duplicate");
  const listed = (await ok("roles.list", {})).roles;
  assert.deepEqual(listed.slice(0, 4).map(x => x.id), ["owner", "admin", "member", "guest"]);
  assert.equal(listed.find(x => x.id === "intake").people, 0);
  await ok("roles.assign", { person: BOB, role: "intake" });
  assert.equal((await ok("roles.list", {})).roles.find(x => x.id === "intake").people, 1);
  const inUse = await refused("roles.remove", { id: "intake" });
  assert.equal(inUse.code, "role_in_use");
  assert.match(inUse.message, /roles\.assign/);
  const upd = await ok("roles.update", { id: "intake", role: { can: ["view"] } });
  assert.equal(upd.reapplied, 1);
  await ok("roles.assign", { person: BOB, role: "member" });
  assert.equal((await ok("roles.remove", { id: "intake" })).removed, true);
  assert.equal((await refused("roles.get", { id: "intake" })).code, "not_found");
});

test("an invite into a role that does not exist or was removed is refused in words", async () => {
  const { k, o } = await rig();
  await assert.rejects(() => customForInvite(k.gateway, o, SPACE, "ghost"), { code: "not_found", message: /no role "ghost".*role list/ });
});

test("roles.update reapplies to every holder under one call: three holders all get the new grants, none stay on the old", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const ok = async (tool, input) => { const r = await call(tool, input, { root, caller: "cli" }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  await ok("roles.create", { role: role({ label: "Trio" }) });
  for (const p of [BOB, ADA, "per_cat"]) await ok("roles.assign", { person: p, role: "trio" });
  const upd = await ok("roles.update", { id: "trio", role: { can: ["view"] } });
  assert.equal(upd.reapplied, 3);
  assert.equal(upd.failed, undefined, "nobody left on the old access");
  assert.equal(upd.pending, undefined);
  assert.equal((await ok("roles.list", {})).roles.find(x => x.id === "trio").people, 3);
});
