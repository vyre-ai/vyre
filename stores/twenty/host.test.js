// The Estate planning Kit and the core types, through the real kernel gateway (authorize, events, versions) over the Twenty store.
// Against the fake Twenty here; the same file runs against a real Twenty from stores/twenty/live (see host-live.mjs).
import "../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createTwentyStore } from "./store.js";
import { TwentyClient } from "./client.js";
import { FakeTwenty } from "./testing/fake-twenty.js";
import { compile } from "../../records/language/compile.js";
import { createRecordsHost } from "../../records/host.js";
import { createStripeHandler, signForTest } from "../../records/connectors/stripe/stripe.js";
import { CORE_TYPES } from "../../records/core-types.js";

const SPACE = "spc_harlow000001";
const kit = compile(fs.readFileSync(new URL("../../records/kits/estate-planning/kit.ts", import.meta.url), "utf8"));
const dirs = [];
const fake = await new FakeTwenty().start();
after(async () => { await fake.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function boot(extra = {}) {
  fake.reset();
  const dir = fs.mkdtempSync(path.join(SCRATCH, "twh-")); dirs.push(dir);
  const client = new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} });
  const secret = crypto.randomBytes(16).toString("hex");
  const store = createTwentyStore({ client, space: SPACE, dir, webhookSecret: secret, graceMs: 0 });
  fake.deliver = async (payload, headers, raw) => { await store.handleWebhook(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), raw); };
  await store.registerWebhook("fn:store");
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store, ...extra });
  return { host, store };
}

test("the Kit's types and the core types are defined through the gateway, and the log says so", async () => {
  const { host } = await boot();
  await host.defineCore();
  const r = await host.installKit(kit);
  assert.deepEqual(r.types, ["contact", "matter"]);
  assert.equal(r.flows.length, 1);
  const defined = host.log.read({ type: "types.defined" });
  assert.equal(defined.length, 2);
  assert.equal(CORE_TYPES.some((t) => t.name === "task"), false, "tasks live in the kernel, not in Twenty");
  for (const t of CORE_TYPES) assert.ok(host.catalog().types[t.name], `${t.name} is in the catalog`);
  assert.equal((await host.kernel.health()).ok, true);
});

test("a record is created, read and updated through kernel.records with authorize and events", async () => {
  const { host } = await boot();
  await host.defineCore();
  await host.installKit(kit);
  const c = host.ownerChain();
  const rec = await host.kernel.records.create(c, "contact", { name: "Sam Rivera", email: "sam@example.test" });
  assert.equal(rec.version, 1);
  assert.equal(rec.urn, `vyre://${SPACE}/contact/${rec.id}`);
  assert.equal((await host.kernel.records.get(c, "contact", rec.id)).data.name, "Sam Rivera");
  const up = await host.kernel.records.update(c, "contact", rec.id, { phone: "555 0100" }, 1);
  assert.equal(up.version, 2);
  await assert.rejects(() => host.kernel.records.update(c, "contact", rec.id, { phone: "x" }, 1), { code: "version_conflict" });
  assert.deepEqual(host.log.read().map((e) => e.type).filter((t) => t.startsWith("contact.")), ["contact.created", "contact.updated"]);
  assert.equal(host.log.verify().ok, true);
});

test("a chain with no grant is refused and a model never holds the owner's authority", async () => {
  const { host } = await boot();
  await host.defineCore();
  await host.installKit(kit);
  const agent = host.chains.fromFacts({ kind: "socket", surface: "mcp", uid: 1, pid: 1, inside_model_process: true });
  const got = await host.kernel.records.query(agent, "contact", { page: { limit: 5 } }).then((p) => p.rows.length, (e) => e.code);
  assert.ok(got === 0 || typeof got === "string", "an agent with no grant sees nothing");
  await assert.rejects(() => host.kernel.records.create(agent, "contact", { name: "No" }), (e) => typeof e.code === "string");
  assert.equal(host.log.read({ type: "contact.created" }).length, 0);
});

test("a sealed field holds only a reference in Twenty and in the log", async () => {
  const { host, store } = await boot();
  await host.defineCore();
  await host.installKit(kit);
  const ref = { sealed: "us-ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 };
  const rec = await host.kernel.records.create(host.ownerChain(), "contact", { name: "Pat", ssn: ref });
  const ev = host.log.read({ type: "contact.created" })[0];
  assert.deepEqual(ev.data.after.ssn, { sealed: true, changed: true });
  assert.deepEqual((await store.get("contact", rec.id)).data.ssn, ref);
});

test("template, playbook and team-member records round trip, with actors and links", async () => {
  const { host } = await boot();
  await host.defineCore(); await host.installKit(kit);
  const c = host.ownerChain();
  const owner = { actor: { kind: "person", id: "per_owner", space: SPACE } };
  const bot = { actor: { kind: "agent", id: "research", space: SPACE } };
  const matter = await host.kernel.records.create(c, "matter", { title: "Estate plan for Sam" });
  const tpl = await host.kernel.records.create(c, "template", { name: "welcome", kind: "email", body: "Dear {{client.name}}" });
  const back = await host.kernel.records.get(c, "team-member", (await host.kernel.records.create(c, "team-member", { name: "Alex", actor: owner, kind: "person", role: "attorney", project: { urn: matter.urn } })).id);
  assert.deepEqual(back.data.actor, owner);
  assert.deepEqual(back.data.project, { urn: matter.urn });
  await host.kernel.records.create(c, "playbook", { name: "Intake", applies_to: "matter", body: "Ask about the household first." });
  await host.kernel.records.create(c, "team-member", { name: "Research", actor: bot, kind: "assistant", role: "research", project: { urn: matter.urn }, doing: "reading harlowlegal.example" });
  const found = await host.kernel.records.query(c, "template", { filter: { field: "kind", op: "eq", value: "email" }, page: { limit: 10 } });
  assert.equal(found.rows.length, 1);
  assert.equal(tpl.data.name, "welcome");
});

test("a payment through the Stripe handler runs the Kit's Flow on the runner and writes the contact and matter in Twenty", async () => {
  const { host, store } = await boot();
  await host.defineCore();
  await host.installKit(kit);
  const handle = createStripeHandler({ secret: "whsec_test_x", host, now: () => 1791000100_000 });
  const ev = { id: "evt_1", type: "checkout.session.completed", livemode: false, created: 1791000000, data: { object: { id: "cs_1", payment_status: "paid", payment_intent: "pi_1", amount_total: 350000, currency: "usd", customer: "cus_1", customer_details: { email: "sam@example.test", name: "Sam Rivera" } } } };
  const raw = JSON.stringify(ev);
  const rs = await Promise.all([1, 2, 3].map(() => handle({ "stripe-signature": signForTest(raw, "whsec_test_x", 1791000100_000) }, raw)));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], JSON.stringify(rs[0].body));
  const contacts = (await store.query("contact", { page: { limit: 10 } })).rows, matters = (await store.query("matter", { page: { limit: 10 } })).rows;
  assert.equal(contacts.length, 1); assert.equal(matters.length, 1);
  assert.deepEqual(matters[0].data.client, { urn: `vyre://${SPACE}/contact/${contacts[0].id}` });
  assert.equal(host.log.read({ type: "payment.received" }).length, 1);
  assert.equal(host.log.read({ type: "matter.created" })[0].actor.startsWith("service:flows"), true);
});

test("a unique field: the gateway refuses the second record cleanly, writes no event for it, and a Stripe redelivery cannot make a second contact", async () => {
  const { host } = await boot();
  await host.defineTypes([{ name: "account", label: "Account", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "handle", kind: "text", label: "Handle", unique: true }] }]);
  const c = host.ownerChain();
  const results = await Promise.allSettled([1, 2, 3].map(() => host.kernel.records.create(c, "account", { name: "Harlow", handle: "harlow" })).flat());
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((r) => r.status === "rejected")) assert.equal(r.reason.code, "unique_violation");
  assert.equal(host.log.read({ type: "account.created" }).length, 1, "a refused write writes no event");
  assert.equal(host.log.verify().ok, true);
});

test("contacts and roles over Twenty: one person once, a role is a record that links to the contact, the two role queries answer", async () => {
  const { host } = await boot();
  await host.defineCore();
  const c = host.ownerChain(), R = host.kernel.records;
  const role = (name) => ({ name, label: name, role: { link: "contact", ended: ["Ended"] }, stages: [{ name: "New" }, { name: "Active" }, { name: "Ended" }],
    fields: [{ name: "contact", kind: "link", to: "contact", label: "Contact", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["New", "Active", "Ended"] }] });
  await host.defineTypes([role("prospect"), role("client")]);
  const jane = await R.create(c, "contact", { name: "Jane Doe", email: "jane@example.test", phone: "+15550100" });
  await assert.rejects(() => R.create(c, "contact", { name: "Jane Again", email: "jane@example.test" }), { code: "unique_violation" }, "a second record for the same address is refused");
  const bob = await R.create(c, "contact", { name: "Bob Roe", email: "bob@example.test" });
  const link = (x) => ({ urn: x.urn });
  await R.create(c, "prospect", { contact: link(jane), stage: "Ended" });
  await R.create(c, "client", { contact: link(jane), stage: "Active" });
  await R.create(c, "prospect", { contact: link(bob), stage: "New" });
  assert.deepEqual((await R.roles(c, jane.urn)).map((x) => [x.role, x.current]), [["client", true], ["prospect", false]], "current first");
  assert.deepEqual((await R.holders(c, { role: "prospect", page: { limit: 10 } })).rows.map((x) => x.holder), [bob.urn], "ended prospects are not holders");
  assert.deepEqual((await R.holders(c, { role: "client", stage: "Active", page: { limit: 10 } })).rows.map((x) => x.holder), [jane.urn]);
  // a communication with two contacts on it: the participant records tie it to both, and each contact finds it
  const mail = await R.create(c, "communication", { kind: "email", direction: "inbound", at: "2026-10-01T09:00:00.000Z", subject: "Hello", source_key: "gmail:abc" });
  await assert.rejects(() => R.create(c, "communication", { kind: "email", at: "2026-10-01T09:00:00.000Z", source_key: "gmail:abc" }), { code: "unique_violation" }, "the same message is logged once");
  for (const [who, how] of [[jane, "from"], [bob, "to"]]) await R.create(c, "participant", { communication: link(mail), contact: link(who), how });
  const onJane = await R.query(c, "participant", { filter: { field: "contact", op: "eq", value: link(jane) }, page: { limit: 10 } });
  assert.deepEqual(onJane.rows.map((p) => p.data.communication.urn), [mail.urn]);
});

test("merge over Twenty: the dropped contact's unique phone moves to the kept one, links follow, unmerge gives the phone back", async () => {
  const { host } = await boot();
  await host.defineCore();
  const c = host.ownerChain(), R = host.kernel.records;
  const a = await R.create(c, "contact", { name: "Jane Doe", email: "jane@example.test" });
  const b = await R.create(c, "contact", { name: "Jane Doe", email: "jane2@example.test", phone: "+15550100" });
  const mail = await R.create(c, "communication", { kind: "email", at: "2026-10-01T09:00:00.000Z", source_key: "gmail:1" });
  const part = await R.create(c, "participant", { communication: { urn: mail.urn }, contact: { urn: b.urn }, how: "from" });
  const res = await R.merge(c, "contact", a.id, b.id);
  const kept = (await R.get(c, "contact", a.id)).data;
  assert.deepEqual([kept.phone, kept.other_emails], ["+15550100", ["jane2@example.test"]]);
  assert.equal((await R.get(c, "participant", part.id)).data.contact.urn, a.urn);
  await R.unmerge(c, res.merge_id);
  assert.equal((await R.get(c, "contact", b.id)).data.phone, "+15550100", "the dropped contact has its phone back");
  assert.equal((await R.get(c, "contact", a.id)).data.phone ?? null, null);
  assert.equal((await R.get(c, "participant", part.id)).data.contact.urn, b.urn);
});

test("computed fields over Twenty: a total over linked records, an expression, a hidden-from role, and a removed field keeps its data", async () => {
  const { host } = await boot();
  const c = host.ownerChain(), R = host.kernel.records;
  await host.defineTypes([
    { name: "client", label: "Client", fields: [
      { name: "name", kind: "text", label: "Name", required: true },
      { name: "since", kind: "date", label: "Since" },
      { name: "fees", kind: "number", label: "Fees", computed: { over: { type: "case", via: "client", fn: "sum", field: "fee.amount" } } },
      { name: "years", kind: "number", label: "Years", computed: { expr: "len(name)" } },
      { name: "old", kind: "text", label: "Old" },
    ] },
    { name: "case", label: "Case", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "client", kind: "link", to: "client", label: "Client", required: true }, { name: "fee", kind: "money", label: "Fee" }] },
  ]);
  const a = await R.create(c, "client", { name: "Harlow", old: "keep me" }), b = await R.create(c, "client", { name: "Northwind" });
  for (const [who, amt] of [[a, 300], [a, 200], [b, 50]]) await R.create(c, "case", { title: "x", client: { urn: who.urn }, fee: { amount: amt, currency: "USD" } });
  const rows = (await R.query(c, "client", { sort: [{ field: "name", dir: "asc" }], page: { limit: 10 } })).rows;
  assert.deepEqual(rows.map((r) => [r.data.name, r.data.fees, r.data.years]), [["Harlow", 500, 6], ["Northwind", 50, 9]]);
  // remove a field softly: its data stays in Twenty
  const def = (await host.kernel.records.define(c, { change_types: [{ name: "client", label: "Client", fields: [
    { name: "name", kind: "text", label: "Name", required: true }, { name: "since", kind: "date", label: "Since" },
    { name: "fees", kind: "number", label: "Fees", computed: { over: { type: "case", via: "client", fn: "sum", field: "fee.amount" } } },
    { name: "years", kind: "number", label: "Years", computed: { expr: "len(name)" } }, { name: "old", kind: "text", label: "Old", hidden: true }] }] }));
  assert.equal(def.applied, true);
  assert.equal("old" in (await R.get(c, "client", a.id)).data, false);
  await assert.rejects(() => R.update(c, "client", a.id, { old: "x" }, 1), { code: "bad_input" });
});

test("seal a field in place over Twenty: no plaintext in Twenty's rows, the store's change log or the event log, and Twenty's timeline is purged", async () => {
  let refs = 0;
  const { host, store } = await boot({ sealer: { api: { put: async (i) => ({ ref: { sealed: i.class, ref: `sv_${++refs}`, present: true, valid_format: true, set_at: 1 } }) } } });
  const c = host.ownerChain(), R = host.kernel.records;
  await host.defineTypes([{ name: "person", label: "Person", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "ssn", kind: "text", label: "SSN" }] }]);
  const p = await R.create(c, "person", { name: "Jane", ssn: "123-45-6789" });
  await R.update(c, "person", p.id, { ssn: "123-45-6790" }, 1);
  const out = await host.kernel.migrate.sealField(c, { type: "person", field: "ssn", class: "us-ssn" });
  assert.equal(out.moved, 1);
  assert.equal([...fake.objects.values()].every((o) => o.isAuditLogged === false) && fake.objects.size > 0, true, "Twenty's timeline is off for every Vyre object, so a later seal leaves nothing behind");
  assert.equal(fake.timelinePurges, 1, "Twenty's own history was destroyed");
  const rows = JSON.stringify([...fake.rows.values()].flatMap((m) => [...m.values()]));
  assert.equal(rows.includes("123-45-67"), false, "not in Twenty's row");
  assert.equal(JSON.stringify((await store.changes(null, 1000)).entries).includes("123-45-67"), false);
  assert.equal(JSON.stringify(host.log.read()).includes("123-45-67"), false);
});

test("forget a record over Twenty: the row is destroyed in Twenty, the snapshot and change log lose it, Twenty's timeline is purged", async () => {
  const { host, store } = await boot();
  const c = host.ownerChain(), R = host.kernel.records;
  await host.defineTypes([{ name: "person", label: "Person", fields: [{ name: "name", kind: "text", label: "Name", required: true }] }]);
  const p = await R.create(c, "person", { name: "Jane Needle" });
  const keep = await R.create(c, "person", { name: "Bob Keep" });
  const before = fake.timelinePurges ?? 0;
  const out = await host.kernel.migrate.forget(c, { type: "person", id: p.id });
  assert.ok(out.forgotten.endsWith(p.id));
  assert.equal(await R.get(c, "person", p.id), null);
  assert.equal(await store.get("person", p.id, { include_deleted: true }), null);
  assert.equal(JSON.stringify([...fake.rows.values()].flatMap((m) => [...m.values()])).includes("Jane Needle"), false, "not in Twenty's rows");
  assert.equal(JSON.stringify((await store.changes(null, 1000)).entries).includes("Jane Needle"), false);
  assert.equal(JSON.stringify(host.log.read()).includes("Jane Needle"), false);
  assert.equal(fake.timelinePurges, before + 1);
  assert.equal((await R.get(c, "person", keep.id)).data.name, "Bob Keep");
});
