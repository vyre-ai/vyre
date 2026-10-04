import "../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { conformance, CONTACT } from "../../kernel/conformance/suite.js";
import { mintUuid } from "../../kernel/core/ids.js";
import { createTwentyStore } from "./store.js";
import { TwentyClient } from "./client.js";
import { FakeTwenty } from "./testing/fake-twenty.js";
import { specific } from "./specific-suite.js";
import { planType, toFilter, toOrderBy, toInput, fromRow, selection, checkData } from "./plan.js";

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(SCRATCH, "tw-")); dirs.push(d); return d; };
const fake = await new FakeTwenty().start();
after(async () => { await fake.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A store over the shared fake Twenty, fresh state each time. */
async function boot({ dir = tmp(), secret = crypto.randomBytes(16).toString("hex"), keep = false } = {}) {
  if (!keep) fake.reset();
  const client = new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} });
  const store = createTwentyStore({ client, space: "harlow", dir, webhookSecret: secret, graceMs: 0 });
  fake.deliver = async (payload, headers, raw) => { await store.handleWebhook(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), raw); };
  return { store, client, dir, secret };
}

// ---- the kernel's conformance suite: the definition of a store ---------------------------------
conformance(async () => { const b = await boot(); await b.store.registerWebhook("fn:store"); return b.store; }, { test, assert }, "twenty (fake twenty)");

// ---- what only this store has to prove ---------------------------------------------------------
specific("twenty (fake twenty)", { test }, { assert }, {
  async make() {
    const b = await boot(); await b.store.registerWebhook("fn:store");
    const behind = async (type, id, patch) => { const p = b.store.plans.get(type); fake.behind(p.singular, id, toInput(p, patch)); };
    return { store: b.store, behind, touch: async (type, id) => fake.touch(b.store.plans.get(type).singular, id), wire: () => JSON.stringify(fake.requests), cleanup: async () => {} };
  },
});

test("what Twenty is sent for a sealed field is the reference and nothing else", async () => {
  const b = await boot(); await b.store.define({ add_types: [CONTACT] });
  await b.store.create("contact", mintUuid(), { name: "Ref", ssn: { sealed: "ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 } });
  const create = fake.requests.filter((r) => r.op === "Create_contact").at(-1).variables.d;
  assert.deepEqual(create.ssn, { sealed: "ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 });
  assert.equal(create.vyreVersion, 1);
});

test("the store sends our id unchanged and a refused UUID never reaches Twenty", async () => {
  const b = await boot(); await b.store.define({ add_types: [CONTACT] });
  const id = mintUuid(); await b.store.create("contact", id, { name: "x" });
  assert.equal(fake.requests.filter((r) => r.op === "Create_contact").at(-1).variables.d.id, id);
  const n = fake.requests.length;
  await assert.rejects(b.store.create("contact", "01a101b0-a370-7000-b5d3-0f0df5924247", { name: "v7" }), { code: "invalid" });
  assert.equal(fake.requests.length, n, "refused before any request");
});

test("a rate limit is retried, then reported as unavailable", async () => {
  const b = await boot(); await b.store.define({ add_types: [CONTACT] });
  fake.limit = 0;
  await assert.rejects(b.store.get("contact", mintUuid()), { code: "unavailable" });
  fake.limit = Infinity; fake.served = 0;
  assert.equal(await b.store.get("contact", mintUuid()), null);
});

test("state survives a restart: types, snapshots, versions and the change log", async () => {
  const dir = tmp();
  const a = await boot({ dir }); await a.store.define({ add_types: [CONTACT] });
  await a.store.registerWebhook("fn:store");
  const id = mintUuid();
  await a.store.create("contact", id, { name: "Persist", age: 3 });
  fake.behind("contact", id, { age: 4 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await a.store.changes(null, 100)).entries.filter((e) => e.source === "twenty").length, 1);
  const b = await boot({ dir, keep: true, secret: a.secret });
  assert.ok(b.store.plans.has("contact"), "types reload");
  assert.equal(b.store.snaps.get("contact", id).data.name, "Persist");
  const log = (await b.store.changes(null, 100)).entries;
  assert.deepEqual(log.map((e) => e.kind), ["created", "updated"]);
  const c2 = await b.store.update("contact", id, { age: 5 }, 2);
  assert.equal(c2.version, 3);
  assert.equal((await b.store.changes(null, 100)).entries.length, 3, "the cursor keeps counting after a restart");
});

test("plan: names, reserved words, filters, order and values", () => {
  const p = planType(CONTACT);
  assert.equal(p.singular, "contact"); assert.equal(p.plural, "contacts");
  assert.equal(p.byVyre.get("name").twenty, "name");
  assert.equal(planType({ name: "match", label: "Match", fields: [{ name: "t", kind: "text", label: "T" }] }).plural, "matches");
  assert.equal(planType({ name: "address", label: "A", fields: [{ name: "t", kind: "text", label: "T" }] }).singular, "addressCustom");
  assert.equal(planType({ name: "thing", label: "T", fields: [{ name: "t", kind: "text", label: "T" }, { name: "address", kind: "address", label: "A" }] }).byVyre.get("address").twenty, "addressCustom");
  assert.equal(planType({ name: "person", label: "P", fields: [] }).singular, "vyrePerson", "a name Twenty uses for a standard object is stored under a vyre prefix");
  assert.equal(planType({ name: "task", label: "T", fields: [] }).plural, "vyreTasks");
  assert.equal(planType({ name: "team-member", label: "T", fields: [] }).singular, "teamMember");
  assert.throws(() => planType({ name: "thing", label: "T", fields: [{ name: "t", kind: "text", label: "T" }, { name: "position", kind: "number", label: "P" }] }), /collides/);
  assert.throws(() => planType({ name: "thing", label: "T", fields: [{ name: "t", kind: "text", label: "T" }, { name: "c", kind: "choice", label: "C", options: ["a b", "A-B"] }] }), /distinct/);
  assert.deepEqual(toFilter(p, { and: [{ field: "status", op: "eq", value: "open" }, { field: "age", op: "gt", value: 20 }] }), { and: [{ status: { eq: "OPEN" } }, { age: { gt: 20 } }] });
  assert.deepEqual(toFilter(p, { field: "fee", op: "gte", value: { amount: 2.5, currency: "USD" } }), { fee: { amountMicros: { gte: 2_500_000 } } });
  assert.deepEqual(toFilter(p, { field: "tags", op: "contains", value: "vip" }), { tags: { containsAny: ["VIP"] } });
  assert.deepEqual(toFilter(p, { field: "name", op: "contains", value: "50%" }), { name: { ilike: "%50\\%%" } });
  assert.deepEqual(toFilter(p, { field: "updated_at", op: "gt", value: 1_790_000_000_000 }), { updatedAt: { gt: new Date(1_790_000_000_000).toISOString() } });
  assert.throws(() => toFilter(p, { field: "ssn", op: "is_null" }), /sealed/);
  assert.throws(() => toFilter(p, { field: "nope", op: "eq", value: 1 }), { code: "unknown_field" });
  assert.deepEqual(toOrderBy(p, [{ field: "fee", dir: "desc" }]), [{ fee: { amountMicros: "DescNullsLast" } }, { id: "AscNullsFirst" }]);
  assert.deepEqual(toInput(p, { status: "open", tags: ["vip", "lead"], fee: { amount: 1.5, currency: "USD" }, age: null }), { status: "OPEN", tags: ["VIP", "LEAD"], fee: { amountMicros: 1_500_000, currencyCode: "USD" }, age: null });
  const rec = fromRow(p, { id: "i", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null, vyreVersion: 3, name: "Jane", age: null, tags: ["LEAD"], status: "CLOSED", fee: { amountMicros: 250_000_000, currencyCode: "USD" }, born: "1980-02-03", ssn: null });
  assert.deepEqual(rec.data, { name: "Jane", tags: ["lead"], status: "closed", fee: { amount: 250, currency: "USD" }, born: "1980-02-03" });
  assert.equal(rec.version, 3);
  assert.equal(fromRow(p, { id: "i", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", name: "" }).version, 1, "a row Twenty made itself starts at version 1");
  assert.equal(checkData(p, { name: "x", born: "1980-02-03T10:00:00Z" })?.code, "invalid");
  assert.match(selection(p), /fee \{ amountMicros currencyCode \}/);
});
