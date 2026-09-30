// @ts-check
// Several accounts per provider, and the resolution order (plans/sessions.md 3.2), including
// reviewer-2's H1 fix: an explicit account is scope-checked too, never a free pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Accounts, ACCOUNTS_MIGRATION } from "./accounts.js";

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(ACCOUNTS_MIGRATION);
  return new Accounts(db);
}

test("accounts: with none configured, claude synthesizes a default; resolve returns it unchanged", () => {
  const a = fresh();
  const list = a.list("claude");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "default");
  assert.equal(list[0].synthetic, true);
  const r = a.resolve({ provider: "claude", project: "harlow-legal" });
  assert.equal(r.id, "default");
});

test("accounts: add, list, remove; scope defaults to everyone until bound narrower", () => {
  const a = fresh();
  const row = a.add({ provider: "codex", label: "Personal", vault_item: "codex-personal-token" });
  assert.equal(row.provider, "codex");
  assert.deepEqual(row.scope, { projects: "*", agents: "*" });
  assert.equal(a.list("codex").length, 1);
  assert.deepEqual(a.remove(row.id), { id: row.id, removed: true });
  assert.equal(a.list("codex").length, 0);
});

test("accounts: bind grants one more project without dropping what it already has", () => {
  const a = fresh();
  const row = a.add({ provider: "grok", label: "Work", vault_item: "grok-work-token", scope: { projects: ["harlow-legal"], agents: "*" } });
  const bound = a.bind({ id: row.id, project: "northwind" });
  assert.deepEqual(bound.scope.projects.sort(), ["harlow-legal", "northwind"]);
  assert.equal(bound.scope.agents, "*");
});

test("accounts: resolution order - explicit, then agent's own, then project's, then the provider default", () => {
  const a = fresh();
  const proj = a.add({ provider: "codex", label: "Project account", vault_item: "codex-project", scope: { projects: ["harlow-legal"], agents: "*" } });
  const agentAcc = a.add({ provider: "codex", label: "Agent account", vault_item: "codex-agent", scope: { projects: "*", agents: ["juno"] } });
  const def = a.add({ provider: "codex", label: "Default", vault_item: "codex-default", is_default: true });

  // Agent's own account wins over the project's, when both would otherwise match.
  assert.equal(a.resolve({ provider: "codex", project: "harlow-legal", agent: "juno" }).id, agentAcc.id);
  // No agent match: the project's account.
  assert.equal(a.resolve({ provider: "codex", project: "harlow-legal", agent: "kit" }).id, proj.id);
  // Neither: the provider's default.
  assert.equal(a.resolve({ provider: "codex", project: "northwind" }).id, def.id);
  // An explicit account, in scope, wins outright.
  assert.equal(a.resolve({ provider: "codex", account: proj.id, project: "harlow-legal" }).id, proj.id);
});

test("accounts: H1 - an explicit account out of its scope is denied, never a silent fallback to another", () => {
  const a = fresh();
  const proj = a.add({ provider: "codex", label: "Project account", vault_item: "codex-project", scope: { projects: ["harlow-legal"], agents: "*" } });
  a.add({ provider: "codex", label: "Default", vault_item: "codex-default", is_default: true });
  assert.throws(() => a.resolve({ provider: "codex", account: proj.id, project: "northwind" }), /is not granted to project northwind/);
  // Even the assistant (or anything a prompt injection shapes) naming it explicitly gets the same refusal.
  assert.throws(() => a.resolve({ provider: "codex", account: proj.id, project: "northwind", agent: "assistant" }), { code: "denied" });
});

test("accounts: two accounts, neither the default, neither scoped to the target - refused, with the list to choose from, never a guess", () => {
  const a = fresh();
  a.add({ provider: "codex", label: "Personal", vault_item: "codex-personal", scope: { projects: ["a"], agents: "*" } });
  a.add({ provider: "codex", label: "Work", vault_item: "codex-work", scope: { projects: ["b"], agents: "*" } });
  assert.throws(() => a.resolve({ provider: "codex", project: "c" }), { code: "ambiguous" });
});

test("accounts: removing an account is not found on a second remove, and binding an unknown account is refused", () => {
  const a = fresh();
  const row = a.add({ provider: "grok", label: "Only", vault_item: "grok-only" });
  a.remove(row.id);
  assert.throws(() => a.remove(row.id), { code: "not_found" });
  assert.throws(() => a.bind({ id: row.id, project: "x" }), { code: "not_found" });
  assert.throws(() => a.bind({ id: "default", project: "x" }), { code: "not_found" }, "the synthetic default cannot be bound - add a real account first");
});
