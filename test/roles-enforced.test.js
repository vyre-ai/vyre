// @ts-check
// The five roles are enforced by the REAL kernel's grants, not by a label: each role's bundle (kernel/contracts ROLE_BUNDLES, what the role is FOR) is checked against what
// the kernel's authorize answers for a person holding it (kernel/grants/roles.js ROLE_ACTIONS, what carries it). A temp member reaches only its scope and loses everything on
// time, with no sweep needed. Runs on the real kernel through test/kernel-rig.js; no network, no clock but the one injected here.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "./kernel-rig.js";
import { ROLE_BUNDLES, ROLE_IDS } from "../kernel/contracts/index.js";
import { ROLE_ACTIONS } from "../kernel/grants/roles.js";
import { CONTACT } from "../kernel/conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa";
let T = 1_800_000_000_000;
const clock = () => ++T;
const PEOPLE = { owner: "per_alex", admin: "per_adm", manager: "per_man", member: "per_mem", temp: "per_tmp" };
const u = (/** @type {string} */ type, id = "probe") => `vyre://${SPACE}/${type}/${id}`;
// the resource each action is asked about
const RESOURCE = { "checkpoint.write": u("checkpoint", "s1"), "checkpoint.read": u("checkpoint", "s1"), "records.read": u("contact", "c1"), "records.create": u("contact", "c1"), "records.update": u("contact", "c1"), "records.remove": u("contact", "c1"), "records.restore": u("contact", "c1"),
  "records.define": u("definition", "types"), "seal.put": u("contact", "c1"), "tasks.request": u("task"), "tasks.read": u("contact", "c1"), "tasks.work": u("contact", "c1"),
  "grants.role": u("member", "per_x"), "grants.invite": u("invite"), "grants.create": u("grant", "new"), "grants.revoke": u("grant"), "grants.narrow": u("grant"),
  "grants.offer": u("grant"), "events.read": u("event"), "tasks.decide": u("task"), "drive.restore": u("drive", "x"), "drive.read": u("drive", "x"), "drive.write": u("drive", "x"), "grants.unoffer": u("grant"), "rules.remove": u("rule"), "rules.accept": u("rule"), "rules.dismiss": u("rule"),
  "kits.propose": u("kit", "estate"), "kits.install": u("kit", "estate"), "kits.remove": u("kit", "estate"), "rules.set": u("rule"), "rules.get": u("rule"), "rules.test": u("rule"), "rules.enable": u("rule"), "rules.disable": u("rule"), "rules.propose": u("rule"), "rules.list": u("rule"), "grants.list": u("member", "per_x") };

async function world() {
  const rig = await createRig({ space: SPACE, clock, people: { per_adm: "admin", per_man: "manager", per_mem: "member" }, defs: [CONTACT] });
  const exp = T + 3_600_000;
  await rig.addTemp("per_tmp", [u("contact", "*")], exp);
  const chain = (/** @type {string} */ role) => (role === "owner" ? rig.ownerChain : rig.person(PEOPLE[/** @type {"owner"} */ (role)]));
  const held = async (/** @type {string} */ role, /** @type {string} */ action, resource = RESOURCE[/** @type {"records.read"} */ (action)]) => (await rig.k.gateway.authorize({ chain: chain(role), action, resource })).effect !== "deny";
  return { rig, exp, chain, held };
}

test("roles: what the kernel grants each role is exactly its table, and the table matches what the role is for", async () => {
  const { held } = await world();
  const every = [...new Set(Object.values(ROLE_ACTIONS).flat())];
  for (const role of ROLE_IDS) for (const action of every) {
    // a temp member holds an action only inside its scope: contact records here
    const should = ROLE_ACTIONS[/** @type {"owner"} */ (role)].includes(action) && (role !== "temp" || RESOURCE[/** @type {"records.read"} */ (action)].includes("/contact/"));
    assert.equal(await held(role, action), should, `${role} ${action}`);
  }
  // bundle against table: an ability the bundle names is carried by a real action, and one it forbids is not
  const carries = { "customize.definitions": "records.define", "members.manage_below_admin": "grants.role", "members.manage_all": "grants.role", "projects.work_member_of": "records.create" };
  for (const role of ROLE_IDS) for (const [ability, action] of Object.entries(carries)) {
    const b = ROLE_BUNDLES[role];
    if (ability === "members.manage_all") continue; // owner-only by MAY_SET (below), not by the action
    if (b.never.includes(ability)) assert.equal(await held(role, action), false, `${role} must not have ${action} (never ${ability})`);
    if (b.abilities.includes(ability) && role !== "temp") assert.equal(await held(role, action), true, `${role} should have ${action} (${ability})`);
  }
  // a manager changes no types: that is Customize, which is admin and owner
  assert.equal(await held("manager", "records.define"), false);
  assert.equal(await held("admin", "records.define"), true);
});

test("roles: who may make whom, by the kernel: an owner any role, an admin the roles below admin, nobody else anyone", async () => {
  const { rig, chain } = await world();
  const set = (/** @type {string} */ by, /** @type {string} */ role, person = "per_new") => {
    const r = { person, role };
    return rig.k.gateway.grants.setRole(chain(by), r, { presence: rig.proof("grants.role", r, u("member", person)) });
  };
  await set("owner", "admin", "per_a2");
  await set("admin", "manager", "per_m2");
  for (const role of ["owner", "admin"]) await assert.rejects(() => set("admin", role), e => e.code === "not_allowed" || e.code === "not_found", `an admin makes no ${role}`);
  for (const by of ["manager", "member", "temp"]) for (const role of ["member", "manager", "admin", "owner"]) await assert.rejects(() => set(by, role), e => e.code === "not_allowed" || e.code === "not_found", `a ${by} makes no ${role}`);
  await assert.rejects(() => set("admin", "member", PEOPLE.owner), e => e.code === "not_allowed" || e.code === "not_found", "an admin cannot demote the owner");
});

test("temp: only inside its scope, and everything ends at the expiry with no sweep; extending brings it back; it cannot extend itself", async () => {
  const { rig, exp, held, chain } = await world();
  const read = (/** @type {string} */ r) => rig.k.gateway.authorize({ chain: chain("temp"), action: "records.read", resource: r });
  assert.equal((await read(u("contact", "c1"))).effect, "allow", "inside the scope");
  assert.equal((await read(u("matter", "m1"))).effect, "deny", "outside the scope, which a member can read");
  assert.equal(await held("member", "records.read", u("matter", "m1")), true);
  for (const a of ["records.remove", "tasks.request", "grants.offer", "records.define", "grants.role", "grants.invite"]) assert.equal(await held("temp", a, a === "grants.offer" ? u("grant") : undefined), false, `a temp never has ${a}`);
  // the clock reaches the expiry: no sweep ran, and the answer is already no
  T = exp - 5000;
  assert.equal((await read(u("contact", "c1"))).effect, "allow", "just before");
  T = exp + 1;
  const after = await read(u("contact", "c1"));
  assert.equal(after.effect, "deny", "at the expiry");
  for (const a of ["records.create", "records.update", "tasks.read", "tasks.work"]) assert.equal(await held("temp", a, u("contact", "c1")), false, `${a} ends too`);
  assert.equal((await rig.k.gateway.grants.members.list(rig.ownerChain)).some((/** @type {any} */ m) => m.person === "per_tmp"), false, "the member list does not show an expired temp");
  // a temp cannot make or extend its own membership
  const r = { person: "per_tmp", role: "temp", scope: [u("contact", "*")], expires: T + 10_000_000 };
  await assert.rejects(() => rig.k.gateway.grants.setRole(chain("temp"), r, { presence: rig.proof("grants.role", r, u("member", "per_tmp")) }), e => e.code === "not_allowed" || e.code === "not_found");
  // the owner extends it: access comes back, still only in scope
  await rig.addTemp("per_tmp", [u("contact", "*")], T + 3_600_000);
  assert.equal((await read(u("contact", "c1"))).effect, "allow", "extended");
  assert.equal((await read(u("matter", "m1"))).effect, "deny");
});

test("kits: owner and admin hold kits.propose, kits.install and kits.remove; manager, member and temp hold none; an assistant acting for an owner may propose and never install or remove", async () => {
  const { rig, held } = await world();
  const res = u("kit", "estate");
  for (const action of ["kits.propose", "kits.install", "kits.remove"]) {
    for (const role of ["owner", "admin"]) assert.equal(await held(role, action, res), true, `${role} ${action}`);
    for (const role of ["manager", "member", "temp"]) assert.equal(await held(role, action, res), false, `${role} ${action}`);
  }
  const asst = rig.k.chains.fromFacts({ kind: "agent_session", vouched: true, person: "per_alex", agent: "assistant", session: "s1" });
  const can = async (/** @type {string} */ action) => rig.k.gateway.authorize({ chain: asst, action, resource: res });
  assert.equal((await can("kits.propose")).effect, "allow", "the assistant for an owner may ask for a Kit");
  for (const action of ["kits.install", "kits.remove"]) assert.notEqual((await can(action)).effect, "allow", `the assistant may not ${action}`);
});
