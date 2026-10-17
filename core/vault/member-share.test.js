// @ts-check
// A member shares one of their own logins with one agent (V3a), against a real grants store and the real Vault, with a stand-in for the member's own vault and for the agent's browser. What it proves: the copy
// lives outside the Space's vault where no tool of the owner's or an admin's can see or open it; it is sealed under its own key; the agent's fill needs the grant every time; and each way a share can end
// (unshare, expiry, the login changed or removed, the member leaving, the grant taken back) deletes or stops the copy at once.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { kernelRig } from "./kernel-rig.js";
import { SaidIntents } from "./said.js";
import { agentFill } from "./agent-fill.js";
import { NOTICE } from "./member-share.js";
import { SCRATCH } from "../../test/scratch.mjs";

const ORIGIN = "https://bank.example.com", OTHER = "https://evil.example";
const BEN = "per_ben", CY = "per_cy";
const PASS = "fixture-member-password-0123456789ab", USER = "ben@personal.example", LABEL = "my-secret-bank-login";

async function world(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-member-share-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  // Who may Ben instruct: juno (he made it; Cy was given Can use) and kit (given Can use); not "team", an agent of others'
  const instructors = (/** @type {string} */ tool, /** @type {any} */ i) => tool !== "agents.instructors" ? undefined
    : i.agent === "juno" ? { data: { level: "edit", made_by: BEN, shares: [CY] } } : i.agent === "kit" ? { data: { level: "use", made_by: "per_ada", shares: [BEN] } } : { error: { code: "not_found", message: "no agent" } };
  const rig = await kernelRig({ people: [BEN, CY], agents: { kit: "agt_kit", juno: "agt_juno", team: "agt_team", assistant: "agt_asst" }, call: instructors });
  const events = /** @type {any[]} */ ([]);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  // the members' own vaults, as a stand-in: Ben is unlocked and holds one login; a locked vault throws
  const items = new Map([[BEN, new Map([[LABEL, { name: LABEL, kind: "login", fields: { username: USER, password: PASS } }], ["a-note", { name: "a-note", kind: "note", fields: { text: "x" } }]])], [CY, new Map()]]);
  let locked = false, lentLocked = false;
  /** What each member lends, as PeopleVaults.lent keeps it (sealed under her lend key; a stand-in here: the real one is tested in people.test.js and against a real daemon in member-share-owner.test.js). */
  const lentStore = new Map([[BEN, new Map()], [CY, new Map()]]);
  v.access.members.people = {
    get: async (/** @type {string} */ id, /** @type {{ name: string }} */ { name }) => { if (locked) throw Object.assign(new Error("locked"), { code: "locked" }); const it = items.get(id)?.get(name); if (!it) throw new Error(`no item named ${name}`); return structuredClone(it); },
    lent: (/** @type {string} */ id) => ({
      get: async (/** @type {string} */ name) => { const it = lentStore.get(id)?.get(name); if (!it) throw Object.assign(new Error("no lent item"), { code: "not_found" }); return structuredClone(it); },
      put: async (/** @type {string} */ name, /** @type {any} */ it) => { lentStore.get(id)?.set(name, structuredClone(it)); return { name }; },
      remove: async (/** @type {string} */ name) => { if (lentLocked) throw Object.assign(new Error("locked"), { code: "locked" }); return { removed: Boolean(lentStore.get(id)?.delete(name)) }; },
    }),
  };
  await v.key();
  const calls = /** @type {any[]} */ ([]);
  current.calls = calls;
  const makeCdp = () => ({ connect: async () => { throw Object.assign(new Error("stand-in browser: stop here"), { code: "stand_in" }); }, close: async () => {} });
  const logs = /** @type {string[]} */ ([]);
  const d = { vault: v, said: new SaidIntents(v), log: (/** @type {string} */ m) => { logs.push(m); }, makeCdp, call: async (/** @type {string} */ name, /** @type {any} */ input) => { calls.push({ name, input }); return name === "computers.fill.begin" ? { data: { fill: "f1", cdpUrl: "http://127.0.0.1:9", token: "" } } : { data: { ended: true } }; } };
  const as = (/** @type {string} */ p) => ({ chain: rig.person(p) });
  const asAgentOf = (/** @type {string} */ p, a = "juno") => ({ chain: rig.assistant(rig.uid(a), p) });
  const M = v.access.members;
  const share = (/** @type {any} */ over = {}, who = BEN) => M.share({ item: LABEL, agent: "juno", origin: ORIGIN, ...over }, as(who));
  // a refusal prints the reasons agent-fill logged, so a copy that should fill and does not is told apart from one that should not
  const fill = (/** @type {string} */ ref, agent = "juno", origin = ORIGIN) => agentFill(d, { agent, item: ref, origin }).catch(e => { if (logs.length) console.error(`agent-fill said: ${logs.splice(0).join(" | ")}`); throw e; });
  const everything = () => JSON.stringify({ events, audit: db.prepare("SELECT * FROM vault_audit").all(), calls, items: v.list().items });
  return { v, rig, db, M, items, lentStore, setLocked: (/** @type {boolean} */ b) => { locked = b; }, setLentLocked: (/** @type {boolean} */ b) => { lentLocked = b; }, as, asAgentOf, share, fill, calls, events, everything, home };
}

const stops = (/** @type {Promise<any>} */ p) => assert.rejects(p, e => /** @type {any} */ (e).code === "stand_in");
/** After a share ended its copy is gone, so the agent is told there is no such login (not_found), or that it is not lent (denied): either way nothing fills. */
/** The calls the current world recorded: a refused fill must not have begun the agent's computer, which is where a value would move. */
const current = { calls: /** @type {any[]} */ ([]) };
const begins = () => current.calls.filter(c => c.name === "computers.fill.begin").length;
const gone = async (/** @type {Promise<any>} */ p) => { const before = begins(); await assert.rejects(p, e => ["denied", "not_found"].includes(/** @type {any} */ (e).code)); assert.equal(begins(), before, "a refused fill moved no value: its computer was never begun"); };
const denied = async (/** @type {Promise<any>} */ p, re = /not lent|not for|denied|member/) => { const before = begins(); await assert.rejects(p, e => /** @type {any} */ (e).code === "denied" && re.test(/** @type {Error} */ (e).message)); assert.equal(begins(), before, "a refused fill moved no value: its computer was never begun"); };

test("a member's share: one login, one agent, one site; the agent is told a reference, the member a plain line, and the agent's fill starts", async t => {
  const w = await world(t);
  const r = await w.share();
  assert.equal(r.notice, NOTICE); assert.equal(NOTICE, "Your agent can use this login while you're away.");
  assert.match(r.shared.ref, /^mc-[0-9a-f]{20}$/);
  assert.deepEqual({ agent: r.shared.agent, origin: r.shared.origin }, { agent: "juno", origin: ORIGIN });
  assert.deepEqual((await w.M.list(w.as(BEN))).shares.map(s => [s.item, s.agent, s.origin]), [[LABEL, "juno", ORIGIN]], "the member sees their own share");
  assert.deepEqual((await w.v.access.listFor("juno")).filter(x => x.kind === "login").map(x => [x.name, x.label]), [[r.shared.ref, LABEL]], "the agent is told the reference and the label");
  assert.deepEqual(await w.v.access.listFor("kit"), [], "another agent is told nothing");
  await stops(w.fill(r.shared.ref));
  assert.equal(w.calls.filter(c => c.name === "computers.fill.begin").length, 1);
});

test("only the member, explicitly, for a login of theirs with a password, for a named agent: not the owner, not an assistant in the chain, not a note, not a locked vault, not the default assistant", async t => {
  const w = await world(t);
  await denied(w.M.share({ item: LABEL, agent: "juno", origin: ORIGIN }, { chain: w.rig.owner() }), /member|vault/);
  await denied(w.M.share({ item: LABEL, agent: "juno", origin: ORIGIN }, w.asAgentOf(BEN)), /member|vault/);
  await assert.rejects(w.share({ item: "a-note" }), /only a login/);
  await assert.rejects(w.share({ item: "nope" }), /no item named/);
  await assert.rejects(w.share({ agent: "assistant" }), /default assistant/);
  await assert.rejects(w.share({ agent: "no-such-agent" }), e => /** @type {any} */ (e).code === "not_found");
  await assert.rejects(w.share({ agent: "team" }), e => /** @type {any} */ (e).code === "not_found", "an agent Ben may not instruct is not found, as if it did not exist");
  await assert.rejects(w.share({ origin: "not an address" }), /address/);
  await assert.rejects(w.share({ expires: Date.now() - 1000 }), /future/);
  await assert.rejects(w.share({ expires: w.rig.clock() + 400 * 86_400_000 }), /within a year/);
  w.setLocked(true);
  await assert.rejects(w.share(), e => /** @type {any} */ (e).code === "locked");
  w.setLocked(false);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n, 0, "none of these left a copy behind");
  assert.equal(w.lentStore.get(BEN).size, 0);
  // Cy has no such login; Ben's is not Cy's to share
  await assert.rejects(w.share({}, CY), /no item named/);
});

test("the copy is not an item of the Space's vault: it sits in the member's own lend folder, and nothing of the owner's shows it: no list, row, field, table, audit line or file", async t => {
  const w = await world(t);
  const r = await w.share();
  const ref = r.shared.ref;
  assert.ok(!w.v.list().items.some((/** @type {any} */ i) => i.name === ref || i.name === LABEL), "the Space's list does not hold it");
  assert.equal(w.v.list({ filter: "mc-" }).items.length, 0);
  assert.ok(!w.v.row(ref), "no row by that name");
  assert.ok(!w.db.prepare("SELECT 1 FROM vault_items WHERE name = ? OR description LIKE ?").get(ref, `%${LABEL}%`));
  assert.equal(w.lentStore.get(BEN).get(ref).fields.password, PASS, "it is in Ben's own lend folder");
  assert.equal(w.lentStore.get(BEN).get(ref).description, LABEL, "and the name he gave the login is there too, sealed with it");
  assert.equal(w.lentStore.get(CY).size, 0);
  const table = JSON.stringify(w.db.prepare("SELECT * FROM vault_member_copies").all());
  assert.ok(!table.includes(PASS) && !table.includes(LABEL) && !table.includes(USER), "the record that finds the share holds neither the value nor the login's name");
  for (const text of [w.everything()]) { assert.ok(!text.includes(PASS), "no password in audit, events or calls"); assert.ok(!text.includes(USER)); assert.ok(!text.includes(LABEL), "nor the member's name for the login"); }
  const walk = (/** @type {string} */ d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  for (const f of walk(path.join(w.home, "vault"))) assert.ok(!fs.readFileSync(f).includes(Buffer.from(PASS)), f);
  assert.equal((await w.v.access.copies.fields(ref)).password, PASS, "only the store's own path opens it");
});

test("the agent's fill needs the grant every time: another agent, another site, a taken-back grant and an expired share are each refused, and none touches the computer", async t => {
  const w = await world(t);
  const ref = (await w.share()).shared.ref;
  await denied(w.fill(ref, "kit"));
  await denied(w.fill(ref, "juno", OTHER));
  await denied(w.fill(ref, "juno", "http://bank.example.com"));
  assert.equal(w.calls.filter(c => c.name === "computers.fill.begin").length, 0);
  await stops(w.fill(ref));
  // the kernel grant taken back by itself: the copy is still on disk but unusable
  await w.rig.K.mint.end({ source: `vault:member-share:${ref}`, reason: "test" });
  await denied(w.fill(ref));
  assert.equal(w.calls.filter(c => c.name === "computers.fill.begin").length, 1, "still only the first fill reached the computer");
  // an expired share is refused and its copy deleted
  const exp = (await w.share({ expires: w.rig.clock() + 5_000 })).shared.ref;
  const real = w.v.clock; w.v.clock = () => real() + 3_600_000;
  for (let i = 0; i < 6000; i++) w.rig.clock();
  await assert.rejects(w.fill(exp), e => /** @type {any} */ (e).code === "not_found", "an expired share is no login at all");
  assert.ok(!w.db.prepare("SELECT 1 FROM vault_member_copies WHERE ref = ?").get(exp), "and its copy was deleted when it was found out");
  assert.ok(!w.lentStore.get(BEN).has(exp), "and the sealed copy");
  w.v.clock = real;
});

test("every way a share ends deletes its copy: unshare, the login changed, the login removed, the member leaving", async t => {
  const w = await world(t);
  const count = () => Number(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n);
  const files = () => w.lentStore.get(BEN).size;
  // unshare
  const a = (await w.share()).shared.ref;
  assert.equal(count(), 1); assert.equal(files(), 1);
  assert.deepEqual(await w.M.unshare({ item: LABEL }, w.as(BEN)), { ended: 1 });
  assert.equal(count(), 0); assert.equal(files(), 0, "the sealed copy is gone with the row");
  await gone(w.fill(a));
  // the login changed: the copy follows it, so the agent signs in with the new password
  const b = (await w.share()).shared.ref;
  w.items.get(BEN).get(LABEL).fields.password = "fixture-NEW-password-0123456789abcdef";
  await w.M.changed(BEN, LABEL);
  assert.equal((await w.v.access.copies.fields(b)).password, "fixture-NEW-password-0123456789abcdef");
  // the login stops being a login with a password: the copy goes
  delete w.items.get(BEN).get(LABEL).fields.password;
  await w.M.changed(BEN, LABEL);
  assert.equal(count(), 0); await gone(w.fill(b));
  // removed
  w.items.get(BEN).get(LABEL).fields.password = PASS;
  const c = (await w.share()).shared.ref;
  w.items.get(BEN).delete(LABEL);
  await w.M.changed(BEN, LABEL);
  assert.equal(count(), 0); assert.equal(files(), 0); await gone(w.fill(c));
  // the member leaving: all of their shares, whatever agent and site
  w.items.get(BEN).set(LABEL, { name: LABEL, kind: "login", fields: { username: USER, password: PASS } });
  await w.share(); await w.share({ agent: "kit", origin: "https://other.example.com" });
  assert.equal(count(), 2);
  assert.equal(await w.M.gone(BEN), 2);
  assert.equal(count(), 0); assert.equal(files(), 0);
  assert.equal((await w.rig.K.mint.list({ source: "vault:member-share:" })).length, 0, "and their grants are ended");
});

test("a share is Ben's alone: Cy cannot list, end or use it, and sharing twice is one copy", async t => {
  const w = await world(t);
  const ref = (await w.share()).shared.ref;
  assert.deepEqual((await w.M.list(w.as(CY))).shares, []);
  assert.deepEqual(await w.M.unshare({ item: LABEL }, w.as(CY)), { ended: 0 }, "Cy's unshare ends none of Ben's");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n, 1);
  assert.equal((await w.share()).shared.ref, ref, "the same share again is the same copy");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n, 1);
});

test("a copy that cannot be reached to delete (her vault is locked and no sealed key is held) is never used meanwhile, and the next sweep deletes it", async t => {
  const w = await world(t);
  const ref = (await w.share()).shared.ref;
  w.setLentLocked(true);
  assert.deepEqual(await w.M.unshare({ item: LABEL }, w.as(BEN)), { ended: 1 });
  assert.equal(w.db.prepare("SELECT gone FROM vault_member_copies WHERE ref = ?").get(ref).gone, 1, "the row stays, marked for deletion");
  assert.ok(w.lentStore.get(BEN).has(ref), "the sealed copy could not be reached yet");
  await assert.rejects(w.fill(ref), e => /** @type {any} */ (e).code === "not_found", "and it is not used");
  assert.deepEqual(await w.M.list(w.as(BEN)).then(l => l.shares), [], "nor listed");
  w.setLentLocked(false);
  await w.v.access.copies.sweep();
  assert.ok(!w.lentStore.get(BEN).has(ref), "deleted at the next chance");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n, 0);
});

test("the share sheet says who else can instruct the chosen agent", async t => {
  const w = await world(t);
  const r = await w.share();
  assert.deepEqual(r.instructors.others, [CY], "Cy was given the agent: Ben's login will be filled when Cy asks it too");
  assert.match(r.instructors.staff, /owner and the admins/);
  const k = await w.share({ agent: "kit", origin: "https://other.example.com" });
  assert.deepEqual(k.instructors.others, ["per_ada"], "kit's maker can instruct it");
});

test("a copy that cannot be brought up to date with its login is deleted with its grant, never kept as it was", async t => {
  const w = await world(t);
  const ref = (await w.share()).shared.ref;
  const real = w.v.access.members.people.lent;
  w.v.access.members.people.lent = () => ({ put: async () => { throw new Error("disk full"); }, remove: real(BEN).remove, get: real(BEN).get });
  w.items.get(BEN).get(LABEL).fields.password = "fixture-NEW-password-0123456789abcdef";
  await assert.rejects(w.M.changed(BEN, LABEL), /disk full/);
  w.v.access.members.people.lent = real;
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n, 0, "no copy outlived the login it was taken from");
  assert.ok(!w.lentStore.get(BEN).has(ref));
  assert.equal((await w.rig.K.mint.list({ source: "vault:member-share:" })).length, 0, "and no grant");
  await assert.rejects(w.fill(ref), e => /** @type {any} */ (e).code === "not_found", "and the agent cannot use it");
});

test("the share is the grant, and the kernel still has its say: a deny on the agent refuses a live share; a member no longer in the Space refuses it; a share is only valid while she may instruct the agent", async t => {
  const w = await world(t);
  const r = await w.share();
  const K = /** @type {any} */ (w.v.access.K);
  await stops(w.fill(r.shared.ref));   // live: starts
  // the kernel's whole answer for this agent says no (a deny or a freeze on it) while the share and its grant are still live: refused
  const was = K.agentMay;
  K.agentMay = async () => false;
  await denied(w.fill(r.shared.ref));
  K.agentMay = was;
  await stops(w.fill(r.shared.ref));   // and with the kernel's yes again, it starts
  // the member is no longer in the Space (the kernel's membership question says nobody), the share and grant not yet swept: refused
  const hadMembership = K.membership;
  K.membership = async () => null;
  await denied(w.fill(r.shared.ref));
  if (hadMembership) K.membership = hadMembership; else delete K.membership;
  await stops(w.fill(r.shared.ref));
  // her access to the agent was taken back: her shares with it end, the grant and the copy go, and the fill finds nothing
  assert.equal(await w.M.agentLost(BEN, "juno"), 1);
  assert.equal(w.lentStore.get(BEN)?.size, 0, "the sealed copy is gone");
  await assert.rejects(w.fill(r.shared.ref), e => /** @type {any} */ (e).code === "not_found");
});

test("staff instruct every agent, so losing a share of an agent does not end an admin's or the owner's shares with it", async t => {
  const w = await world(t);
  const r = await w.share();
  const K = /** @type {any} */ (w.v.access.K);
  K.membership = async () => "admin";
  assert.equal(await w.M.agentLost(BEN, "juno"), 0);
  delete K.membership;
  await stops(w.fill(r.shared.ref));
});

test("the share is for the agent it was made for: the name resolving to a different stable id today (the agent was removed and made again) is refused", async t => {
  const w = await world(t);
  const r = await w.share();
  await stops(w.fill(r.shared.ref));
  const was = w.v.access.uidOf;
  w.v.access.uidOf = async () => "agt_another";
  await denied(w.fill(r.shared.ref));
  w.v.access.uidOf = was;
  await stops(w.fill(r.shared.ref));
});
