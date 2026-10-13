// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { forMember } from "./member-account.js";
import { MIGRATIONS, store, memberEmails, check } from "./accounts.js";

const firm = { name: "firm", domain: "firm.test", firm: true, auth: { type: "m365-app", item: "k" } };
const alice = { id: "p-alice", email: "alice@firm.test", verified: true };

test("a member's account acts as their own mailbox; another mailbox, an unverified or outside email, no key: refused", () => {
  const a = forMember([firm], alice);
  assert.equal(a[0].mailbox, "alice@firm.test"); assert.equal(a[0].auth.item, "k"); assert.equal(a[0].auth.type, "m365-app");
  assert.equal(forMember([firm], alice, { mailbox: "ALICE@firm.test" })[0].mailbox, "alice@firm.test");
  for (const mailbox of ["bob@firm.test", "admin@firm.test"]) assert.throws(() => forMember([firm], alice, { mailbox }), e => e.code === "denied");
  assert.throws(() => forMember([firm], { ...alice, verified: false }), e => e.code === "denied");
  assert.throws(() => forMember([firm], { id: "x", email: "a@evil.test", verified: true }), e => e.code === "denied");
  assert.throws(() => forMember([firm], { id: "x", verified: true }), e => e.code === "denied");
  assert.throws(() => forMember([], alice), e => e.code === "no_account");
  assert.throws(() => forMember([{ ...firm, firm: false }], alice), e => e.code === "no_account");
});

test("tables: a firm app row and attested emails round-trip; check refuses a bad domain, item or non-loopback base", () => {
  const db = new DatabaseSync(":memory:"); for (const m of MIGRATIONS) db.exec(m);
  const s = store(db); const r = s.put({ name: "firm", domain: "Firm.Test", item: "m365-key" }, 1);
  assert.equal(r.domain, "firm.test"); assert.equal(r.firm, true); assert.equal(r.auth.type, "m365-app");
  const me = memberEmails(db); me.set("p-alice", "Alice@Firm.test", "owner", 2);
  assert.deepEqual(me.get("p-alice"), { id: "p-alice", email: "alice@firm.test", verified: true }); assert.equal(me.holder("alice@firm.test"), "p-alice");
  assert.equal(me.clear("p-alice"), true);
  assert.match(check({ name: "Firm", domain: "firm.test", item: "k" }), /name/);
  assert.match(check({ name: "firm", domain: "nope", item: "k" }), /domain/);
  assert.match(check({ name: "firm", domain: "firm.test", item: "../k" }), /item/);
  assert.match(check({ name: "firm", domain: "firm.test", item: "k", base: "https://evil.example" }), /loopback/);
  assert.equal(check({ name: "firm", domain: "firm.test", item: "k", base: "http://127.0.0.1:9" }), null);
});
