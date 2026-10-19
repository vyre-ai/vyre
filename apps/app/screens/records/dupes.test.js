// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDupes } from "./dupes.js";

const def = { fields: [{ name: "name" }, { name: "email" }, { name: "phone" }] };
const rows = [
  { urn: "u/contact/1", data: { name: "Ana Ruiz", email: "ana@lumenlabs.io", phone: "+14155550100" } },
  { urn: "u/contact/2", data: { name: "Marcus Okafor", email: "marcus@okafor.com" } },
];
const title = (/** @type {any} */ r) => r.data.name;

test("a typed email, phone or name finds the record that already has it, the email first", () => {
  assert.deepEqual(findDupes(def, rows, { email: " Ana@LumenLabs.io " }, title), [{ urn: "u/contact/1", title: "Ana Ruiz", why: "the same email" }]);
  assert.deepEqual(findDupes(def, rows, { phone: "+14155550100" }, title)[0].why, "the same phone");
  assert.deepEqual(findDupes(def, rows, { name: "marcus  okafor" }, title), [{ urn: "u/contact/2", title: "Marcus Okafor", why: "the same name" }]);
  assert.equal(findDupes(def, rows, { name: "Ana Ruiz", email: "ana@lumenlabs.io" }, title)[0].why, "the same email");
});

test("nothing typed, a short name or a type without those fields finds nothing", () => {
  assert.deepEqual(findDupes(def, rows, {}, title), []);
  assert.deepEqual(findDupes(def, rows, { name: "An" }, title), []);
  assert.deepEqual(findDupes({ fields: [{ name: "note" }] }, rows, { name: "Ana Ruiz" }, title), []);
  assert.deepEqual(findDupes(def, undefined, { name: "Ana Ruiz" }, title), []);
});

test("a list of emails is read by its first address; at most three are shown", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ urn: `u/c/${i}`, data: { name: "Same Name" } }));
  assert.equal(findDupes(def, many, { name: "Same Name" }, title).length, 3);
  const withList = [{ urn: "u/c/9", data: { emails: [{ address: "x@y.co" }] } }];
  assert.equal(findDupes({ fields: [{ name: "emails" }] }, withList, { emails: [{ address: "X@Y.co" }] }, () => "x").length, 1);
});
