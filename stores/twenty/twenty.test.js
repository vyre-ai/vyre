import "../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { conformance, CONTACT, SUITE_SPACE } from "../../kernel/conformance/suite.js";
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
  const store = createTwentyStore({ client, space: SUITE_SPACE, dir, webhookSecret: secret, graceMs: 0 });
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

test("a total is computed inside Twenty in one request, and the answer is the same as folding the rows", async () => {
  const b = await boot(); await b.store.define({ add_types: [CONTACT] });
  const rows = [["open", 10, 100], ["open", 20, 50], ["closed", 30, 70], ["closed", null, 0], [undefined, 5, 5]];
  for (const [status, age, amt] of rows) await b.store.create("contact", mintUuid(), { name: "n", ...(status ? { status } : {}), ...(age === null ? {} : { age }), fee: { amount: amt, currency: "USD" } });
  const spec = { group_by: ["status"], measures: [{ fn: "count" }, { fn: "count", field: "age" }, { fn: "sum", field: "age" }, { fn: "avg", field: "age" }, { fn: "min", field: "age" }, { fn: "max", field: "age" }, { fn: "sum", field: "fee.amount" }, { fn: "max", field: "fee.amount" }] };
  const before = fake.requests.length;
  const native = await b.store.aggregate("contact", spec);
  const ops = fake.requests.slice(before).map((r) => r.op);
  assert.deepEqual(ops, ["Agg_contacts"], "one group-by request, no row scan");
  const all = (await b.store.query("contact", { page: { limit: 100 } })).rows;
  assert.deepEqual(native, (await import("../../kernel/store/query.js")).aggregate(all, spec));
  const total = await b.store.aggregate("contact", { filter: { field: "age", op: "gt", value: 6 }, measures: [{ fn: "count" }, { fn: "sum", field: "age" }] });
  assert.deepEqual(total, [{ group: {}, values: { count: 3, "sum:age": 60 } }]);
  // what Twenty cannot group (a list, a dotted path other than money's amount) is folded from the rows, with the same answer
  const n = fake.requests.length;
  const tags = await b.store.aggregate("contact", { group_by: ["tags"], measures: [{ fn: "count" }] }).catch((e) => e.code);
  assert.ok(fake.requests.slice(n).every((r) => !r.op.startsWith("Agg_")), `a list field is not grouped natively (${JSON.stringify(tags).slice(0, 60)})`);
});

test("a search asked again for the same words, a page later, does not scan again; a write drops what was kept", async () => {
  const b = await boot(); await b.store.define({ add_types: [CONTACT] });
  for (const n of ["Harlow Jane", "Harlow Bob", "Northwind Cy"]) await b.store.create("contact", mintUuid(), { name: n });
  const first = await b.store.search({ text: "harlow", page: { limit: 1 } });
  assert.equal(first.rows.length, 1);
  const n = fake.requests.length;
  const second = await b.store.search({ text: "harlow", page: { limit: 1, cursor: first.next_cursor } });
  assert.equal(second.rows.length, 1);
  assert.equal(fake.requests.slice(n).filter((r) => r.op.startsWith("Q_")).length, 0, "the next page came from what was kept");
  await b.store.create("contact", mintUuid(), { name: "Harlow Al" });
  const m = fake.requests.length;
  assert.equal((await b.store.search({ text: "harlow", page: { limit: 10 } })).rows.length, 3);
  assert.ok(fake.requests.slice(m).some((r) => r.op.startsWith("Q_")), "a write dropped it");
});

test("attr_filter: a member's list and totals are filtered inside Twenty by the mirrored kernel attributes; a type with older rows refuses it", async () => {
  const b = await boot(); await b.store.define({ add_types: [CONTACT] });
  assert.equal(b.store.features().attr_filter, true);
  const mk = async (name, attrs) => { const id = mintUuid(); await b.store.create("contact", id, { name, status: "open", age: 1 }); b.store.meta.set(`vyre://${b.store.space}/contact/${id}`, attrs); return id; };
  const a1 = await mk("A1", { project: "p1", owner: "per_x" }), a2 = await mk("A2", { project: "p2" }), a3 = await mk("A3", { project: "p1", owner: "per_y" }); await mk("A4", {});
  const prefix = `vyre://${b.store.space}/contact/`;
  const names = async (any) => (await b.store.query("contact", { attr_filter: { urn_prefix: prefix, any }, page: { limit: 50 } })).rows.map((r) => r.data.name).sort();
  assert.deepEqual(await names([{ project: "p1" }]), ["A1", "A3"]);
  assert.deepEqual(await names([{ project: "p1", owner: "per_x" }, { project: "p2" }]), ["A1", "A2"], "all terms of any one alternative");
  assert.deepEqual(await names([]), [], "an empty any wants no row");
  assert.deepEqual(await names([{ owner: "per_nobody" }]), [], "a row with no value matches nothing");
  const before = fake.requests.length;
  const total = await b.store.aggregate("contact", { attr_filter: { urn_prefix: prefix, any: [{ project: "p1" }] }, group_by: ["status"], measures: [{ fn: "count" }] });
  assert.deepEqual(total.map((g) => [g.group.status, g.values.count]), [["open", 2]]);
  assert.deepEqual(fake.requests.slice(before).map((r) => r.op).filter((o) => o.startsWith("Agg_") || o.startsWith("Q_")), ["Agg_contacts"], "one native total, no row scan");
  assert.deepEqual((await b.store.query("contact", { filter: { field: "name", op: "eq", value: "A3" }, attr_filter: { urn_prefix: prefix, any: [{ project: "p1" }] }, page: { limit: 5 } })).rows.map((r) => r.id), [a3], "the caller's own filter still applies");
  await assert.rejects(() => b.store.query("contact", { attr_filter: { urn_prefix: prefix, any: [{ colour: "red" }] }, page: { limit: 5 } }), { code: "unsupported" });
  await assert.rejects(() => b.store.query("contact", { attr_filter: { urn_prefix: `vyre://${b.store.space}/matter/`, any: [{ project: "p1" }] }, page: { limit: 5 } }), { code: "unsupported" });
  // a type whose rows were made before the mirror: refused, never answered from a partial mirror
  b.store.mirrorReady.delete("contact");
  await assert.rejects(() => b.store.query("contact", { attr_filter: { urn_prefix: prefix, any: [{ project: "p1" }] }, page: { limit: 5 } }), { code: "unsupported" });
  void a1; void a2;
});

// ---- links as relations (plan item 9) --------------------------------------------------------------
const LEAD_OLD = { name: "lead", label: "Lead", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "contact", kind: "link", label: "Contact" }] };
const LEAD_NEW = { name: "lead", label: "Lead", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "contact", kind: "link", label: "Contact", to: "contact", inverse: { name: "leads", label: "Leads" } }] };
const cu = (id) => `vyre://${SUITE_SPACE}/contact/${id}`;

test("twenty: a link to a type is a Twenty relation (the join column and the inverse on the target), a link to any record stays text, and a list link has a junction object", async () => {
  const b = await boot();
  const t = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "client", kind: "link", label: "Client", to: "contact", inverse: { name: "matters", label: "Matters" } }, { name: "about", kind: "link", label: "About" }, { name: "parties", kind: "link", label: "Parties", to: "contact", many: true, inverse: { name: "matters_parties", label: "Matters (Parties)" } }] };
  await b.store.define({ add_types: [CONTACT, t] });
  const f = (obj) => fake.objects.get(obj).fields;
  assert.equal(f("matter").get("client").type, "RELATION");
  assert.equal(f("matter").get("clientId").type, "UUID", "the join column");
  assert.equal(f("contact").get("matters").type, "RELATION", "the named inverse is on the target");
  assert.equal(f("matter").get("about").type, "TEXT", "a link to any record stays text");
  assert.equal(f("matter").has("parties"), false, "a list link is no column on the record");
  const jn = fake.objects.get("vyreLinkMatterParties");
  assert.ok(jn && jn.fields.get("fromRec").type === "RELATION" && jn.fields.get("toRec").type === "RELATION", "the junction object");
  const c = await b.store.create("contact", mintUuid(), { name: "Jane" });
  const m = await b.store.create("matter", mintUuid(), { title: "x", client: { urn: cu(c.id) }, about: { urn: cu(c.id) }, parties: [{ urn: cu(c.id) }] });
  assert.equal(fake.rows.get("matter").get(m.id).clientId, c.id, "the column holds the target's row id, not a urn");
  assert.equal(fake.rows.get("vyreLinkMatterParties").size, 1);
  assert.deepEqual((await b.store.get("matter", m.id)).data.parties, [{ urn: cu(c.id) }]);
  // a link to a record that is not there is refused (the relation's foreign key), and a urn of another Space or type never gets that far
  await assert.rejects(() => b.store.create("matter", mintUuid(), { title: "y", client: { urn: cu(mintUuid()) } }), { code: "invalid", message: /does not exist/ });
  await assert.rejects(() => b.store.create("matter", mintUuid(), { title: "y", client: { urn: `vyre://spc_other/contact/${c.id}` } }), { code: "invalid" });
  // destroying a record for good takes its links out of the junctions
  await b.store.destroy("contact", c.id);
  assert.equal(fake.rows.get("vyreLinkMatterParties").size, 0);
});

test("twenty: links stored as urn text move onto relations when the type is defined with a target: carried over, a dangling urn counted, the text field gone, and nothing reads as an outside edit", async () => {
  const b = await boot();
  await b.store.define({ add_types: [CONTACT, LEAD_OLD] });
  const c1 = await b.store.create("contact", mintUuid(), { name: "A" }), c2 = await b.store.create("contact", mintUuid(), { name: "B" });
  const l1 = await b.store.create("lead", mintUuid(), { title: "1", contact: { urn: cu(c1.id) } });
  const l2 = await b.store.create("lead", mintUuid(), { title: "2", contact: { urn: cu(c2.id) } });
  const dangling = await b.store.create("lead", mintUuid(), { title: "3", contact: { urn: cu(mintUuid()) } });
  const none = await b.store.create("lead", mintUuid(), { title: "4" });
  await b.store.remove("lead", l2.id, 1);
  const changesBefore = (await b.store.changes(null, 1000)).entries.length;
  const r = await b.store.define({ change_types: [LEAD_NEW] });
  assert.ok(r.changes.some((x) => /moved links lead\.contact to a relation \(2 carried over, 1 named a record that is gone\)/.test(x)), r.changes.join("; "));
  const lead = fake.objects.get("lead").fields;
  assert.equal(lead.get("contact").type, "RELATION"); assert.equal(lead.has("contactOld"), false, "the text field is dropped");
  assert.deepEqual((await b.store.get("lead", l1.id)).data.contact, { urn: cu(c1.id) });
  assert.deepEqual((await b.store.get("lead", dangling.id)).data.contact, undefined);
  assert.deepEqual((await b.store.get("lead", none.id)).data.contact, undefined);
  assert.deepEqual((await b.store.get("lead", l2.id, { include_deleted: true })).data.contact, { urn: cu(c2.id) }, "a removed record's link is carried too");
  assert.deepEqual((await b.store.query("lead", { filter: { field: "contact", op: "eq", value: { urn: cu(c1.id) } }, page: { limit: 10 } })).rows.map((x) => x.id), [l1.id]);
  assert.equal((await b.store.changes(null, 1000)).entries.length, changesBefore, "the move is not an edit: no row got a new version or a change line");
  assert.equal((await b.store.get("lead", l1.id)).version, 1);
  // run again: nothing to do
  assert.equal((await b.store.upgradeLinks()).applied, false);
});

test("twenty: an empty `in` list matches nothing and is never sent to Twenty as an empty list; a list link with no link rows is found by nothing and is_null finds it", async () => {
  const b = await boot();
  await b.store.define({ add_types: [CONTACT, { name: "lead", label: "Lead", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "refs", kind: "link", label: "Refs", to: "contact", many: true, inverse: { name: "refd", label: "Refd" } }] }] });
  const c = await b.store.create("contact", mintUuid(), { name: "A" });
  const l = await b.store.create("lead", mintUuid(), { title: "x" });
  assert.deepEqual((await b.store.query("lead", { filter: { field: "id", op: "in", value: [] }, page: { limit: 5 } })).rows, []);
  assert.deepEqual((await b.store.query("lead", { filter: { field: "refs", op: "contains", value: { urn: cu(c.id) } }, page: { limit: 5 } })).rows, []);
  assert.deepEqual((await b.store.query("lead", { filter: { field: "refs", op: "is_null" }, page: { limit: 5 } })).rows.map((x) => x.id), [l.id]);
  await b.store.update("lead", l.id, { refs: [{ urn: cu(c.id) }] }, 1);
  assert.deepEqual((await b.store.query("lead", { filter: { field: "refs", op: "is_null" }, page: { limit: 5 } })).rows, []);
  assert.ok(!JSON.stringify(fake.requests).includes('"in":[]'), "no empty list went to Twenty");
});

test("scrub with an id set forgets a field's history for those records only: an unrelated record keeps its change log and its snapshot", async () => {
  const b = await boot(); await b.store.define({ add_types: [CONTACT] });
  const a = mintUuid(), other = mintUuid();
  await b.store.create("contact", a, { name: "Quoting the value 123-45-6789" });
  await b.store.create("contact", other, { name: "Unrelated" });
  await b.store.update("contact", a, { name: "Quoting it again 123-45-6789" }, 1);
  await b.store.update("contact", other, { name: "Still unrelated" }, 1);
  const named = async (id) => (await b.store.changes(null, 1000)).entries.filter((e) => e.id === id).some((e) => (e.before && "name" in e.before) || (e.after && "name" in e.after));
  assert.equal(await named(a), true, "the history holds the field before the scrub");
  await b.store.scrub("contact", ["name"], new Set([a]));
  assert.equal(await named(a), false, "the scrubbed record's log entries lost the field");
  assert.equal(await named(other), true, "an unrelated record keeps its title history");
  const key = (id) => b.store.snaps.get("contact", id);
  assert.equal(key(a) && key(a).data && "name" in key(a).data, false, "the scrubbed record's snapshot lost the field");
  assert.equal(key(other).data.name, "Still unrelated", "an unrelated record keeps its snapshot");
  // without a set the whole type is scrubbed, as a late seal of the type's own field needs
  await b.store.scrub("contact", ["name"]);
  assert.equal(await named(other), false);
});
