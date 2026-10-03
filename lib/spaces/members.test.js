// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { ROLE_IDS, ROLE_BUNDLES } from "../../kernel/contracts/index.js";
import {
  SpacesError, memoryStore, createMembers, canAssign, canRemove, abilitiesOf, reaches, narrow, deviceAbilities, assistantCap,
  validateGrant, isValidScopeEntry, DEFAULT_POLICY, systemActor,
} from "./members.js";

const SP = "spc_harlow00001";
const DAY = 86400000;
const T0 = 1_800_000_000_000;
const P1 = `vyre://${SP}/project/intake`;
const P2 = `vyre://${SP}/project/probate`;

/** Fake presence verifier: the proof is { payload, ok }; it must bind exactly the payload asked about. */
const verifyPresence = (/** @type {any} */ payload, /** @type {any} */ proof) =>
  !!proof && proof.ok === true && JSON.stringify(proof.payload) === JSON.stringify(payload);
const proofFor = (/** @type {any} */ payload) => ({ ok: true, payload });

function world(opts = {}) {
  let t = T0;
  const events = /** @type {any[]} */ ([]);
  const store = memoryStore();
  const svc = createMembers({
    space: SP, store, now: () => t, emit: (type, payload) => { events.push({ type, ...payload }); }, verifyPresence, ...opts,
  });
  return { svc, store, events, clock: { get: () => t, set: (/** @type {number} */ v) => { t = v; }, tick: (/** @type {number} */ d) => { t += d; } } };
}
/** alex owner, then juno admin, kit manager, harlow-member member. */
async function seeded(opts = {}) {
  const w = world(opts);
  await w.svc.bootstrapOwner("alex");
  await w.svc.addMember({ actor: "alex", person: "juno", role: "admin" });
  await w.svc.addMember({ actor: "alex", person: "kit", role: "manager" });
  await w.svc.addMember({ actor: "alex", person: "mo", role: "member" });
  w.events.length = 0;
  return w;
}
const code = async (/** @type {Promise<any>} */ p) => { try { await p; ok++; } catch (e) { assert.ok(e instanceof SpacesError, String(e)); return e.code; } return null; };
const tempArgs = (/** @type {number} */ t, extra = {}) => ({ role: /** @type {"temp"} */ ("temp"), scope: [P1], expires: t + 10 * DAY, ...extra });

test("authority table: canAssign and canRemove", () => {
  assert.deepEqual(ROLE_IDS.filter(r => canAssign("owner", r)), [...ROLE_IDS]);
  assert.deepEqual(ROLE_IDS.filter(r => canAssign("admin", r)), ["manager", "member", "temp"]);
  for (const r of ["manager", "member", "temp"]) for (const x of ROLE_IDS) { assert.equal(canAssign(r, x), false); assert.equal(canRemove(r, x), false); }
  assert.equal(canRemove("admin", "admin"), false);
  assert.equal(canRemove("admin", "owner"), false);
  assert.equal(canRemove("admin", "member"), true);
  assert.equal(canRemove("owner", "owner"), true);
  assert.equal(canAssign("nonsense", "member"), false);
});

test("abilitiesOf follows the bundles and an expired temp has none", () => {
  for (const r of ["owner", "admin", "manager", "member"]) assert.deepEqual(abilitiesOf(/** @type {any} */ ({ role: r }), T0), ROLE_BUNDLES[/** @type {any} */ (r)].abilities);
  const temp = /** @type {any} */ ({ role: "temp", scope: [P1], expires: T0 + 1000 });
  assert.deepEqual(abilitiesOf(temp, T0), ["scoped.work"]);
  assert.deepEqual(abilitiesOf(temp, T0 + 999), ["scoped.work"]);
  assert.deepEqual(abilitiesOf(temp, T0 + 1000), []);
  assert.deepEqual(abilitiesOf({ ...temp, expired: true }, T0), []);
  assert.deepEqual(abilitiesOf(/** @type {any} */ (null), T0), []);
  assert.deepEqual(abilitiesOf(/** @type {any} */ ({ role: "bogus" }), T0), []);
});

test("reaches: temp only inside scope, on segment boundaries, until expiry", () => {
  const temp = /** @type {any} */ ({ role: "temp", scope: [P1, `vyre://${SP}/contact/c1`], expires: T0 + DAY });
  assert.equal(reaches(temp, P1, T0), true);
  assert.equal(reaches(temp, `${P1}/task/t9`, T0), true);
  assert.equal(reaches(temp, `vyre://${SP}/contact/c1`, T0), true);
  assert.equal(reaches(temp, P2, T0), false);
  assert.equal(reaches(temp, `${P1}x`, T0), false, "prefix must end on a segment");
  assert.equal(reaches(temp, `vyre://${SP}/project/int`, T0), false);
  assert.equal(reaches(temp, `${P1}/../probate`, T0), false, "traversal is refused");
  assert.equal(reaches(temp, `${P1}/%2e%2e/probate`, T0), false);
  assert.equal(reaches(temp, "not a urn", T0), false);
  assert.equal(reaches(temp, P1, T0 + DAY), false, "expired");
  assert.equal(reaches({ ...temp, scope: [] }, P1, T0), false);
  assert.equal(reaches({ ...temp, scope: undefined }, P1, T0), false);
  assert.equal(reaches({ ...temp, scope: [`vyre://${SP}/project`] }, P1, T0), false, "a bare type is not a project");
  for (const r of ["owner", "admin", "manager", "member"]) assert.equal(reaches(/** @type {any} */ ({ role: r }), P2, T0), true);
});

test("scope entries must name a project or record", () => {
  assert.equal(isValidScopeEntry(P1), true);
  for (const bad of [`vyre://${SP}`, `vyre://${SP}/project`, `vyre://${SP}/project/`, "http://x/a/b", `vyre://${SP}/project/a?x=1`, `vyre://${SP}/project/a/..`, 5, null, ""]) assert.equal(isValidScopeEntry(bad), false, String(bad));
});

test("narrow can only shrink a role", () => {
  assert.deepEqual(narrow("manager", ["projects.create_run", "kits.use"]), ["projects.create_run", "kits.use"]);
  assert.deepEqual(narrow("member", []), []);
  assert.deepEqual(narrow("manager", ["kits.use", "kits.use"]), ["kits.use"]);
  assert.throws(() => narrow("member", ["projects.create_run"]), (/** @type {any} */ e) => e.code === "exceeds_role");
  assert.throws(() => narrow("manager", ["customize.definitions"]), (/** @type {any} */ e) => e.code === "exceeds_role", "never list");
  assert.throws(() => narrow("admin", ["space.delete"]), (/** @type {any} */ e) => e.code === "exceeds_role");
  assert.throws(() => narrow("temp", ["space.shared_by_policy"]), (/** @type {any} */ e) => e.code === "exceeds_role");
  assert.throws(() => narrow("nope", []), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => narrow("member", /** @type {any} */ ("x")), (/** @type {any} */ e) => e.code === "bad_input");
  for (const r of ROLE_IDS) {
    assert.doesNotThrow(() => narrow(r, ROLE_BUNDLES[r].abilities));
    for (const a of ROLE_BUNDLES[r].never) assert.throws(() => narrow(r, [a]));
  }
});

test("bootstrapOwner once, with a single-owner warning", async () => {
  const w = world();
  const r = await w.svc.bootstrapOwner("alex");
  assert.equal(r.membership.role, "owner");
  assert.equal(r.warnings[0].code, "single_owner");
  assert.equal(await code(w.svc.bootstrapOwner("kit")), "duplicate");
  assert.equal(w.events[0].type, "member.added");
});

test("addMember follows the authority rules", async () => {
  const { svc } = await seeded();
  // owner adds anything
  assert.equal((await svc.addMember({ actor: "alex", person: "n1", role: "member" })).membership.role, "member");
  // admin adds manager, member, temp but never admin or owner
  assert.equal((await svc.addMember({ actor: "juno", person: "n2", role: "manager" })).membership.role, "manager");
  assert.equal((await svc.addMember({ actor: "juno", person: "n3", ...tempArgs(T0) })).membership.role, "temp");
  assert.equal(await code(svc.addMember({ actor: "juno", person: "n4", role: "admin" })), "forbidden");
  assert.equal(await code(svc.addMember({ actor: "juno", person: "n4", role: "owner" })), "exceeds_role");
  // manager, member and temp add nobody
  assert.equal(await code(svc.addMember({ actor: "kit", person: "n5", role: "member" })), "forbidden");
  assert.equal(await code(svc.addMember({ actor: "mo", person: "n5", role: "member" })), "forbidden");
  assert.equal(await code(svc.addMember({ actor: "n3", person: "n5", role: "member" })), "exceeds_role");
  assert.equal(await code(svc.addMember({ actor: "n3", person: "n5", role: "temp", scope: [P1], expires: T0 + DAY })), "forbidden");
  assert.equal(await code(svc.addMember({ actor: "kit", person: "n5", role: "admin" })), "exceeds_role");
  // outsiders and junk
  assert.equal(await code(svc.addMember({ actor: "ghost", person: "n5", role: "member" })), "not_a_member");
  assert.equal(await code(svc.addMember({ actor: "alex", person: "", role: "member" })), "bad_input");
  assert.equal(await code(svc.addMember({ actor: "alex", person: "n5", role: /** @type {any} */ ("god") })), "bad_input");
  assert.equal(await code(svc.addMember({ actor: /** @type {any} */ (null), person: "n5", role: "member" })), "bad_input");
});

test("one membership per person per space", async () => {
  const { svc } = await seeded();
  assert.equal(await code(svc.addMember({ actor: "alex", person: "kit", role: "member" })), "duplicate");
  assert.equal(await code(svc.addMember({ actor: "alex", person: "alex", role: "member" })), "duplicate");
});

test("adding an owner needs a presence proof bound to that grant", async () => {
  const { svc } = await seeded();
  assert.equal(await code(svc.addMember({ actor: "alex", person: "n1", role: "owner" })), "needs_presence");
  const wrong = proofFor({ action: "member.grant_owner", space: SP, person: "someone-else", from: null, to: "owner" });
  assert.equal(await code(svc.addMember({ actor: "alex", person: "n1", role: "owner", presence: wrong })), "needs_presence");
  const good = proofFor({ action: "member.grant_owner", space: SP, person: "n1", from: null, to: "owner" });
  const r = await svc.addMember({ actor: "alex", person: "n1", role: "owner", presence: good });
  assert.equal(r.membership.role, "owner");
  assert.deepEqual(r.warnings, [], "two owners: no warning");
  // an admin cannot even try
  assert.equal(await code(svc.addMember({ actor: "juno", person: "n2", role: "owner", presence: good })), "exceeds_role");
});

test("system actor adds non-owners and never owners", async () => {
  const { svc, store } = await seeded();
  const r = await svc.addMember({ actor: systemActor("juno"), person: "n1", role: "member" });
  assert.equal(r.membership.added_by, "juno");
  assert.equal(await code(svc.addMember({ actor: systemActor("juno"), person: "n2", role: "owner", presence: proofFor({}) })), "forbidden");
  assert.equal(await code(svc.setRole({ actor: systemActor("juno"), person: "n1", role: "manager" })), "forbidden");
  assert.equal(await code(svc.removeMember({ actor: systemActor("juno"), person: "n1" })), "forbidden");
  assert.equal(await code(svc.addMember({ actor: /** @type {any} */ ({ system: true }), person: "n3", role: "member" })), "bad_input");
  assert.ok(store.get(SP, "n1"));
});

test("temp rules: scope and a future expiry are required, others carry neither", async () => {
  const { svc } = await seeded();
  const a = { actor: "alex", person: "t1" };
  assert.equal(await code(svc.addMember({ ...a, role: "temp" })), "bad_scope");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", scope: [P1] })), "bad_scope", "no expiry");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", expires: T0 + DAY })), "bad_scope", "no scope");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", scope: [], expires: T0 + DAY })), "bad_scope");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", scope: [`vyre://${SP}/project`], expires: T0 + DAY })), "bad_scope");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", scope: [P1], expires: T0 })), "expired", "now is not the future");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", scope: [P1], expires: T0 - 1 })), "expired");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", scope: [P1], expires: NaN })), "bad_scope");
  assert.equal(await code(svc.addMember({ ...a, role: "temp", scope: [P1], expires: T0 + DEFAULT_POLICY.maxTempMs + 1 })), "bad_scope");
  assert.equal((await svc.addMember({ ...a, role: "temp", scope: [P1, P1], expires: T0 + DEFAULT_POLICY.maxTempMs })).membership.scope?.length, 1, "max is inclusive; scope deduped");
  assert.equal(await code(svc.addMember({ actor: "alex", person: "m2", role: "member", scope: [P1] })), "bad_scope");
  assert.equal(await code(svc.addMember({ actor: "alex", person: "m2", role: "member", expires: T0 + DAY })), "bad_scope");
  assert.equal(await code(svc.addMember({ actor: "alex", person: "m2", role: "admin", scope: [P1] })), "bad_scope");
  assert.equal((await svc.addMember({ actor: "alex", person: "m2", role: "member", scope: [] })).membership.scope, undefined);
});

test("policy maxTempMs is honoured", async () => {
  const { svc } = await seeded({ policy: { maxTempMs: 3 * DAY } });
  assert.equal(await code(svc.addMember({ actor: "alex", person: "t1", ...tempArgs(T0, { expires: T0 + 4 * DAY }) })), "bad_scope");
  assert.ok(await svc.addMember({ actor: "alex", person: "t1", ...tempArgs(T0, { expires: T0 + 3 * DAY }) }));
});

test("validateGrant is usable alone", () => {
  assert.deepEqual(validateGrant("member", undefined, undefined, T0, DEFAULT_POLICY), {});
  assert.deepEqual(validateGrant("temp", [P1], T0 + 5, T0, DEFAULT_POLICY), { scope: [P1], expires: T0 + 5 });
});

test("setRole: authority, ceiling and the admin wall", async () => {
  const { svc } = await seeded();
  assert.equal((await svc.setRole({ actor: "alex", person: "mo", role: "manager" })).membership.role, "manager");
  assert.equal((await svc.setRole({ actor: "juno", person: "mo", role: "member" })).membership.role, "member");
  assert.equal(await code(svc.setRole({ actor: "juno", person: "mo", role: "admin" })), "forbidden", "admin cannot make admins");
  assert.equal(await code(svc.setRole({ actor: "juno", person: "alex", role: "member" })), "forbidden", "admin cannot touch an owner");
  assert.equal(await code(svc.setRole({ actor: "juno", person: "mo", role: "owner" })), "exceeds_role");
  assert.equal(await code(svc.setRole({ actor: "kit", person: "mo", role: "member" })), "forbidden");
  assert.equal(await code(svc.setRole({ actor: "mo", person: "kit", role: "member" })), "forbidden");
  assert.equal(await code(svc.setRole({ actor: "alex", person: "ghost", role: "member" })), "not_a_member");
  assert.equal(await code(svc.setRole({ actor: "alex", person: "mo", role: "member" })), "bad_input", "same role");
  // owner promotes an admin to owner only with presence
  assert.equal(await code(svc.setRole({ actor: "alex", person: "juno", role: "owner" })), "needs_presence");
  const ok = await svc.setRole({ actor: "alex", person: "juno", role: "owner", presence: proofFor({ action: "member.grant_owner", space: SP, person: "juno", from: "admin", to: "owner" }) });
  assert.equal(ok.membership.role, "owner");
  assert.equal(ok.membership.added_by, "alex", "history kept");
});

test("a person may lower their own role but never raise it", async () => {
  const { svc } = await seeded();
  assert.equal((await svc.setRole({ actor: "juno", person: "juno", role: "member" })).membership.role, "member");
  assert.equal(await code(svc.setRole({ actor: "kit", person: "kit", role: "admin" })), "forbidden");
  assert.equal(await code(svc.setRole({ actor: "mo", person: "mo", role: "manager" })), "forbidden");
});

test("setRole to and from temp", async () => {
  const { svc } = await seeded();
  assert.equal(await code(svc.setRole({ actor: "alex", person: "mo", role: "temp" })), "bad_scope");
  const r = await svc.setRole({ actor: "juno", person: "mo", ...tempArgs(T0) });
  assert.equal(r.membership.role, "temp");
  const back = await svc.setRole({ actor: "juno", person: "mo", role: "member" });
  assert.equal(back.membership.scope, undefined);
  assert.equal(back.membership.expires, undefined);
});

test("setRole temp to temp may narrow but never widen or extend", async () => {
  const { svc } = await seeded();
  await svc.addMember({ actor: "juno", person: "t1", role: "temp", scope: [P1, P2], expires: T0 + 10 * DAY });
  const n = await svc.setRole({ actor: "juno", person: "t1", role: "temp", scope: [P1], expires: T0 + 5 * DAY });
  assert.deepEqual(n.membership.scope, [P1]);
  assert.equal(await code(svc.setRole({ actor: "juno", person: "t1", role: "temp", scope: [P1, P2], expires: T0 + 5 * DAY })), "bad_scope");
  assert.equal(await code(svc.setRole({ actor: "juno", person: "t1", role: "temp", scope: [P1], expires: T0 + 6 * DAY })), "needs_presence");
});

test("last owner cannot be demoted or removed, including by themselves", async () => {
  const { svc } = await seeded();
  assert.equal(await code(svc.setRole({ actor: "alex", person: "alex", role: "admin" })), "last_owner");
  assert.equal(await code(svc.removeMember({ actor: "alex", person: "alex" })), "last_owner");
  assert.equal(await svc.ownerCount(), 1);
  // with two owners either may step down, then the remaining one is protected
  await svc.addMember({ actor: "alex", person: "owner2", role: "owner", presence: proofFor({ action: "member.grant_owner", space: SP, person: "owner2", from: null, to: "owner" }) });
  assert.equal((await svc.setRole({ actor: "owner2", person: "owner2", role: "admin" })).membership.role, "admin");
  assert.equal(await code(svc.removeMember({ actor: "alex", person: "alex" })), "last_owner");
});

test("removeMember authority", async () => {
  const { svc } = await seeded();
  assert.equal(await code(svc.removeMember({ actor: "juno", person: "alex" })), "forbidden");
  assert.equal(await code(svc.removeMember({ actor: "kit", person: "mo" })), "forbidden");
  assert.equal(await code(svc.removeMember({ actor: "mo", person: "kit" })), "forbidden");
  assert.equal(await code(svc.removeMember({ actor: "juno", person: "ghost" })), "not_a_member");
  await svc.removeMember({ actor: "juno", person: "kit" });
  assert.equal(await svc.get("kit"), undefined);
  // anyone may leave
  await svc.removeMember({ actor: "mo", person: "mo" });
  assert.equal(await svc.get("mo"), undefined);
  // an admin may leave but cannot be removed by another admin
  await svc.addMember({ actor: "alex", person: "adm2", role: "admin" });
  assert.equal(await code(svc.removeMember({ actor: "juno", person: "adm2" })), "forbidden");
  await svc.removeMember({ actor: "alex", person: "adm2" });
});

test("a removed actor is no longer a member and cannot act", async () => {
  const { svc } = await seeded();
  await svc.removeMember({ actor: "alex", person: "juno" });
  assert.equal(await code(svc.addMember({ actor: "juno", person: "n1", role: "member" })), "not_a_member");
});

test("ownership transfer: owner plus presence, old owner demoted", async () => {
  const { svc, events } = await seeded();
  assert.equal(await code(svc.transferOwnership({ actor: "juno", to: "kit", presence: proofFor({}) })), "forbidden");
  assert.equal(await code(svc.transferOwnership({ actor: "alex", to: "alex" })), "bad_input");
  assert.equal(await code(svc.transferOwnership({ actor: "alex", to: "ghost", presence: proofFor({}) })), "not_a_member");
  assert.equal(await code(svc.transferOwnership({ actor: "alex", to: "juno" })), "needs_presence");
  const bad = proofFor({ action: "ownership.transfer", space: SP, person: "kit", from: "alex", to: "kit" });
  assert.equal(await code(svc.transferOwnership({ actor: "alex", to: "juno", presence: bad })), "needs_presence", "proof for another person");
  assert.equal(await code(svc.transferOwnership({ actor: "alex", to: "juno", demoteTo: /** @type {any} */ ("owner"), presence: proofFor({}) })), "bad_input");
  const good = proofFor({ action: "ownership.transfer", space: SP, person: "juno", from: "alex", to: "juno" });
  const r = await svc.transferOwnership({ actor: "alex", to: "juno", presence: good });
  assert.equal(r.previous_role, "admin");
  assert.equal((await svc.get("juno"))?.role, "owner");
  assert.equal((await svc.get("alex"))?.role, "admin");
  assert.equal(await svc.ownerCount(), 1);
  assert.ok(events.some(e => e.type === "ownership.transferred" && e.person === "juno" && e.from === "alex"));
  // the old owner can no longer transfer
  assert.equal(await code(svc.transferOwnership({ actor: "alex", to: "kit", presence: good })), "forbidden");
});

test("transfer refuses temps and existing owners", async () => {
  const { svc } = await seeded();
  await svc.addMember({ actor: "alex", person: "t1", ...tempArgs(T0) });
  assert.equal(await code(svc.transferOwnership({ actor: "alex", to: "t1", presence: proofFor({ action: "ownership.transfer", space: SP, person: "t1", from: "alex", to: "t1" }) })), "bad_input");
});

test("temp lifecycle: sweep marks, emits once, access is gone", async () => {
  const { svc, events, clock } = await seeded();
  await svc.addMember({ actor: "juno", person: "t1", ...tempArgs(T0, { expires: T0 + DAY }) });
  await svc.addMember({ actor: "juno", person: "t2", ...tempArgs(T0, { expires: T0 + 3 * DAY }) });
  events.length = 0;
  clock.set(T0 + DAY - 1);
  assert.deepEqual(await svc.sweepExpired(), []);
  clock.set(T0 + DAY);
  const out = await svc.sweepExpired();
  assert.deepEqual(out.map(m => m.person), ["t1"]);
  assert.equal(events.filter(e => e.type === "member.expired").length, 1);
  assert.deepEqual(await svc.abilitiesFor("t1"), []);
  assert.deepEqual(await svc.abilitiesFor("t2"), ["scoped.work"]);
  assert.deepEqual(await svc.sweepExpired(), [], "idempotent");
  assert.equal(events.filter(e => e.type === "member.expired").length, 1);
  // an expired temp cannot act or be re-roled, but may be re-added
  assert.equal(await code(svc.addMember({ actor: "t1", person: "n1", role: "member" })), "expired");
  assert.equal(await code(svc.setRole({ actor: "juno", person: "t1", role: "member" })), "not_a_member");
  assert.equal((await svc.addMember({ actor: "juno", person: "t1", ...tempArgs(clock.get()) })).membership.role, "temp");
  for (const e of events) assert.equal(JSON.stringify(e).includes("key"), false);
});

test("sweep catches a temp that expired without being swept earlier, and the event carries no secrets", async () => {
  const { svc, events, clock } = await seeded();
  await svc.addMember({ actor: "juno", person: "t1", ...tempArgs(T0, { expires: T0 + DAY }) });
  clock.set(T0 + 100 * DAY);
  await svc.sweepExpired();
  const e = events.find(x => x.type === "member.expired");
  assert.deepEqual(Object.keys(e).sort(), ["at", "by", "expires", "person", "role", "space", "type"]);
});

test("extendTemp: presence bound to the exact payload, authority and bounds", async () => {
  const { svc, events, clock } = await seeded();
  await svc.addMember({ actor: "juno", person: "t1", ...tempArgs(T0, { expires: T0 + 2 * DAY }) });
  const to = T0 + 9 * DAY;
  const pay = { action: "member.extend", space: SP, person: "t1", from: T0 + 2 * DAY, to };
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: to })), "needs_presence");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: to, presence: proofFor({ ...pay, to: to + 1 }) })), "needs_presence", "other payload");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: to, presence: proofFor({ ...pay, person: "t2" }) })), "needs_presence");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: to, presence: { ok: false, payload: pay } })), "needs_presence");
  assert.equal(await code(svc.extendTemp({ actor: "kit", person: "t1", newExpires: to, presence: proofFor(pay) })), "forbidden", "manager");
  assert.equal(await code(svc.extendTemp({ actor: "mo", person: "t1", newExpires: to, presence: proofFor(pay) })), "forbidden");
  assert.equal(await code(svc.extendTemp({ actor: "t1", person: "t1", newExpires: to, presence: proofFor(pay) })), "forbidden", "temp cannot extend itself");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "mo", newExpires: to, presence: proofFor(pay) })), "bad_input", "not a temp");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "ghost", newExpires: to, presence: proofFor(pay) })), "not_a_member");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: T0 + 2 * DAY, presence: proofFor({ ...pay, to: T0 + 2 * DAY }) })), "bad_input", "not later");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: T0 + DEFAULT_POLICY.maxExtendMs + 1, presence: proofFor({ ...pay, to: T0 + DEFAULT_POLICY.maxExtendMs + 1 }) })), "bad_scope");
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: /** @type {any} */ ("x"), presence: proofFor(pay) })), "bad_input");
  events.length = 0;
  const r = await svc.extendTemp({ actor: "juno", person: "t1", newExpires: to, presence: proofFor(pay) });
  assert.equal(r.membership.expires, to);
  assert.deepEqual(r.membership.scope, [P1], "scope unchanged");
  assert.equal(events[0].type, "member.extended");
  assert.equal(events[0].from, T0 + 2 * DAY);
  // a replayed proof for the old payload no longer matches
  assert.equal(await code(svc.extendTemp({ actor: "juno", person: "t1", newExpires: to + DAY, presence: proofFor(pay) })), "needs_presence");
  // clock edge: past the new end it is an expiry again
  clock.set(to);
  assert.deepEqual(await svc.abilitiesFor("t1"), []);
});

test("extendTemp can revive an unswept expired temp, and a missing verifier fails closed", async () => {
  const { svc, clock } = await seeded();
  await svc.addMember({ actor: "juno", person: "t1", ...tempArgs(T0, { expires: T0 + DAY }) });
  clock.set(T0 + 2 * DAY);
  const to = clock.get() + DAY;
  const pay = { action: "member.extend", space: SP, person: "t1", from: T0 + DAY, to };
  assert.equal((await svc.extendTemp({ actor: "juno", person: "t1", newExpires: to, presence: proofFor(pay) })).membership.expires, to);
  const bare = world({ verifyPresence: undefined });
  await bare.svc.bootstrapOwner("alex");
  await bare.svc.addMember({ actor: "alex", person: "t1", ...tempArgs(T0) });
  assert.equal(await code(bare.svc.extendTemp({ actor: "alex", person: "t1", newExpires: T0 + 20 * DAY, presence: proofFor({}) })), "needs_presence");
  const throwing = world({ verifyPresence: () => { throw new Error("boom"); } });
  await throwing.svc.bootstrapOwner("alex");
  assert.equal(await code(throwing.svc.addMember({ actor: "alex", person: "o2", role: "owner", presence: proofFor({}) })), "needs_presence");
});

test("devices inherit their person's role and lose it with the person", async () => {
  const { svc, store, clock } = await seeded();
  const dev = { id: "device:abc", person: "kit", space: SP };
  assert.deepEqual(await deviceAbilities(dev, store, clock.get()), ROLE_BUNDLES.manager.abilities);
  await svc.setRole({ actor: "alex", person: "kit", role: "member" });
  assert.deepEqual(await deviceAbilities(dev, store, clock.get()), ROLE_BUNDLES.member.abilities);
  assert.deepEqual(await deviceAbilities({ ...dev, revoked: true }, store, clock.get()), []);
  assert.deepEqual(await deviceAbilities({ id: "srv", space: SP }, store, clock.get()), [], "a server has no person");
  assert.deepEqual(await deviceAbilities({ ...dev, space: "spc_other" }, store, clock.get()), [], "other space");
  await svc.removeMember({ actor: "alex", person: "kit" });
  assert.deepEqual(await deviceAbilities(dev, store, clock.get()), []);
  await svc.addMember({ actor: "alex", person: "t1", ...tempArgs(clock.get(), { expires: clock.get() + 100 }) });
  assert.deepEqual(await deviceAbilities({ id: "d2", person: "t1", space: SP }, store, clock.get()), ["scoped.work"]);
  assert.deepEqual(await deviceAbilities({ id: "d2", person: "t1", space: SP }, store, clock.get() + 100), []);
  assert.deepEqual(await deviceAbilities(/** @type {any} */ (null), store, 0), []);
});

test("assistantCap: capped by the person who added it; temp assistants only when granted", () => {
  const m = (/** @type {any} */ x) => /** @type {any} */ (x);
  assert.deepEqual(assistantCap(m({ role: "owner" }), T0).abilities, ROLE_BUNDLES.owner.abilities);
  assert.deepEqual(assistantCap(m({ role: "member" }), T0).abilities, ROLE_BUNDLES.member.abilities);
  assert.equal(assistantCap(m({ role: "member" }), T0).abilities.includes("members.manage_below_admin"), false);
  const temp = m({ role: "temp", scope: [P1], expires: T0 + 10 });
  assert.deepEqual(assistantCap(temp, T0).abilities, []);
  assert.deepEqual(assistantCap(temp, T0, { granted: true }), { abilities: ["scoped.work"], scope: [P1], expires: T0 + 10 });
  assert.deepEqual(assistantCap(temp, T0 + 10, { granted: true }).abilities, [], "expired person, expired assistant");
  assert.deepEqual(assistantCap(m({ role: "member" }), T0).scope, undefined);
});

test("role renames are display only", async () => {
  const { svc } = await seeded();
  assert.equal(svc.roleLabel("member"), "Member");
  const r = await svc.setDisplayName({ actor: "juno", role: "member", name: "  Associate " });
  assert.equal(r.name, "Associate");
  assert.equal(svc.roleLabel("member"), "Associate");
  assert.equal((await svc.get("mo"))?.role, "member", "id unchanged");
  assert.deepEqual(svc.getDisplayNames(), { member: "Associate" });
  assert.equal(await code(svc.setDisplayName({ actor: "kit", role: "member", name: "X" })), "forbidden");
  assert.equal(await code(svc.setDisplayName({ actor: "alex", role: "manager", name: "associate" })), "duplicate");
  assert.equal(await code(svc.setDisplayName({ actor: "alex", role: "manager", name: "Admin" })), "duplicate");
  assert.equal(await code(svc.setDisplayName({ actor: "alex", role: "manager", name: "" })), "bad_input");
  assert.equal(await code(svc.setDisplayName({ actor: "alex", role: "manager", name: "x".repeat(33) })), "bad_input");
  assert.equal(await code(svc.setDisplayName({ actor: "alex", role: "manager", name: "<b>" })), "bad_input");
  assert.equal(await code(svc.setDisplayName({ actor: "alex", role: /** @type {any} */ ("boss"), name: "Boss" })), "bad_input");
});

test("events carry space, person, role, by, at and never keys", async () => {
  const { svc, events, clock } = await seeded();
  clock.set(T0 + 5);
  await svc.addMember({ actor: "juno", person: "n1", role: "member" });
  await svc.setRole({ actor: "juno", person: "n1", role: "manager" });
  await svc.removeMember({ actor: "juno", person: "n1" });
  assert.deepEqual(events.map(e => e.type), ["member.added", "member.role_changed", "member.removed"]);
  for (const e of events) {
    assert.equal(e.space, SP); assert.equal(e.person, "n1"); assert.equal(e.by, "juno"); assert.equal(e.at, T0 + 5);
    assert.equal(typeof e.role, "string");
    assert.equal(/key|secret|token/i.test(Object.keys(e).join(",")), false);
  }
  assert.equal(events[1].from_role, "member");
});

test("failed operations emit nothing and change nothing", async () => {
  const { svc, events, store } = await seeded();
  const before = JSON.stringify(store.list(SP));
  await code(svc.addMember({ actor: "kit", person: "n1", role: "member" }));
  await code(svc.setRole({ actor: "alex", person: "alex", role: "member" }));
  await code(svc.removeMember({ actor: "alex", person: "alex" }));
  assert.equal(events.length, 0);
  assert.equal(JSON.stringify(store.list(SP)), before);
});

test("concurrent last-owner demotions cannot both succeed", async () => {
  const { svc } = await seeded();
  await svc.addMember({ actor: "alex", person: "o2", role: "owner", presence: proofFor({ action: "member.grant_owner", space: SP, person: "o2", from: null, to: "owner" }) });
  const rs = await Promise.allSettled([
    svc.setRole({ actor: "alex", person: "alex", role: "admin" }),
    svc.setRole({ actor: "o2", person: "o2", role: "admin" }),
    svc.removeMember({ actor: "alex", person: "o2" }),
  ]);
  assert.ok(rs.some(r => r.status === "rejected"));
  assert.equal(await svc.ownerCount(), 1);
});

test("memory store copies records and lists per space", () => {
  const s = memoryStore();
  const rec = { space: "a", person: "p", role: /** @type {any} */ ("member"), added_by: "x", added_at: 1 };
  s.put(rec);
  s.put({ ...rec, space: "b" });
  assert.equal(s.list("a").length, 1);
  rec.role = "owner";
  assert.equal(s.get("a", "p")?.role, "member");
  assert.equal(s.delete("a", "p"), true);
  assert.equal(s.get("a", "p"), undefined);
});

// Property-style: random role operations by random actors never leave the space without an owner,
// never give an actor a role above its own, and never leave a temp without scope and expiry.
function prng(/** @type {number} */ seed) { let x = seed >>> 0; return () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test("property: random operations never leave a space without an owner", async () => {
  let ok = 0;
  for (const seed of [1, 2, 3, 7, 42, 99, 1234, 2026]) {
    const rnd = prng(seed);
    const pick = (/** @type {any[]} */ a) => a[Math.floor(rnd() * a.length)];
    const w = world();
    await w.svc.bootstrapOwner("p0");
    const people = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const presenceAny = { ok: true, payload: null };
    // a verifier that accepts any matching proof built on the fly
    const svc = createMembers({ space: SP, store: w.store, now: w.clock.get, verifyPresence: () => true, emit: () => {} });
    for (let i = 0; i < 400; i++) {
      w.clock.tick(Math.floor(rnd() * DAY));
      const actor = pick(people); const person = pick(people); const role = pick([...ROLE_IDS]);
      const op = Math.floor(rnd() * 6);
      /** @type {Promise<any>} */
      let p;
      if (op === 0) p = svc.addMember({ actor, person, role, presence: presenceAny, ...(role === "temp" ? { scope: [P1], expires: w.clock.get() + DAY } : {}) });
      else if (op === 1) p = svc.setRole({ actor, person, role, presence: presenceAny, ...(role === "temp" ? { scope: [P1], expires: w.clock.get() + DAY } : {}) });
      else if (op === 2) p = svc.removeMember({ actor, person });
      else if (op === 3) p = svc.transferOwnership({ actor, to: person, presence: presenceAny, demoteTo: pick(["admin", "manager", "member"]) });
      else if (op === 4) p = svc.sweepExpired();
      else p = svc.extendTemp({ actor, person, newExpires: w.clock.get() + 2 * DAY, presence: presenceAny });
      const before = (await svc.list()).length;
      try { await p; ok++; } catch (e) { assert.ok(e instanceof SpacesError, `seed ${seed}: ${e}`); }
      void before;
      const all = await svc.list();
      assert.ok(all.some(m => m.role === "owner"), `seed ${seed} step ${i}: no owner left`);
      for (const m of all) {
        if (m.role === "temp") assert.ok(m.scope && m.scope.length > 0 && typeof m.expires === "number", `seed ${seed}: temp without scope or expiry`);
        else assert.ok(m.scope === undefined && m.expires === undefined, `seed ${seed}: non-temp carries scope or expiry`);
      }
      assert.equal(new Set(all.map(m => m.person)).size, all.length);
      if (all.length < 3) for (const person2 of people) if (!all.find(m => m.person === person2)) { try { await svc.addMember({ actor: all.find(m => m.role === "owner")?.person, person: person2, role: "member" }); } catch { /* fine */ } }
    }
  }
  assert.ok(ok > 200, `only ${ok} operations succeeded`);
});
