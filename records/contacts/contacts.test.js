// The contacts block on the built-in (SQLite) store, and what only that store proves: the lookup index really is used.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSqliteStore } from "../../kernel/store/sqlite.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { contactsSuite, rig } from "./suite.js";
import { normalizeEmail, normalizePhone, normalizeAddress, isNormalAddress } from "../../kernel/store/normal.js";

contactsSuite(async () => createSqliteStore({ db: new DatabaseSync(":memory:") }), { test, assert }, "sqlite");
contactsSuite(async () => createMemoryStore(), { test, assert }, "memory");

test("contacts (sqlite): a lookup on a link or a unique value looks at the matching rows, not at every row", async () => {
  const store = createSqliteStore({ db: new DatabaseSync(":memory:") });
  const { r, o, contacts } = await rig(store);
  await r.define(o, { add_types: [{ name: "ambassador", label: "Ambassador", role: { subject: ["contact"] }, fields: [{ name: "title", kind: "text", label: "T" }, { name: "contact", kind: "link", label: "C", to: "contact", required: true }] }] });
  const people = [];
  for (let i = 0; i < 300; i++) people.push(await r.create(o, "contact", { full_name: `P${i}` }));
  for (const p of people) await r.create(o, "ambassador", { title: p.data.full_name, contact: { urn: p.urn } });
  await contacts.addPoint(o, { owner: people[7], value: "p7@example.com" });
  await store.query("ambassador", { filter: { field: "contact", op: "eq", value: { urn: people[42].urn } }, page: { limit: 10 } });
  assert.equal(store.rowsExamined(), 1, "one role for this contact, found by the index");
  await store.query("contact-point", { filter: { and: [{ field: "kind", op: "eq", value: "email" }, { field: "value", op: "eq", value: "p7@example.com" }] }, page: { limit: 10 } });
  assert.equal(store.rowsExamined(), 1, "one contact-point for this address, found by its unique index inside an and");
  await store.query("ambassador", { page: { limit: 10 } });
  assert.equal(store.rowsExamined(), 300, "with no indexed filter it scans, and says so");
  assert.equal((await contacts.rolesOf(o, people[42])).length, 1);
  // after a restart the index is rebuilt from the rows
});

test("normal form: email lower-cased, phone E.164, and what is neither is refused", () => {
  assert.equal(normalizeEmail("Jane Doe <Jane@Example.COM>"), "jane@example.com");
  assert.equal(normalizeEmail(" JANE@example.com "), "jane@example.com");
  assert.equal(normalizeEmail("jane@example"), null);
  assert.equal(normalizeEmail("a b@example.com"), null);
  assert.equal(normalizePhone("(555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("1-555-123-4567"), "+15551234567");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("0044 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("020 7946 0958", { defaultCountry: "44" }), "+442079460958");
  assert.equal(normalizePhone("555-1234"), null);
  assert.equal(normalizePhone("555-123-4567 ext 12"), null);
  assert.equal(normalizePhone("call me"), null);
  assert.deepEqual(normalizeAddress("tel:+1 555 123 4567"), { kind: "phone", value: "+15551234567" });
  assert.equal(isNormalAddress("jane@example.com"), true);
  assert.equal(isNormalAddress("Jane@example.com"), false);
  assert.equal(isNormalAddress("+15551234567"), true);
  assert.equal(isNormalAddress("15551234567"), false);
});
