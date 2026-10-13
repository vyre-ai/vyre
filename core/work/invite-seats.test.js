// @ts-check
// An invite that names projects: the joiner is put on each at the level chosen, by the one seat-giving path (hub.setSeatLevel). A replay (a restart re-delivers invite.used) leaves an existing seat as it is, even
// one an admin has edited since, and gives no second seat.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../../kernel/boot.js";
import { CORE_TYPES, PROJECT, TEAM_MEMBER } from "../../records/core-types.js";
import { createHub } from "./hub.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", NEW = "per_new";
async function rig() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-invseat-")), "kernel.db"));
  const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presenceCheck: async () => null });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await k.gateway.records.define(owner, { add_types: [...CORE_TYPES.filter((/** @type {any} */ t) => ["organization", "contact"].includes(t.name)), PROJECT, TEAM_MEMBER] });
  const hub = createHub({ kernel: { space: SPACE, owner: OWNER, serviceChain: () => owner, records: k.gateway.records }, call: async () => ({ data: null }) });
  const x = await hub.createProject(owner, { name: "Project X" }), y = await hub.createProject(owner, { name: "Project Y" });
  const seats = async (/** @type {string} */ p) => { const r = await hub.seatOf(p, NEW); return r && r.team ? r.level : null; };
  return { k, owner, hub, x, y, seats };
}

test("a joiner is seated on the invite's project at its level and on no other project", async () => {
  const { hub, owner, x, y, seats } = await rig();
  const r = await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "viewer", keep: true });
  assert.equal(r.seated, true);
  assert.equal(await seats(x.id), "viewer");
  assert.equal(await seats(y.id), null, "nothing else");
});

test("a replay gives no second seat and never undoes a level an admin changed since", async () => {
  const { k, hub, owner, x, seats } = await rig();
  await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "viewer", keep: true });
  await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "lead" });
  const again = await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "viewer", keep: true });
  assert.equal(again.kept, true);
  assert.equal(await seats(x.id), "lead", "the admin's edit stands");
  const rows = (await k.gateway.records.query(owner, "team-member", { page: { limit: 50 } })).rows.filter((/** @type {any} */ r) => r.data.actor && r.data.actor.actor.id === NEW);
  assert.equal(rows.length, 1, "one seat");
});

test("a project that is gone answers null, so the work module can say 'not added' loudly", async () => {
  const { hub, owner } = await rig();
  assert.equal(await hub.setSeatLevel(owner, { project: "no-such-project", person: NEW, level: "contributor", keep: true }), null);
});

// ---- the full path: a real kernel invite with seats, accepted, its invite.used event handed to the hub ----
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";

const proofOf = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
async function viaKernel(/** @type {{ issuerIs?: "owner" | "gone" }} */ o = {}) {
  const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) ? null : "wrong_proof") };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  await k.gateway.records.define(owner, { add_types: [...CORE_TYPES.filter((/** @type {any} */ t) => ["organization", "contact"].includes(t.name)), PROJECT, TEAM_MEMBER] });
  const asked = /** @type {any[]} */ ([]);
  let member = true;
  const hub = createHub({ kernel: { space: SPACE, owner: OWNER, serviceChain: () => owner, records: k.gateway.records, membership: async (/** @type {string} */ p) => (p === OWNER ? { member, role: "owner" } : { member: true, role: "member" }), ask: { request: async (/** @type {any} */ _c, /** @type {any} */ r) => { asked.push(r); } } }, log: () => {} });
  const x = await hub.createProject(owner, { name: "Project X" }), y = await hub.createProject(owner, { name: "Project Y" });
  const g = k.gateway.grants;
  const i = { role: "member", seats: [{ project: x.id, level: "viewer" }] };
  const inv = await g.invites.create(owner, i, { presence: proofOf("grants.invite", i, `vyre://${SPACE}/invite/new`) });
  const guest = k.chains.fromFacts({ kind: "invitee", person: NEW, vouched: true });
  await g.invites.accept(guest, inv.id, { seen: { role: inv.role, scope: inv.scope, expires: inv.expires, invitee: inv.invitee }, proof: { op: "grant.accept", fields: { invite: inv.id, hash: inv.hash, person: NEW }, n: Math.random() } });
  const ev = k.log.read({ type: "invite.used" }).at(-1);
  const level = async (/** @type {string} */ p) => { const r = await hub.seatOf(p, NEW); return r && r.team ? r.level : null; };
  return { hub, owner, ev, x, y, level, asked, gone: () => { member = false; } };
}

test("full path: a member invited on Project X as viewer accepts and has that seat and nothing else", async () => {
  const { hub, ev, x, y, level, asked } = await viaKernel();
  assert.deepEqual(ev.data.seats, [{ project: x.id, level: "viewer" }]);
  const r = await hub.onInviteUsed(ev.data);
  assert.deepEqual(r.seated, [x.id]);
  assert.equal(await level(x.id), "viewer");
  assert.equal(await level(y.id), null);
  assert.equal(asked.length, 0, "nothing missed, nothing raised");
});

test("full path: the event delivered twice (a restart) gives one seat and keeps a level an admin raised in between", async () => {
  const { hub, owner, ev, x, level } = await viaKernel();
  await hub.onInviteUsed(ev.data);
  await hub.setSeatLevel(owner, { project: x.id, person: NEW, level: "lead" });
  await hub.onInviteUsed(ev.data);
  assert.equal(await level(x.id), "lead", "the admin's edit stands");
});

test("full path: an issuer who left the space before the accept seats nothing, and both are told; the membership is untouched", async () => {
  const { hub, ev, x, y, level, asked, gone } = await viaKernel();
  gone();
  const r = await hub.onInviteUsed(ev.data);
  assert.deepEqual(r.seated, []);
  assert.match(r.missed[0].why, /no longer in the space/);
  assert.equal(await level(x.id), null);
  assert.equal(await level(y.id), null);
  assert.deepEqual(asked.map(a => a.doer.id).sort(), [NEW, OWNER].sort(), "the joiner and the issuer are each told");
  assert.match(asked[0].note, /invite them again/);
});

test("full path: an issuer who is only a project lead seats the joiner while still lead, and nothing once the lead seat is taken away", async () => {
  const LEAD = "per_lead";
  const { hub, owner, ev, x, level, asked } = await viaKernel();
  await hub.setSeatLevel(owner, { project: x.id, person: LEAD, level: "lead" });
  const byLead = { ...ev.data, issuer: LEAD };
  const ok = await hub.onInviteUsed(byLead);
  assert.deepEqual(ok.seated, [x.id], "still lead: seated");
  assert.equal(await level(x.id), "viewer");
  // a second joiner, after the lead was made a contributor
  await hub.setSeatLevel(owner, { project: x.id, person: LEAD, level: "contributor" });
  const later = await hub.onInviteUsed({ ...byLead, by: "per_other" });
  assert.deepEqual(later.seated, []);
  assert.match(later.missed[0].why, /can no longer put people on it/);
  assert.equal((await hub.seatOf(x.id, "per_other")).team, false);
  assert.ok(asked.some(a => a.doer.id === "per_other") && asked.some(a => a.doer.id === LEAD), "joiner and issuer are told");
});
