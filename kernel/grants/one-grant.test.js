// @ts-check
// Step A of the one grant model (team/0.3.1/DESIGN-one-grant.md): access levels, teams as a grant subject (assistants by association, never more than the person), and the
// origin a login is lent for. On the real grants store and authorizer.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../gateway/index.js";
import { createGrantsStore } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { containsDims } from "../core/authorize.js";
import { canonical, sha256 } from "../core/canonical.js";
import { ACCESS_LEVELS, AGENT_ACTIONS, levelActions, levelOf, SURFACE_GROUPS } from "../seal/uses.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ALICE = "per_alice", BOB = "per_bob", CAROL = "per_carol";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const personChain = (/** @type {string} */ who) => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
const assistantOf = (/** @type {string} */ who, name = "kit") => chains.fromFacts({ kind: "agent_session", agent: name, person: who, session: "s", thread: "t", vouched: true });
const actor = (/** @type {string} */ kind, /** @type {string} */ id) => ({ kind, id, space: SPACE });

const used = new Set();
const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.op === op && canonical(proof.fields) === canonical(fields) && !used.has(proof.n) && (used.add(proof.n), true) ? null : "wrong_payload") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const P = {
  create: (/** @type {any} */ input) => ({ presence: proof("grants.create", input, `vyre://${SPACE}/grant/new`) }),
  role: (/** @type {any} */ m) => ({ presence: proof("grants.role", m, `vyre://${SPACE}/member/${m.person || m.remove}`) }),
  actor: (/** @type {any} */ a) => ({ presence: proof("grants.role", { actor: a }, `vyre://${SPACE}/member/${a.id}`) }),
};
async function rig() {
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, key: Buffer.alloc(32, 5), presence });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => true });
  await gs.bootstrap({ owner: OWNER });
  for (const who of [ALICE, BOB, CAROL]) await gw.grants.setRole(owner(), { person: who, role: "member" }, P.role({ person: who, role: "member" }));
  return { gw, gs, log, g: gw.grants };
}
const vault = (id = "v1") => `vyre://${SPACE}/vault/${id}`;
const item = (id = "v1", name = "stripe") => `vyre://${SPACE}/vault/${id}/item/${name}`;
const give = (/** @type {any} */ g, /** @type {any} */ subject, /** @type {string} */ level, over = {}) => {
  const i = { subject, actions: [...levelActions(level)], resource: { prefix: `${vault()}/*` }, conditions: {}, source: "vault:share", ...over };
  return g.create(owner(), i, P.create(i));
};
const ask = (/** @type {any} */ gw, /** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, extra = {}) => gw.authorize({ chain, action, resource, ...extra });

test("levels: use is fill, totp, read and call; reveal adds the value; manage adds change and share; an assistant holds use only", () => {
  assert.deepEqual([...ACCESS_LEVELS.use], ["vault.fill", "vault.totp", "vault.read", "vault.call"]);
  assert.ok(ACCESS_LEVELS.reveal.includes("vault.reveal") && !ACCESS_LEVELS.use.includes("vault.reveal"));
  for (const a of ["vault.edit", "vault.delete", "vault.share", "vault.rotate", "grants.create"]) assert.ok(ACCESS_LEVELS.manage.includes(a) && !ACCESS_LEVELS.reveal.includes(a), a);
  assert.ok(!Object.values(ACCESS_LEVELS).some(l => l.includes("vault.run")), "run is its own grant");
  assert.deepEqual([...AGENT_ACTIONS], [...ACCESS_LEVELS.use]);
  assert.equal(levelOf([...ACCESS_LEVELS.reveal]), "reveal");
  assert.equal(levelOf(["vault.fill"]), null);
  assert.throws(() => levelActions("admin"), { code: "bad_input" });
});

test("teams: an owner makes one, a grant to it reaches its people and nobody else, and removing a person ends it at the next call", async () => {
  const { gw, g, gs } = await rig();
  await assert.rejects(() => g.teams.set(personChain(BOB), { name: "Billing", members: [ALICE] }), e => ["not_found", "not_allowed"].includes(e.code));
  const team = await g.teams.set(owner(), { name: "Billing", members: [ALICE, BOB] });
  assert.match(team.id, /^team_/);
  await assert.rejects(() => g.teams.set(owner(), { name: "billing", members: [] }), { code: "exists" });
  await assert.rejects(() => g.teams.set(owner(), { name: "Ghosts", members: ["per_nobody"] }), { code: "bad_input" });
  await give(g, { kind: "group", id: team.id }, "use");
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", item())).effect, "allow");
  assert.equal((await ask(gw, personChain(BOB), "vault.fill", item())).effect, "allow");
  assert.equal((await ask(gw, personChain(CAROL), "vault.read", item())).effect, "deny", "not in the team");
  assert.equal((await ask(gw, personChain(ALICE), "vault.reveal", item())).effect, "deny", "use is not reveal");
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", item("v2"))).effect, "deny", "another vault");
  await g.teams.set(owner(), { id: team.id, members: [BOB] });
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", item())).effect, "deny", "taken out of the team");
  assert.equal((await ask(gw, personChain(BOB), "vault.read", item())).effect, "allow");
  assert.deepEqual(g.teams.list(personChain(CAROL)), [], "a member sees only the teams they are in");
  assert.equal(g.teams.list(personChain(BOB)).length, 1);
  await assert.rejects(() => give(g, { kind: "group", id: "team_nope" }, "use"), { code: "bad_input" });
  assert.ok(gs);
});

test("teams: an assistant reaches a team's grant by association with a person in it, with use only, and never more than that person", async () => {
  const { gw, g } = await rig();
  const team = await g.teams.set(owner(), { name: "Billing", members: [ALICE] });
  await give(g, { kind: "group", id: team.id }, "manage");
  // the person holds manage; her assistant holds only what an assistant may: use
  assert.equal((await ask(gw, personChain(ALICE), "vault.reveal", item())).effect, "allow", "the person holds manage, which includes reveal");
  await g.addActor(owner(), actor("agent", "kit"), P.actor(actor("agent", "kit")));
  const kit = assistantOf(ALICE);
  assert.equal((await ask(gw, kit, "vault.read", item())).effect, "allow", "the assistant uses a team vault key");
  for (const a of ["vault.reveal", "vault.edit", "vault.delete", "vault.share", "vault.rotate"]) assert.notEqual((await ask(gw, kit, a, item())).effect, "allow", `${a} is a person's`);
  // an assistant of a person who is not in the team has nothing
  assert.equal((await ask(gw, assistantOf(BOB), "vault.read", item())).effect, "deny");
  // a team grant given to a person who then leaves the team takes the assistant's use with it
  await g.teams.set(owner(), { id: team.id, members: [] });
  assert.equal((await ask(gw, kit, "vault.read", item())).effect, "deny");
});

test("an assistant is never given reveal, change, delete, share or rotate, whoever asks", async () => {
  const { g } = await rig();
  for (const level of ["reveal", "manage"]) {
    const i = { subject: { kind: "actor", actor: actor("agent", "kit") }, actions: [...levelActions(level)], resource: { prefix: `${vault()}/*` }, conditions: {}, source: "vault:share" };
    await assert.rejects(() => g.create(owner(), i, P.create(i)), { code: "bad_input" }, level);
  }
  const ok = { subject: { kind: "actor", actor: actor("agent", "kit") }, actions: [...levelActions("use")], resource: { prefix: `${vault()}/*` }, conditions: {}, source: "vault:share" };
  assert.equal((await g.create(owner(), ok, P.create(ok))).status, "active");
});

test("origins: a login lent for a site is used only at that origin, exactly, and a narrower grant can only shrink the list", async () => {
  const { gw, g } = await rig();
  const mk = (/** @type {string[]} */ origins) => give(g, { kind: "actor", actor: actor("person", ALICE) }, "use", { actions: ["vault.fill"], conditions: { where: { origins } } });
  const parent = await mk(["https://app.stripe.com"]);
  assert.equal((await ask(gw, personChain(ALICE), "vault.fill", item(), { origin: "https://app.stripe.com" })).effect, "allow");
  for (const o of ["https://app.stripe.com:8443", "http://app.stripe.com", "https://app.stripe.com.evil.example", "https://evil.example", undefined]) {
    assert.equal((await ask(gw, personChain(ALICE), "vault.fill", item(), o ? { origin: o } : {})).effect, "deny", String(o));
  }
  // narrowing may only shrink the list: a child lent for some of the parent's origins is inside it; one that adds an origin, names another or drops the condition is not
  const gr = (/** @type {string[] | undefined} */ origins) => ({ space: SPACE, subject: { kind: "actor", actor: actor("person", ALICE) }, actions: ["vault.fill"], action_set_version: 1, resource: { prefix: item() }, conditions: origins ? { where: { origins } } : {} });
  const [a, b, c] = ["https://app.stripe.com", "https://dashboard.stripe.com", "https://evil.example"];
  assert.equal(containsDims(gr([a, b]), gr([a])), true);
  assert.equal(containsDims(gr([a, b]), gr([a, b])), true);
  assert.equal(containsDims(gr([a]), gr([a, b])), false, "a longer list");
  assert.equal(containsDims(gr([a]), gr([c])), false, "another origin");
  assert.equal(containsDims(gr([a]), gr(undefined)), false, "no condition at all");
  assert.ok(parent.id);
});

test("a pass for an outside agent is a grant: it sees only its items, use only; a revoked pass opens nothing; reveal on a pass is refused to the agent and never asks it", async () => {
  const { gw, g } = await rig();
  const v = await g.vaults.set(owner(), { name: "Client: Northwind" });
  const base = `vyre://${SPACE}/vault/${v.id}`, a = `${base}/item/stripe`, b = `${base}/item/mailgun`;
  const ext = actor("agent", "ext_p1");
  await g.addActor(owner(), ext, P.actor(ext));
  const pass = await give(g, { kind: "actor", actor: ext }, "use", { resource: { prefix: a }, source: "pass:p1" });
  const outsider = assistantOf(OWNER, "ext_p1");
  for (const act of ["vault.fill", "vault.totp", "vault.read"]) assert.equal((await ask(gw, outsider, act, a)).effect, "allow", act);
  assert.equal((await ask(gw, outsider, "vault.read", b)).effect, "deny", "an item that is not on the pass");
  assert.equal((await ask(gw, outsider, "vault.read", `${base}/item/stripe-live`)).effect, "deny", "not a longer name either");
  assert.notEqual((await ask(gw, outsider, "vault.reveal", a)).effect, "allow", "use is not reveal");
  assert.notEqual((await ask(gw, outsider, "vault.edit", a)).effect, "allow");
  // a pass cannot be made to show a value: the grant is refused, whoever asks
  const wide = { subject: { kind: "actor", actor: ext }, actions: [...levelActions("reveal")], resource: { prefix: a }, conditions: {}, source: "pass:p1" };
  await assert.rejects(() => g.create(owner(), wide, P.create(wide)), { code: "bad_input" });
  // revoking the pass opens nothing, and what was handed on from it goes too
  await g.revoke(owner(), pass.id, "pass ended", { presence: proof("grants.revoke", { id: pass.id, reason: "pass ended" }, `vyre://${SPACE}/grant/${pass.id}`) });
  assert.equal((await ask(gw, outsider, "vault.read", a)).effect, "deny");
});

test("vault.call under a use grant is still held for a yes: use never turns an API write into a free act", async () => {
  const { gw, g } = await rig();
  const v = await g.vaults.set(owner(), { name: "Client: Northwind" });
  const it = `vyre://${SPACE}/vault/${v.id}/item/stripe`;
  await give(g, { kind: "actor", actor: actor("person", ALICE) }, "use", { resource: { prefix: it } });
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", it)).effect, "allow");
  const call = await ask(gw, personChain(ALICE), "vault.call", it);
  assert.equal(call.effect, "ask", "an outward act waits for a person");
  assert.ok(call.obligations.some((/** @type {any} */ o) => o.type === "ask" || o.type === "presence"), "and says what it waits for");
});

test("teams and their grants come back from the log after a restart", async () => {
  const { gw, g, gs } = await rig();
  const team = await g.teams.set(owner(), { name: "Billing", members: [ALICE] });
  await give(g, { kind: "group", id: team.id }, "use");
  await gs.rebuild();
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", item())).effect, "allow");
  assert.equal(g.teams.list(owner()).length, 1);
  await g.teams.remove(owner(), team.id);
  await gs.rebuild();
  assert.deepEqual(g.teams.list(owner()), []);
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", item())).effect, "deny", "a removed team reaches no one");
});

test("named vaults: any member makes one and holds manage on it, shares a part of it as a child grant, and nobody else sees it; a personal vault is its owner's alone", async () => {
  const { gw, g } = await rig();
  const mine = await g.vaults.set(personChain(ALICE), { name: "Client: Northwind" });
  assert.match(mine.id, /^vault_/);
  const v = `vyre://${SPACE}/vault/${mine.id}`, it = `${v}/item/stripe`;
  assert.equal((await ask(gw, personChain(ALICE), "vault.reveal", it)).effect, "allow", "the maker holds manage");
  assert.equal((await ask(gw, personChain(BOB), "vault.read", it)).effect, "deny", "nobody else, until it is shared");
  assert.deepEqual(g.vaults.list(personChain(BOB)), []);
  await assert.rejects(() => g.vaults.set(personChain(ALICE), { name: "client: northwind" }), { code: "exists" });
  await assert.rejects(() => g.vaults.set(personChain(BOB), { id: mine.id, name: "mine now" }), { code: "not_found" }, "not Bob's to rename");
  // share use of it with Bob: a child of Alice's own grant, so it cannot be more than she holds
  const parent = (await g.list(owner())).find(x => x.source === "vault:create");
  const share = { subject: { kind: "actor", actor: actor("person", BOB) }, actions: [...levelActions("use")], resource: { prefix: v }, conditions: {}, source: "vault:share", parent: parent.id };
  const child = await g.create(personChain(ALICE), share, { presence: proof("grants.create", share, v) });
  assert.equal(child.status, "active");
  assert.equal((await ask(gw, personChain(BOB), "vault.read", it)).effect, "allow");
  assert.equal((await ask(gw, personChain(BOB), "vault.reveal", it)).effect, "deny", "use is not reveal");
  assert.deepEqual(g.vaults.list(personChain(BOB)).map(x => x.id), [mine.id], "a vault shared with you is in your list");
  const wide = { ...share, actions: ["records.read"] };
  await assert.rejects(() => g.create(personChain(ALICE), wide, { presence: proof("grants.create", wide, v) }), e => ["not_contained", "not_found"].includes(e.code), "more than she holds");
  // personal: one each, never listed to an admin
  const own = await g.vaults.set(personChain(BOB), { name: "Mine", personal: true });
  await assert.rejects(() => g.vaults.set(personChain(BOB), { name: "Again", personal: true }), { code: "exists" });
  assert.deepEqual(g.vaults.list(owner()).map(x => x.id), [], "the owner of the Space does not see a member's vaults");
  assert.equal((await ask(gw, personChain(CAROL), "vault.read", `vyre://${SPACE}/vault/${own.id}/item/x`)).effect, "deny");
  // removing the vault takes the share with it
  await g.vaults.remove(personChain(ALICE), mine.id);
  assert.equal((await ask(gw, personChain(BOB), "vault.read", it)).effect, "deny");
  assert.deepEqual(g.vaults.list(personChain(ALICE)), []);
});

test("a project's people and assistants are a group read from its reach grants: one grant to project:<id> lets them use a vault, and the person's own key is still needed", async () => {
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, key: Buffer.alloc(32, 5), presence, projectExists: async (/** @type {string} */ id) => id === "northwind" });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => true });
  await gs.bootstrap({ owner: OWNER });
  for (const who of [ALICE, BOB]) await gw.grants.setRole(owner(), { person: who, role: "member" }, P.role({ person: who, role: "member" }));
  await gw.grants.addActor(owner(), actor("agent", "kit"), P.actor(actor("agent", "kit")));
  // who is on the project is who holds reach on its record's address: Alice by a grant of her own, the project's assistant by the agent reach grant
  const reach = (/** @type {any} */ subject) => { const i = { subject, actions: ["project.reach"], resource: { prefix: `vyre://${SPACE}/project/northwind` }, conditions: {}, source: "projects:reach" }; return gw.grants.create(owner(), i, P.create(i)); };
  const alice = await reach({ kind: "actor", actor: actor("person", ALICE) });
  await reach({ kind: "actor", actor: actor("agent", "kit") });
  const v = await gw.grants.vaults.set(owner(), { name: "Client: Northwind" });
  const base = `vyre://${SPACE}/vault/${v.id}`;
  await assert.rejects(() => give(gw.grants, { kind: "group", id: "project:nope" }, "use", { resource: { prefix: base } }), { code: "bad_input" });
  await give(gw.grants, { kind: "group", id: "project:northwind" }, "use", { resource: { prefix: base } });
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", `${base}/item/k`)).effect, "allow", "a person on the project");
  assert.equal((await ask(gw, personChain(BOB), "vault.read", `${base}/item/k`)).effect, "deny", "not on the project");
  // the project's assistant acting for Alice (on the project) can; acting for Bob (not on it) cannot: both keys
  assert.equal((await ask(gw, assistantOf(ALICE), "vault.read", `${base}/item/k`)).effect, "allow");
  assert.equal((await ask(gw, assistantOf(BOB), "vault.read", `${base}/item/k`)).effect, "deny", "the assistant is on the project, its person is not");
  // and not the owner's personal vault: it was never given
  const personal = await gw.grants.vaults.set(owner(), { name: "Mine", personal: true });
  assert.equal((await ask(gw, assistantOf(ALICE), "vault.read", `vyre://${SPACE}/vault/${personal.id}/item/k`)).effect, "deny");
  // taking the reach away takes the project's vault with it, at the next call
  await gw.grants.revoke(owner(), alice.id, "left the project", { presence: proof("grants.revoke", { id: alice.id, reason: "left the project" }, `vyre://${SPACE}/grant/${alice.id}`) });
  assert.equal((await ask(gw, personChain(ALICE), "vault.read", `${base}/item/k`)).effect, "deny", "off the project");
});

test("carried-over agent logins: one agent, fill, one exact origin, until its expiry; a row already carried or already expired is skipped", async () => {
  const { gw, g, gs } = await rig();
  const prefix = `vyre://${SPACE}/vault/${await gs.personalVault()}/item/harlow-drive`;
  const rows = [
    { id: "ag_one", who: "kit", item: "harlow-drive", origin: "https://app.northwind.test", expires: T + 86400_000 },
    { id: "ag_old", who: "kit", item: "harlow-drive", origin: "https://old.northwind.test", expires: T - 1 },
    { id: "ag_bad", who: "kit", item: "harlow-drive", origin: "https://app.northwind.test/login", expires: null },
  ];
  assert.equal((await gs.carryOver("vault", rows)).length, 1);
  assert.equal((await gs.carryOver("vault", rows)).length, 0, "twice makes one");
  const kit = assistantOf(OWNER);
  assert.equal((await ask(gw, kit, "vault.fill", prefix, { origin: "https://app.northwind.test" })).effect, "allow");
  assert.equal((await ask(gw, kit, "vault.fill", prefix, { origin: "https://old.northwind.test" })).effect, "deny");
  assert.equal((await ask(gw, kit, "vault.reveal", prefix, { origin: "https://app.northwind.test" })).effect, "deny", "fill is not reveal");
  const mine = (await g.list(owner())).filter(x => x.source === "vault:agent");
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].conditions.where.origins, ["https://app.northwind.test"]);
});

test("a Connection is open to a surface by a grant to the group surface:<name>: it reaches chains that came in through that surface, takes no fresh proof to make, and names only the four surfaces", async () => {
  const { gw, g } = await rig();
  const conn = `vyre://${SPACE}/connection/cn_mail`;
  assert.deepEqual(Object.keys(SURFACE_GROUPS), ["capsule", "phone", "chat", "agents"]);
  const open = (/** @type {string} */ name) => g.create(owner(), { subject: { kind: "group", id: `surface:${name}` }, actions: [...levelActions("use")], resource: { prefix: conn }, conditions: {}, source: "vault:connection" });
  await assert.rejects(() => open("fax"), { code: "bad_input" });
  const grant = await open("capsule");
  assert.equal(grant.status, "active", "made on the person's own session, no fresh proof");
  const via = (/** @type {string} */ surface) => chains.fromFacts({ kind: "socket", surface, uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  assert.equal((await ask(gw, via("capsule"), "vault.read", conn)).effect, "allow");
  assert.equal((await ask(gw, via("deck"), "vault.read", conn)).effect, "deny", "another surface");
  assert.equal((await ask(gw, via("capsule"), "vault.read", `vyre://${SPACE}/connection/cn_other`)).effect, "deny", "another connection");
  assert.notEqual((await ask(gw, via("capsule"), "vault.reveal", conn)).effect, "allow", "use, not reveal");
  await g.revoke(owner(), grant.id, "closed", { presence: proof("grants.revoke", { id: grant.id, reason: "closed" }, `vyre://${SPACE}/grant/${grant.id}`) });
  assert.equal((await ask(gw, via("capsule"), "vault.read", conn)).effect, "deny", "taken back");
});
