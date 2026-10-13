// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeFor } from "./member-scope.js";

const firm = { name: "firm", email: "admin@firm.test", firm: true, auth: { type: "service-account", item: "sa", subject: "admin@firm.test" } };
const mine = { name: "mine", email: "owner@firm.test", auth: { type: "oauth", item: "t" } };
const all = [firm, mine];
const kernel = (hops) => ({ owner: "p-owner", chain: async () => ({ hops: hops.map(id => ({ actor: { kind: "person", id } })) }) });
const members = { "p-alice": { id: "p-alice", email: "alice@firm.test", verified: true } };
const deps = hops => ({ kernel: kernel(hops), all: () => all, memberOf: id => members[id] || null });
const claim = { token: "t" };

test("the owner and a call with no person see every account, unchanged", async () => {
  assert.equal(await scopeFor(deps(["p-owner"]), claim), null);
  assert.equal(await scopeFor(deps([]), { caller: "module:calendar" }), null);
});

test("a member sees only their own mailbox from the firm key, never the owner's accounts", async () => {
  const s = await scopeFor(deps(["p-alice"]), claim);
  assert.deepEqual(s.map(a => a.email), ["alice@firm.test"]);
  assert.equal(s[0].auth.subject, "alice@firm.test");
});

test("a member with no record or no firm key is refused, never given the owner's accounts", async () => {
  await assert.rejects(scopeFor(deps(["p-nobody"]), claim), e => e.code === "denied");
  await assert.rejects(scopeFor({ ...deps(["p-alice"]), all: () => [mine] }, claim), e => e.code === "no_account");
});

test("a chain with the owner and a member in it is the member's", async () => {
  const s = await scopeFor(deps(["p-owner", "p-alice"]), claim);
  assert.equal(s[0].email, "alice@firm.test");
});

test("an unreadable chain on a claimed call is refused", async () => {
  const d = { ...deps([]), kernel: { owner: "p-owner", chain: async () => { throw new Error("x"); } } };
  await assert.rejects(scopeFor(d, claim), e => e.code === "denied");
});

import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, store, memberEmails } from "./accounts.js";
test("a firm key row and an attested member email round-trip through the tables", () => {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const accts = store(db);
  accts.put({ name: "firm", email: "admin@firm.test", auth: { type: "service-account", item: "sa" }, firm: true, domain: "Firm.Test" }, 1);
  assert.equal(accts.get("firm").firm, true);
  assert.equal(accts.get("firm").domain, "firm.test");
  const me = memberEmails(db);
  assert.equal(me.get("p-alice"), null);
  me.set("p-alice", "Alice@Firm.test", "owner", 2);
  assert.deepEqual(me.get("p-alice"), { id: "p-alice", email: "alice@firm.test", verified: true });
  assert.equal(me.clear("p-alice"), true);
});

import { requireOwner, emailProblem } from "./member-scope.js";
const K = hops => ({ owner: "p-owner", chain: async () => ({ hops: hops.map(id => ({ actor: { kind: "person", id } })) }) });

test("requireOwner: only the owner's chain or the owner's local socket passes; a member (self or other), an admin, a mixed or unreadable chain, a remote label do not", async () => {
  await requireOwner(K(["p-owner"]), { token: "t" });
  await requireOwner(K([]), { caller: "cli" });
  await requireOwner(K([]), { caller: "local" });
  for (const hops of [["p-alice"], ["p-admin"], ["p-owner", "p-alice"]]) await assert.rejects(requireOwner(K(hops), { token: "t" }), e => e.code === "denied" && /only the Space owner/.test(e.message));
  await assert.rejects(requireOwner(K([]), { caller: "device:abc" }), e => e.code === "denied");
  await assert.rejects(requireOwner(K([]), { caller: "mcp:agent:x" }), e => e.code === "denied");
  await assert.rejects(requireOwner(K([]), {}), e => e.code === "denied");
  await assert.rejects(requireOwner({ owner: "p-owner", chain: async () => { throw new Error("x"); } }, { token: "t" }), e => e.code === "denied");
  await assert.rejects(requireOwner(null, { caller: "cli" }), e => e.code === "denied");
});

test("emailProblem: needs a firm key, the key's domain, and an address no one else holds", () => {
  const keys = [{ name: "f", email: "admin@firm.test", firm: true }];
  const ok = { email: "alice@firm.test", person: "p-alice", firmKeys: keys, taken: () => null };
  assert.equal(emailProblem(ok), null);
  assert.match(emailProblem({ ...ok, firmKeys: [] }), /firm key first/);
  assert.match(emailProblem({ ...ok, email: "a@evil.test" }), /outside/);
  assert.match(emailProblem({ ...ok, taken: () => "p-owner" }), /another person/);
  assert.equal(emailProblem({ ...ok, taken: () => "p-alice" }), null);
});
