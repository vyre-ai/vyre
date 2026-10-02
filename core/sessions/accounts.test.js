// @ts-check
// Several accounts per provider, and the resolution order (plans/sessions.md 3.2), including
// reviewer-2's H1 fix: an explicit account is scope-checked too, never a free pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Accounts, ACCOUNTS_MIGRATION, ACCOUNTS_PENDING_MIGRATION, ACCOUNTS_ENDPOINT_MIGRATION } from "./accounts.js";

function fresh(o) {
  const db = new DatabaseSync(":memory:");
  db.exec(ACCOUNTS_MIGRATION);
  db.exec(ACCOUNTS_PENDING_MIGRATION);
  db.exec(ACCOUNTS_ENDPOINT_MIGRATION);
  return new Accounts(db, o);
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
