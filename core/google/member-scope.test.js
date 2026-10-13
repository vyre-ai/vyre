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
