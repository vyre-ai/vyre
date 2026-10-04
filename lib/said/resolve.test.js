// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, recipientId, literal, canonical } from "./resolve.js";

const CONTACTS = [
  { id: "c_priya", name: "Priya Shah", addresses: ["priya@harlow.example"] },
  { id: "c_sam_lee", name: "Sam Lee", addresses: ["sam.lee@northwind.example"] },
  { id: "c_sam_ortiz", name: "Sam Ortiz", aliases: ["Sammy"], addresses: ["sam@ortiz.example"] },
  { id: "c_northwind", name: "Northwind Bakery", aliases: ["Northwind"], addresses: ["orders@northwind.example", "shared@harlow.example"] },
  { id: "c_harlow", name: "Harlow Legal", addresses: ["shared@harlow.example"] },
];
const one = (to, opts) => resolve([{ to }], CONTACTS, opts)[0];

test("a unique name or alias resolves to its contact", () => {
  assert.deepEqual(one(["Priya"]).to_ids, ["c_priya"]);
  assert.deepEqual(one(["priya shah"]).to_ids, ["c_priya"]);
  assert.deepEqual(one(["Sammy"]).to_ids, ["c_sam_ortiz"]);
  assert.deepEqual(one(["Northwind"]).to_ids, ["c_northwind"]);
});

test("a name two contacts share resolves to nothing", () => {
  const r = one(["Sam"]);
  assert.equal(r.to_ids, null);
  assert.deepEqual(r.unresolved, ["Sam"]);
  assert.deepEqual(one(["Sam Lee"]).to_ids, ["c_sam_lee"]);
});

test("an unknown name resolves to nothing, and poisons the whole intent", () => {
  const r = one(["Priya", "Taylor"]);
  assert.equal(r.to_ids, null);
  assert.deepEqual(r.unresolved, ["Taylor"]);
});

test("no fuzzy or partial-word matching", () => {
  assert.equal(one(["Pri"]).to_ids, null);
  assert.equal(one(["Shah Priya"]).to_ids, null);
  assert.equal(one(["Bakery North"]).to_ids, null);
});

test("an address, handle, channel or phone number resolves to itself", () => {
  assert.deepEqual(one(["Jordan@Harlow.example"]).to_ids, ["jordan@harlow.example"]);
  assert.deepEqual(one(["#launch"]).to_ids, ["#launch"]);
  assert.deepEqual(one(["@kit"]).to_ids, ["@kit"]);
  assert.deepEqual(one(["+1 (555) 010-2233"]).to_ids, ["+15550102233"]);
  assert.equal(literal("Priya"), false);
  assert.equal(canonical("PRIYA@HARLOW.EXAMPLE"), "priya@harlow.example");
});

test("a reply with no named recipient takes the caller's current sender, or stays unresolved", () => {
  assert.deepEqual(resolve([{ to: [], reply_to_current: true }], CONTACTS, { replyTo: ["c_priya"] })[0].to_ids, ["c_priya"]);
  assert.equal(resolve([{ to: [], reply_to_current: true }], CONTACTS)[0].to_ids, null);
});

test("an intent with no recipients resolves to an empty list", () => {
  assert.deepEqual(one([]).to_ids, []);
});

test("recipientId maps an address to its one owner, else to itself", () => {
  assert.equal(recipientId("PRIYA@harlow.example", CONTACTS), "c_priya");
  assert.equal(recipientId("shared@harlow.example", CONTACTS), "shared@harlow.example");
  assert.equal(recipientId("stranger@evil.example", CONTACTS), "stranger@evil.example");
});
