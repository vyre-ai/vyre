// @ts-check
// Several accounts per provider, and the resolution order (plans/sessions.md 3.2), including
// reviewer-2's H1 fix: an explicit account is scope-checked too, never a free pass.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Accounts, ACCOUNTS_MIGRATION, ACCOUNTS_PENDING_MIGRATION, ACCOUNTS_ENDPOINT_MIGRATION, ACCOUNTS_PERSON_MIGRATION, ACCOUNTS_OWN_VAULT_MIGRATION } from "./accounts.js";

function fresh(o) {
  const db = new DatabaseSync(":memory:");
  db.exec(ACCOUNTS_MIGRATION);
  db.exec(ACCOUNTS_PENDING_MIGRATION);
  db.exec(ACCOUNTS_ENDPOINT_MIGRATION);
  db.exec(ACCOUNTS_PERSON_MIGRATION);
  db.exec(ACCOUNTS_OWN_VAULT_MIGRATION);
  return new Accounts(db, { owner: () => "per_owner", ...o });
}

test("accounts: with none configured, claude synthesizes a default; resolve returns it unchanged", async () => {
  const a = fresh();
  const list = a.list("claude");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "default");
  assert.equal(list[0].synthetic, true);
  const r = a.resolve({ provider: "claude", project: "harlow-legal" });
  assert.equal(r.id, "default");
});

test("accounts: add, list, remove; scope defaults to everyone until bound narrower", async () => {
  const a = fresh();
  const row = await a.add({ provider: "codex", label: "Personal", vault_item: "codex-personal-token" });
  assert.equal(row.provider, "codex");
  assert.deepEqual(row.scope, { projects: "*", agents: "*" });
  assert.equal(a.list("codex").length, 1);
  assert.deepEqual(a.remove(row.id), { id: row.id, removed: true });
  assert.equal(a.list("codex").length, 0);
});

test("accounts: bind grants one more project without dropping what it already has", async () => {
  const a = fresh();
  const row = await a.add({ provider: "grok", label: "Work", vault_item: "grok-work-token", scope: { projects: ["harlow-legal"], agents: "*" } });
  const bound = a.bind({ id: row.id, project: "northwind" });
  assert.deepEqual(bound.scope.projects.sort(), ["harlow-legal", "northwind"]);
  assert.equal(bound.scope.agents, "*");
});

test("accounts: resolution order - explicit, then agent's own, then project's, then the provider default", async () => {
  const a = fresh();
  const proj = await a.add({ provider: "codex", label: "Project account", vault_item: "codex-project", scope: { projects: ["harlow-legal"], agents: "*" } });
  const agentAcc = await a.add({ provider: "codex", label: "Agent account", vault_item: "codex-agent", scope: { projects: "*", agents: ["juno"] } });
  const def = await a.add({ provider: "codex", label: "Default", vault_item: "codex-default", is_default: true });

  // Agent's own account wins over the project's, when both would otherwise match.
  assert.equal(a.resolve({ provider: "codex", project: "harlow-legal", agent: "juno" }).id, agentAcc.id);
  // No agent match: the project's account.
  assert.equal(a.resolve({ provider: "codex", project: "harlow-legal", agent: "kit" }).id, proj.id);
  // Neither: the provider's default.
  assert.equal(a.resolve({ provider: "codex", project: "northwind" }).id, def.id);
  // An explicit account, in scope, wins outright.
  assert.equal(a.resolve({ provider: "codex", account: proj.id, project: "harlow-legal" }).id, proj.id);
});

test("accounts: H1 - an explicit account out of its scope is denied, never a silent fallback to another", async () => {
  const a = fresh();
  const proj = await a.add({ provider: "codex", label: "Project account", vault_item: "codex-project", scope: { projects: ["harlow-legal"], agents: "*" } });
  await a.add({ provider: "codex", label: "Default", vault_item: "codex-default", is_default: true });
  assert.throws(() => a.resolve({ provider: "codex", account: proj.id, project: "northwind" }), /is not granted to project northwind/);
  // Even the assistant (or anything a prompt injection shapes) naming it explicitly gets the same refusal.
  assert.throws(() => a.resolve({ provider: "codex", account: proj.id, project: "northwind", agent: "assistant" }), { code: "denied" });
});

test("accounts: two accounts, neither the default, neither scoped to the target - refused, with the list to choose from, never a guess", async () => {
  const a = fresh();
  await a.add({ provider: "codex", label: "Personal", vault_item: "codex-personal", scope: { projects: ["a"], agents: "*" } });
  await a.add({ provider: "codex", label: "Work", vault_item: "codex-work", scope: { projects: ["b"], agents: "*" } });
  assert.throws(() => a.resolve({ provider: "codex", project: "c" }), { code: "ambiguous" });
});

test("accounts: removing an account is not found on a second remove, and binding an unknown account is refused", async () => {
  const a = fresh();
  const row = await a.add({ provider: "grok", label: "Only", vault_item: "grok-only" });
  a.remove(row.id);
  assert.throws(() => a.remove(row.id), { code: "not_found" });
  assert.throws(() => a.bind({ id: row.id, project: "x" }), { code: "not_found" });
  assert.throws(() => a.bind({ id: "default", project: "x" }), { code: "not_found" }, "the synthetic default cannot be bound - add a real account first");
});

test("accounts: each account gets the lowest free uid in 2000-2063, and a login account holds no vault item", async () => {
  const a = fresh();
  const one = await a.add({ provider: "grok", label: "One", kind: "login" });
  const two = await a.add({ provider: "codex", label: "Two", vault_item: "codex-two" });
  assert.deepEqual([one.uid, two.uid], [2000, 2001]);
  assert.equal(one.vault_item, null);
  await assert.rejects(a.add({ provider: "grok", label: "Bad", kind: "login", vault_item: "x" }), /holds no vault item/);
  await assert.rejects(a.add({ provider: "grok", label: "Bad", kind: "api-key" }), /vault_item/);
  await assert.rejects(a.add({ provider: "grok", label: "Bad", kind: "password", vault_item: "x" }), /kind is one of/);
});

test("accounts: a removed account's uid goes to a new one only after its HOME is wiped; a failed wipe skips it", async () => {
  const wiped = [];
  let fail = false;
  const a = fresh({ wipe: async uid => { if (fail) throw new Error("busy"); wiped.push(uid); } });
  const rows = [];
  for (let i = 0; i < 64; i++) rows.push(await a.add({ provider: "codex", label: `n${i}`, kind: "login" }));
  assert.equal(rows[63].uid, 2063);
  await assert.rejects(a.add({ provider: "codex", label: "one too many", kind: "login" }), { code: "too_many" });
  a.remove(rows[5].id);
  a.remove(rows[9].id);
  fail = true;
  await assert.rejects(a.add({ provider: "codex", label: "no", kind: "login" }), { code: "too_many" }, "both uids are dirty and the wipe fails: none is handed out");
  fail = false;
  const next = await a.add({ provider: "codex", label: "yes", kind: "login" });
  assert.equal(next.uid, 2005);
  assert.deepEqual(wiped, [2005]);
  assert.equal((await a.add({ provider: "codex", label: "again", kind: "login" })).uid, 2009);
});

test("accounts: adds landing together never share a uid", async () => {
  const a = fresh({ wipe: async () => { await new Promise(r => setTimeout(r, 5)); } });
  const rows = await Promise.all(Array.from({ length: 20 }, (_, n) => a.add({ provider: "grok", label: `p${n}`, kind: "login" })));
  assert.equal(new Set(rows.map(r => r.uid)).size, 20);
  assert.throws(() => a.db.prepare("INSERT INTO sessions_accounts (id, provider, label, scope_projects, scope_agents, uid, added, updated) VALUES ('x','grok','x','\"*\"','\"*\"',2000,0,0)").run(), /UNIQUE/);
});

test("accounts: a pending account (started by a non-person) is never resolved, by name or by default, until the person confirms it on their own surface (a login only after its sign-in finished)", async () => {
  const a = fresh();
  const login = await a.add({ provider: "codex", label: "Second", kind: "login", scope: { projects: ["harlow-legal"], agents: "*" }, pending: true });
  const key = await a.add({ provider: "grok", label: "Key", vault_item: "grok-key", scope: { projects: ["harlow-legal"], agents: "*" }, pending: true, is_default: true });
  assert.equal(login.pending, true);
  for (const [acct, provider] of [[login, "codex"], [key, "grok"]]) {
    assert.throws(() => a.resolve({ provider, account: acct.id, project: "harlow-legal" }), e => e.code === "pending");
    const r = a.resolve({ provider, project: "harlow-legal" });
    assert.ok(!r || r.id !== acct.id, "never a silent fallback onto it");
  }
  // A non-person's bind (no confirm) never finishes anything; the person's confirm does, and for a login only after its sign-in finished.
  assert.equal(a.row(login.id).needs, "sign-in");
  assert.equal(a.row(key.id).needs, "confirm");
  assert.equal(a.bind({ id: key.id, project: "harlow-legal" }).pending, true);
  assert.equal(a.bind({ id: login.id, project: "harlow-legal", confirm: true }).pending, true, "a login cannot be confirmed before its sign-in finished");
  assert.equal(a.bind({ id: key.id, project: "harlow-legal", confirm: true }).pending, false);
  assert.equal(a.resolve({ provider: "grok", account: key.id, project: "harlow-legal" }).id, key.id);
  assert.equal(a.markSignedIn(login.id).pending, true, "a finished sign-in alone (whoever completed it) does not make it usable");
  assert.throws(() => a.resolve({ provider: "codex", account: login.id, project: "harlow-legal" }), e => e.code === "pending");
  assert.equal(a.row(login.id).needs, "confirm");
  assert.equal(a.bind({ id: login.id, project: "harlow-legal", confirm: true }).pending, false);
  assert.equal(a.resolve({ provider: "codex", account: login.id, project: "harlow-legal" }).id, login.id);
});

test("accounts: a provider's only account is its default, kept when another is removed, and a pending one only once confirmed", async () => {
  const a = fresh();
  const one = await a.add({ provider: "codex", label: "Personal", vault_item: "codex-personal" });
  assert.equal(one.is_default, true);
  const two = await a.add({ provider: "codex", label: "Work", vault_item: "codex-work" });
  assert.equal(two.is_default, false);
  a.remove(one.id);
  assert.equal(a.list("codex")[0].is_default, true);
  const pend = await a.add({ provider: "grok", label: "Key", vault_item: "grok-key", pending: true });
  assert.equal(pend.is_default, false);
  const done = a.bind({ id: pend.id, confirm: true });
  assert.equal(done.is_default, true);
});

test("accounts: one person's sign-in never serves another's turn, by default, by project or by explicit id", async () => {
  const a = fresh();
  const own = await a.add({ provider: "claude", label: "Owner key", vault_item: "claude-owner" });                          // the home's own (no person)
  const bob = await a.add({ provider: "claude", label: "Bob key", vault_item: "claude-bob", person: "per_bob" });
  const eve = await a.add({ provider: "claude", label: "Eve key", vault_item: "claude-eve", person: "per_eve", scope: { projects: ["x-law"], agents: "*" } });
  assert.equal(a.resolve({ provider: "claude", person: "per_bob" }).id, bob.id, "Bob's turn runs on Bob's account");
  assert.equal(a.resolve({ provider: "claude", person: "per_owner" }).id, own.id, "the owner's turn runs on the home's own account");
  assert.equal(a.resolve({ provider: "claude" }).id, own.id, "a call that names no person sees only the home's own");
  assert.throws(() => a.resolve({ provider: "claude", person: "per_bob", account: eve.id }), /no account/, "Bob naming Eve's account by id: not found");
  assert.throws(() => a.resolve({ provider: "claude", person: "per_owner", account: bob.id }), /no account/, "the owner is not served by a member's account either");
  assert.equal(a.resolve({ provider: "claude", person: "per_eve", project: "x-law" }).id, eve.id);
  assert.equal(a.resolve({ provider: "claude", person: "per_nobody" }), null, "a person with no account of their own gets none, not the owner's");
  assert.deepEqual(a.list("claude", "per_bob").map(x => x.id), [bob.id], "and lists only their own");
  assert.deepEqual(a.list("claude").map(x => x.id), [own.id]);
});

test("accounts: each person has their own default on a provider", async () => {
  const a = fresh();
  const o1 = await a.add({ provider: "codex", label: "Owner 1", vault_item: "c-o1" });
  const b1 = await a.add({ provider: "codex", label: "Bob 1", vault_item: "c-b1", person: "per_bob" });
  const b2 = await a.add({ provider: "codex", label: "Bob 2", vault_item: "c-b2", person: "per_bob", is_default: true });
  assert.equal(o1.is_default, true, "the owner's first account is their default");
  assert.equal(b1.is_default, true, "and Bob's first is Bob's default, not blocked by the owner's");
  assert.equal(a.resolve({ provider: "codex", person: "per_bob" }).id, b2.id, "Bob made his second the default");
  assert.equal(a.resolve({ provider: "codex", person: "per_owner" }).id, o1.id, "which left the owner's alone");
});

test("accounts: a member has one sign-in account of their own per provider, several in all; keys are not limited, and the owner is not capped", async () => {
  const a = fresh();
  const codex = await a.add({ provider: "codex", label: "Bob login", kind: "login", person: "per_bob" });
  await assert.rejects(() => a.add({ provider: "codex", label: "Bob second codex login", kind: "login", person: "per_bob" }), e => e.code === "too_many");
  const grok = await a.add({ provider: "grok", label: "Bob grok login", kind: "login", person: "per_bob" });
  const key = await a.add({ provider: "openrouter", label: "Bob key", vault_item: "bob-key", person: "per_bob", own_vault: true });
  await a.add({ provider: "codex", label: "Bob codex key", vault_item: "bob-key-2", person: "per_bob" });
  // each is his alone: his turns resolve them, nobody else's turn (the owner's included) ever does
  assert.equal(a.resolve({ provider: "codex", person: "per_bob" }).id, codex.id);
  assert.equal(a.resolve({ provider: "grok", person: "per_bob" }).id, grok.id);
  assert.equal(a.resolve({ provider: "openrouter", person: "per_bob" }).id, key.id);
  for (const other of ["per_eve", "per_owner"]) for (const [p, x] of [["codex", codex], ["grok", grok], ["openrouter", key]]) {
    assert.throws(() => a.resolve({ provider: p, person: other, account: x.id }), /no account/, `${other} cannot name Bob's ${p} account`);
    const r = a.resolve({ provider: p, person: other });
    assert.ok(!r || r.person !== "per_bob", `${other}'s own resolution never lands on Bob's ${p} account`);
  }
  await a.add({ provider: "codex", label: "Eve login", kind: "login", person: "per_eve" });
  await a.add({ provider: "codex", label: "Owner 1", kind: "login" });
  await a.add({ provider: "grok", label: "Owner 2", kind: "login" });
});

test("accounts: a job for a member runs on that member's own account like their own turn, never on the home's; a job for nobody is the home's own", async () => {
  const a = fresh();
  const own = await a.add({ provider: "claude", label: "Space key", vault_item: "claude-space" });
  const bob = await a.add({ provider: "claude", label: "Bob token", kind: "setup-token", vault_item: "bob-claude", person: "per_bob", is_default: true });
  assert.equal(a.resolve({ provider: "claude", person: "per_bob" }).id, bob.id, "Bob's own turn");
  assert.equal(a.resolve({ provider: "claude", person: "per_bob", job: true }).id, bob.id, "a job on his behalf runs on his own account");
  assert.equal(a.resolve({ provider: "claude", person: "per_bob", job: true, account: bob.id }).id, bob.id, "and may name it");
  assert.throws(() => a.resolve({ provider: "claude", person: "per_bob", job: true, account: own.id }), /no account/, "never the home's for him");
  assert.equal(a.resolve({ provider: "claude", job: true }).id, own.id, "a job for nobody is the home's own");
  const eve = fresh();
  await eve.add({ provider: "claude", label: "Space key", vault_item: "claude-space" });
  assert.equal(eve.resolve({ provider: "claude", person: "per_eve", job: true }), null, "a member with no account of her own gets no account for her job, never the home's");
});

test("accounts: a job a member asked for may name that member's own login, key or token, and no one else's", async () => {
  const a = fresh();
  const login = await a.add({ provider: "claude", label: "Bob login", kind: "login", person: "per_bob" });
  const eve = await a.add({ provider: "claude", label: "Eve login", kind: "login", person: "per_eve" });
  const token = await a.add({ provider: "codex", label: "Bob token", kind: "setup-token", vault_item: "bob-codex", person: "per_bob" });
  assert.equal(a.resolve({ provider: "claude", person: "per_bob", job: true, account: login.id }).id, login.id, "his own login serves a job he asked for");
  assert.throws(() => a.resolve({ provider: "claude", person: "per_bob", job: true, account: eve.id }), /no account/, "not another person's");
  assert.throws(() => a.resolve({ provider: "claude", job: true, account: login.id }), /no account/, "and a job with no person named cannot name it");
  assert.equal(a.resolve({ provider: "codex", person: "per_bob", job: true, account: token.id }).id, token.id, "his own token serves his own job");
});

test("accounts: own() is the person's own account on any provider, the one asked for first, never the home's for a member and never another member's", async () => {
  const a = fresh();
  const home = await a.add({ provider: "claude", label: "Space key", vault_item: "claude-space" });
  const codex = await a.add({ provider: "codex", label: "Bob Codex", kind: "login", person: "per_bob" });
  const key = await a.add({ provider: "openrouter", label: "Bob key", kind: "api-key", vault_item: "bob-or", person: "per_bob", own_vault: true });
  await a.add({ provider: "grok", label: "Eve Grok", kind: "login", person: "per_eve" });
  assert.equal(a.own({ person: "per_bob" }).id, codex.id, "no Claude of his own: his first other account");
  assert.equal(a.own({ person: "per_bob", provider: "openrouter" }).id, key.id, "the provider asked for comes first");
  assert.equal(a.own({ person: "per_bob", provider: "grok" }).id, codex.id, "a provider he has none on is skipped, never someone else's on it");
  assert.equal(a.own({ person: "per_ann" }), null, "a member with none gets none, never the home's");
  assert.equal(a.own({}), null, "nobody gets nothing");
  assert.equal(a.own({ person: "per_owner" }).id, home.id, "the owner's own is the home's");
});

test("accounts: a member's own api-key account is stored under that member with its key in their own Vault, serves only them, and is never the owner's", async () => {
  const a = fresh();
  const mine = await a.add({ provider: "claude", label: "My Claude", kind: "api-key", vault_item: "My-Claude", person: "per_member", own_vault: true });
  const row = a.row(mine.id);
  assert.deepEqual([row.person, row.own_vault, row.kind, row.vault_item, row.provider], ["per_member", true, "api-key", "My-Claude", "claude"]);
  assert.equal(a.serves(row, "per_member"), true);
  assert.equal(a.serves(row, "per_owner"), false, "the owner is not served by a member's account");
  assert.equal(a.serves(row, "per_other"), false, "nor is another member");
  // the owner's own add (no person) is the home's, kept in the owner's Vault
  const owners = await a.add({ provider: "claude", label: "Owner Claude", kind: "api-key", vault_item: "owner-key" });
  assert.deepEqual([a.row(owners.id).person, a.row(owners.id).own_vault], [null, false]);
});
