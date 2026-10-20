// @ts-check
// The member door's 0.6.4 records rows (core/work/member-tools.js): a joined member gives a record a role, reads its roles and who holds one, undoes a change in its history, and moves a record she may change
// to the bin and back, as HER, in the team's Space, on a REAL vyred with the kernel on. Adding a link or a field to a type is an owner's or an admin's act: a member is told who decides, a joined admin does it.
// A person who is not a member gets nothing, and the kept types stay out of reach. SHIM(presence): `kernelPresence` accepts any proof for the owner's grants acts. Run it on a test box, never on a person's Mac.
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
const code = async (/** @type {Promise<any>} */ p) => p.then(() => null, (/** @type {any} */ e) => e && e.code);

/** A real vyred with Ana a member and Ben an admin of its Space. @param {any} t */
async function world(t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: ANA, role: "member" }, { presence: proof() });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BEN, role: "admin" }, { presence: proof() });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [CONTACT] }).catch(() => {});
  const { ROLE_TYPES } = await import("../../records/core-types.js");
  await d.kernel.gateway.records.define(ownerChain, { add_types: ROLE_TYPES.filter((x) => x.name === "role-lead").map((x) => JSON.parse(JSON.stringify(x))) }).catch(() => {});
  const svc = createMemberTools({ space, kernel: d.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts(facts(person));
  const as = (/** @type {string} */ person, /** @type {string} */ door, /** @type {any[]} */ ...args) => { const [g, c] = [door.slice(0, door.indexOf(".")), door.slice(door.indexOf(".") + 1)]; return /** @type {any} */ (svc)[g][c](chainOf(person), ...args); };
  return { d, OWNER, space, svc, as, chainOf, ownerChain };
}

test("the new records rows serve the call of their tool, and each is a call of the records group", () => {
  const want = { "records.roles": ["records.serve", "roles"], "records.holders": ["records.serve", "holders"], "records.role.set": ["records.serve-update", "role.set"], "records.share": ["records.serve-update", "share"], "records.history.undo": ["records.serve-update", "history.undo"], "records.remove": ["records.serve-update", "remove"], "records.restore": ["records.serve-update", "restore"], "records.link.add": ["records.serve-update", "link.add"], "records.field.add": ["records.serve-update", "field.add"] };
  for (const [k, [tool, call]] of Object.entries(want)) {
    assert.equal(MEMBER_TOOLS[k]?.tool, tool, k);
    assert.equal(MEMBER_TOOLS[k]?.call, call, k);
    assert.ok(/** @type {any} */ (CALLS).records.includes(call), `${call} is a call of the records group`);
  }
  for (const k of ["records.seal-put", "records.sees-as", "records.forget"]) assert.equal(MEMBER_TOOLS[k], undefined, `${k} stays on the owner's own server`);
});

test("a joined member gives a record a role, reads its roles and holders, undoes her change, and moves her record to the bin and back, as herself", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const contact = (await w.as(ANA, "records.create", { type: "contact", data: { name: "Sample Person" } })).record;
  // a role, as her
  const set = await w.as(ANA, "records.role.set", { urn: contact.urn, role: "role-lead" });
  assert.equal(set.role.label, "Lead", JSON.stringify(set));
  assert.ok((await w.as(ANA, "records.roles", { urn: contact.urn })).roles.some((/** @type {any} */ r) => r.role === "role-lead" && r.current), "her record holds the role");
  assert.ok((await w.as(ANA, "records.holders", { role: "role-lead" })).rows.some((/** @type {any} */ r) => r.holder === contact.urn), "she is listed as a holder");
  const summary = (await w.as(ANA, "records.roles.summary", {})).roles.find((/** @type {any} */ r) => r.role === "role-lead");
  assert.equal(summary.holder, "contact", "the summary names the type that holds the role");
  // an undo of her own change
  const got = (await w.as(ANA, "records.get", { urn: contact.urn })).record;
  await w.as(ANA, "records.update", { urn: contact.urn, patch: { name: "Sample Renamed" }, base_version: got.version });
  const item = (await w.as(ANA, "records.history", { urn: contact.urn })).items.find((/** @type {any} */ x) => /name/i.test(x.text) && x.undo);
  assert.ok(item, "her change is in the history");
  assert.equal((await w.as(ANA, "records.history.undo", { id: item.id })).undone, item.id);
  assert.equal((await w.as(ANA, "records.get", { urn: contact.urn })).record.data.name, "Sample Person", "the undo wrote the old value back");
  // the bin: removed, listed with include_deleted, not got, restored
  const now = (await w.as(ANA, "records.get", { urn: contact.urn })).record;
  assert.equal(await code(w.as(ANA, "records.remove", { urn: contact.urn, base_version: now.version - 1 })), "version_conflict", "a stale version is refused");
  assert.equal((await w.as(ANA, "records.remove", { urn: contact.urn, base_version: now.version })).removed, contact.urn);
  assert.equal((await w.as(ANA, "records.get", { urn: contact.urn })).record, null, "a removed record is not got");
  const bin = (await w.as(ANA, "records.list", { type: "contact", include_deleted: true })).rows.find((/** @type {any} */ r) => r.urn === contact.urn);
  assert.ok(bin && bin.deleted_at > 0, "her bin lists it");
  assert.equal((await w.as(ANA, "records.restore", { urn: contact.urn })).restored, contact.urn);
  assert.equal((await w.as(ANA, "records.get", { urn: contact.urn })).record.data.name, "Sample Person", "it is back as it was");
  // a person who is not a member, and an agent behind her chain, get nothing
  assert.equal(await code(w.as(ZED, "records.remove", { urn: contact.urn, base_version: 1 })), "not_found");
  const agentChain = { ...w.chainOf(ANA), hops: [...w.chainOf(ANA).hops, { actor: { kind: "agent", id: "kit", space: w.space } }] };
  assert.equal(await code(/** @type {any} */ (w.svc).records.restore(agentChain, { urn: contact.urn })), "not_found");
  // the kept types: not found, and the read-only ones not hers to remove
  assert.equal(await code(w.as(ANA, "records.remove", { urn: `vyre://${w.space}/skill/rec_x`, base_version: 1 })), "not_found");
  assert.equal(await code(w.as(ANA, "records.restore", { urn: `vyre://${w.space}/def-flow/rec_x` })), "not_found");
  assert.equal(await code(w.as(ANA, "records.remove", { urn: `vyre://${w.space}/team-member/rec_x`, base_version: 1 })), "not_allowed");
  assert.equal(await code(w.as(ANA, "records.holders", { role: "skill" })), "not_found");
  // the gateway's own shapes still reach the gateway (type, id, base)
  const again = (await w.as(ANA, "records.get", { urn: contact.urn })).record;
  const gw = await w.as(ANA, "records.remove", "contact", contact.urn.split("/").pop(), again.version);
  assert.ok(gw && gw.deleted_at > 0, "the gateway's own remove answers in its own shape");
  await w.as(ANA, "records.restore", "contact", contact.urn.split("/").pop());
});

test("adding a link or a field to a type through the door: a member is told an owner or an admin does it, a joined admin does it", { timeout: 150_000 }, async t => {
  const w = await world(t);
  assert.equal(await code(w.as(ANA, "records.link.add", { type: "contact", label: "Referred by", to: "contact" })), "not_allowed");
  assert.equal(await code(w.as(ANA, "records.field.add", { type: "contact", label: "Shoe size", kind: "number" })), "not_allowed");
  const link = await w.as(BEN, "records.link.add", { type: "contact", label: "Referred by", to: "contact" });
  assert.equal(link.field.name, "referred_by", JSON.stringify(link));
  const field = await w.as(BEN, "records.field.add", { type: "contact", label: "Shoe size", kind: "number" });
  assert.equal(field.field.name, "shoe_size", JSON.stringify(field));
  // the door passes only the keys a row names: a Space she names is dropped, so it lands in the team's Space
  const types = (await w.as(BEN, "records.types", {})).types;
  assert.ok(types.find((/** @type {any} */ x) => x.name === "contact").fields.some((/** @type {any} */ f) => f.name === "referred_by"), "the link is on the team's type");
});
