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
  /** Who asked the turn now running on a chat (the Switchboard's threads.turn-asker), set by a test. */
  const askers = new Map([["chat-1", BEN], ["chat-3", BEN]]);
  const instructors = (/** @type {string} */ tool, /** @type {any} */ i) => tool === "threads.turn-asker" ? { data: { asker: askers.get(i.thread) || null } } : tool !== "agents.instructors" ? undefined
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
  const makeCdp = () => ({ connect: async () => { throw Object.assign(new Error("stand-in browser: stop here"), { code: "stand_in" }); }, close: async () => {} });
  const d = { vault: v, said: new SaidIntents(v), log: () => {}, makeCdp, call: async (/** @type {string} */ name, /** @type {any} */ input) => { calls.push({ name, input }); return name === "computers.fill.begin" ? { data: { fill: "f1", cdpUrl: "http://127.0.0.1:9", token: "" } } : { data: { ended: true } }; } };
  const as = (/** @type {string} */ p) => ({ chain: rig.person(p) });
  const asAgentOf = (/** @type {string} */ p, a = "juno") => ({ chain: rig.assistant(rig.uid(a), p) });
  const M = v.access.members;
  const share = (/** @type {any} */ over = {}, who = BEN) => M.share({ item: LABEL, agent: "juno", origin: ORIGIN, ...over }, as(who));
  const fill = (/** @type {string} */ ref, agent = "juno", origin = ORIGIN, thread = undefined) => agentFill(d, { agent, item: ref, origin, ...(thread ? { thread } : {}) });
  const everything = () => JSON.stringify({ events, audit: db.prepare("SELECT * FROM vault_audit").all(), calls, items: v.list().items });
  return { v, rig, db, M, items, lentStore, askers, setLocked: (/** @type {boolean} */ b) => { locked = b; }, setLentLocked: (/** @type {boolean} */ b) => { lentLocked = b; }, as, asAgentOf, share, fill, calls, events, everything, home };
}

const stops = (/** @type {Promise<any>} */ p) => assert.rejects(p, e => /** @type {any} */ (e).code === "stand_in");
const denied = (/** @type {Promise<any>} */ p, re = /not lent|denied|member/) => assert.rejects(p, e => /** @type {any} */ (e).code === "denied" && re.test(/** @type {Error} */ (e).message));

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
  await denied(w.fill(a));
  // the login changed: the copy follows it, so the agent signs in with the new password
  const b = (await w.share()).shared.ref;
  w.items.get(BEN).get(LABEL).fields.password = "fixture-NEW-password-0123456789abcdef";
  await w.M.changed(BEN, LABEL);
  assert.equal((await w.v.access.copies.fields(b)).password, "fixture-NEW-password-0123456789abcdef");
  // the login stops being a login with a password: the copy goes
  delete w.items.get(BEN).get(LABEL).fields.password;
  await w.M.changed(BEN, LABEL);
  assert.equal(count(), 0); await denied(w.fill(b));
  // removed
  w.items.get(BEN).get(LABEL).fields.password = PASS;
  const c = (await w.share()).shared.ref;
  w.items.get(BEN).delete(LABEL);
  await w.M.changed(BEN, LABEL);
  assert.equal(count(), 0); assert.equal(files(), 0); await denied(w.fill(c));
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

test("tagging a login in a chat lends it to that chat's agent for that chat only: another chat of the same agent, another agent and a fill with no chat get nothing, and the end call takes back only the loan", async t => {
  const w = await world(t);
  const M = w.M;
  const lent = await M.shareAs(BEN, { item: LABEL, agent: "juno", origin: ORIGIN, sessions: ["chat-1"] });
  const ref = lent.shared.ref;
  assert.equal(lent.notice, NOTICE);
  assert.ok(lent.shared.expires - w.rig.clock() <= 1_800_000 + 60_000, "30 minutes by default: the end call is the normal end, the clock the backstop");
  await stops(w.fill(ref, "juno", ORIGIN, "chat-1"));
  await denied(w.fill(ref, "juno", ORIGIN, "chat-2"));
  await denied(w.fill(ref, "juno", ORIGIN));
  await denied(w.fill(ref, "kit", ORIGIN, "chat-1"));
  await denied(w.fill(ref, "juno", OTHER, "chat-1"));
  assert.equal(w.calls.filter(c => c.name === "computers.fill.begin").length, 1, "only the chat's own fill reached the computer");
  // the agent is told of it in that chat only
  assert.deepEqual((await w.v.access.listFor("juno", "chat-1")).filter(x => x.kind === "login").map(x => x.name), [ref]);
  assert.deepEqual((await w.v.access.listFor("juno", "chat-2")).filter(x => x.kind === "login"), []);
  assert.deepEqual((await w.v.access.listFor("juno")).filter(x => x.kind === "login"), []);
  // in a group chat the agent serves everyone: a turn that Cy asked, or the owner, or one with no asker, gets nothing of her login even in that very chat
  for (const asker of [CY, "per_owner", "per_ada", null]) {
    w.askers.set("chat-1", asker);
    await denied(w.fill(ref, "juno", ORIGIN, "chat-1"));
  }
  w.askers.set("chat-1", BEN);
  await stops(w.fill(ref, "juno", ORIGIN, "chat-1"));
  assert.equal(w.calls.filter(c => c.name === "computers.fill.begin").length, 2, "only her own turns reached the computer");
  // her ordinary share of the same login is a different copy, and ending the turn leaves it
  const ordinary = (await w.share()).shared.ref;
  assert.notEqual(ordinary, ref);
  assert.equal(await M.endFor(BEN, "chat-1"), 1);
  await denied(w.fill(ref, "juno", ORIGIN, "chat-1"));
  await stops(w.fill(ordinary));
  // and unsharing the ordinary share leaves a loan to another chat
  const again = (await M.shareAs(BEN, { item: LABEL, agent: "juno", origin: ORIGIN, sessions: ["chat-3"] })).shared.ref;
  assert.deepEqual(await M.unshare({ item: LABEL }, w.as(BEN)), { ended: 1 }, "only the ordinary share");
  await stops(w.fill(again, "juno", ORIGIN, "chat-3"));
  assert.equal(await M.endFor(BEN, "chat-3"), 1);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n, 0);
  assert.equal(w.lentStore.get(BEN).size, 0);
});

test("a loan is a member's own login, for one chat, short, and the same checks as a share: not the Space owner, not a note, not a locked vault", async t => {
  const w = await world(t);
  const M = w.M;
  const ok = { item: LABEL, agent: "juno", origin: ORIGIN, sessions: ["chat-1"] };
  await assert.rejects(M.shareAs("per_owner", ok), e => e.code === "denied");
  await assert.rejects(M.shareAs("ben", ok), e => e.code === "denied");
  await assert.rejects(M.shareAs(BEN, { ...ok, sessions: [] }), /one chat/);
  await assert.rejects(M.shareAs(BEN, { ...ok, sessions: ["a", "b"] }), /one chat/);
  await assert.rejects(M.shareAs(BEN, { ...ok, sessions: ["bad chat!"] }), /one chat/);
  await assert.rejects(M.shareAs(BEN, { ...ok, expires: w.rig.clock() + 2 * 3_600_000 }), /within an hour/);
  await M.shareAs(BEN, { ...ok, sessions: ["chat-9"], expires: w.rig.clock() + 3_000_000 });   // 50 minutes is allowed
  await assert.rejects(M.shareAs(BEN, { ...ok, item: "a-note" }), /only a login/);
  await assert.rejects(M.shareAs(BEN, { ...ok, agent: "assistant" }), /default assistant/);
  w.setLocked(true);
  await assert.rejects(M.shareAs(BEN, ok), e => e.code === "locked");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n, 0, "none of these left a copy");
  // an agent she does not instruct herself is fine for a loan: it is that chat's agent and the grant holds in that chat only
  w.setLocked(false);
  await M.shareAs(BEN, { ...ok, agent: "team" });
});

test("a loan follows the login like a share: a refresh that fails, a login that vanishes or a locked vault deletes it with its grant", async t => {
  const w = await world(t);
  const loan = async (chat = "chat-1") => (await w.M.shareAs(BEN, { item: LABEL, agent: "juno", origin: ORIGIN, sessions: [chat] })).shared.ref;
  const count = () => Number(w.db.prepare("SELECT COUNT(*) AS n FROM vault_member_copies").get().n);
  const grants = async () => (await w.rig.K.mint.list({ source: "vault:member-share:" })).length;
  // a refresh that throws
  const ref = await loan();
  const real = w.v.access.members.people.lent;
  w.v.access.members.people.lent = () => ({ put: async () => { throw new Error("disk full"); }, remove: real(BEN).remove, get: real(BEN).get });
  w.items.get(BEN).get(LABEL).fields.password = "fixture-NEW-password-0123456789abcdef";
  await assert.rejects(w.M.changed(BEN, LABEL), /disk full/);
  w.v.access.members.people.lent = real;
  assert.equal(count(), 0); assert.equal(await grants(), 0); assert.ok(!w.lentStore.get(BEN).has(ref));
  // a locked vault at the change
  await loan("chat-2");
  w.setLocked(true);
  await assert.rejects(w.M.changed(BEN, LABEL), e => e.code === "locked");
  w.setLocked(false);
  assert.equal(count(), 0); assert.equal(await grants(), 0);
  // a login that vanishes, with a loan and an ordinary share both on it
  await loan("chat-3"); await w.share();
  w.items.get(BEN).delete(LABEL);
  await w.M.changed(BEN, LABEL);
  assert.equal(count(), 0); assert.equal(await grants(), 0); assert.equal(w.lentStore.get(BEN).size, 0);
});
