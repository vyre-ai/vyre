// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { forMember } from "./member-account.js";

const firm = { name: "firm", email: "admin@firm.test", firm: true, auth: { type: "service-account", item: "firm-sa", subject: "admin@firm.test" } };
const owner = { name: "mine", email: "owner@firm.test", auth: { type: "oauth", item: "tok" } };
const alice = { id: "p-alice", email: "alice@firm.test", verified: true };

test("a member's account acts as the member's own mailbox", () => {
  const a = forMember([firm, owner], alice);
  assert.equal(a.length, 1);
  assert.equal(a[0].email, "alice@firm.test");
  assert.equal(a[0].auth.subject, "alice@firm.test");
  assert.equal(a[0].auth.item, "firm-sa");
  assert.notEqual(a[0].name, "firm");
});

test("asking for another person's mailbox is refused", () => {
  assert.throws(() => forMember([firm], alice, { mailbox: "bob@firm.test" }), e => e.code === "denied");
  assert.throws(() => forMember([firm], alice, { mailbox: "admin@firm.test" }), e => e.code === "denied");
  assert.equal(forMember([firm], alice, { mailbox: "ALICE@firm.test" })[0].auth.subject, "alice@firm.test");
});

test("an unverified or outside-domain email gets nothing", () => {
  assert.throws(() => forMember([firm], { id: "x", email: "a@firm.test", verified: false }), e => e.code === "denied");
  assert.throws(() => forMember([firm], { id: "x", email: "a@evil.test", verified: true }), e => e.code === "denied");
  assert.throws(() => forMember([firm], { id: "x", verified: true }), e => e.code === "denied");
});

test("the owner's own accounts are never handed to a member", () => {
  assert.throws(() => forMember([owner], alice), e => e.code === "no_account");
});

test("domain scope: a firm key limited to a domain refuses other domains", () => {
  const scoped = { ...firm, domain: "firm.test" };
  assert.equal(forMember([scoped], alice).length, 1);
  assert.throws(() => forMember([scoped], { id: "x", email: "a@other.test", verified: true }), e => e.code === "denied");
});
