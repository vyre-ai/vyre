// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { allowed, boundsOf, covered, recipientOf, sendsOf, DEFAULTS } from "./standing.js";
import { patternCovers } from "../core/authorize.js";

const cat = { actions: { "mail.send": { risk: "outward.send", recipients: ["to", "cc"], inputs: { to: "string", cc: "string", body: "string" } }, "mail.blind": { risk: "outward.send", inputs: { to: "string" } }, "crm.read": { risk: "read" } } };
const flow = (/** @type {any} */ steps, /** @type {any} */ extra = {}) => ({ steps, ...extra });
const send = (/** @type {any} */ input, /** @type {any} */ extra = {}) => ({ id: "s", kind: "call", action: "mail.send", resource: "vyre://x/tool/mail.send", input, ...extra });

test("a recipient the Flow names itself is on its allow list; one from a read or trigger is outside", () => {
  assert.deepEqual(recipientOf(send({ to: "A@x.com" }), cat), { values: ["A@x.com"], literal: true });
  assert.equal(recipientOf(send({ to: { expr: "trigger.who" } }), cat).literal, false);
  assert.equal(recipientOf(send({ to: "a@x.com", cc: { expr: "trigger.who" } }), cat).literal, false, "a second destination field counts too");
  assert.deepEqual(boundsOf(flow([send({ to: "A@x.com" })]), cat).allow, ["a@x.com"]);
  assert.deepEqual(boundsOf(flow([send({ to: "a@x.com" })], { sends: { allow: ["@firm.com"], max: 5 } }), cat), { allow: ["@firm.com"], max: 5, per_minute: DEFAULTS.per_minute, outside: "ask" });
});

test("only a tool whose module declared its destinations, with no undeclared input, is covered", () => {
  assert.ok(covered(send({ to: "a@x.com" }), cat));
  assert.ok(!covered(send({ to: "a@x.com", bcc: "z@y.com" }), cat), "an undeclared field is unchecked");
  assert.ok(!covered({ ...send({ to: "a@x.com" }), action: "mail.blind" }, cat), "no declaration, no cover");
  assert.ok(!covered(send({ to: [{ email: "a@x.com" }] }), cat), "a list of objects holds recipients nothing can read");
  assert.ok(!covered(send({ to: { email: "a@x.com" } }), cat), "an object is not an address");
  assert.ok(covered(send({ to: ["a@x.com", "b@x.com"] }), cat), "a list of addresses is");
});

test("a domain entry covers its addresses and nothing else", () => {
  assert.ok(allowed("Bo@firm.com", ["@firm.com"]));
  assert.ok(!allowed("bo@evilfirm.com.au", ["@firm.com"]));
  assert.ok(!allowed("bo@other.com", ["a@x.com"]));
  assert.ok(!allowed("user@evil.com@firm.com", ["@firm.com"]), "two @ signs is no address");
});

test("sendsOf lists each send with where its recipient comes from and whether it always asks", () => {
  assert.deepEqual(sendsOf(flow([send({ to: "a@x.com" }), send({ to: { expr: "trigger.who" } }, { id: "t", approve: true }), { id: "r", kind: "call", action: "crm.read", resource: "r", input: {} }]), cat),
    [{ step: "s", action: "mail.send", to: ["a@x.com"], source: "literal", approve: false, covered: true }, { step: "t", action: "mail.send", to: [], source: "outside", approve: true, covered: true }]);
});

test("no wildcard covers the standing-send action: only a grant that names it does", () => {
  assert.equal(patternCovers("flows.act-standing", "flows.act-standing", 0, 1, "write"), "covered");
  assert.equal(patternCovers("flows.*", "flows.act-standing", 0, 1, "write"), null);
  assert.equal(patternCovers("*", "flows.act-standing", 0, 1, "write"), null);
});
