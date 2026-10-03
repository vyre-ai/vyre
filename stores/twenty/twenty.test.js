import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { conformance, SUITE_TYPES } from "../conformance-suite.js";
import { TwentyStore } from "./driver.js";
import { TwentyClient } from "./client.js";
import { FakeTwenty } from "./testing/fake-twenty.js";
import { planType, toFilter, toOrderBy, toInput } from "./translate.js";

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(SCRATCH, "tw-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** One Twenty-backed store over a fake Twenty. */
async function boot({ dir = tmp(), secret = crypto.randomBytes(16).toString("hex"), fake } = {}) {
  fake ??= await new FakeTwenty().start();
  const client = new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} });
  const store = new TwentyStore({ client, space: "harlow", dir, webhookSecret: secret, graceMs: 0 });
  fake.deliver = async (payload, headers, raw) => { await store.handleWebhook(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), raw); };
  return { fake, store, client, dir, secret };
}

const harness = {
  async make() {
    const b = await boot();
    await b.store.define({ types: SUITE_TYPES });
    await b.store.registerWebhook("fn:store");
    return {
      store: b.store,
      behind: async (type, id, patch) => { const p = b.store.plan(type); b.fake.behind(p.singular, id, Object.fromEntries(Object.entries(patch).map(([k, v]) => [p.byVyre.get(k).twenty, v && typeof v === "object" && "amount" in v ? { amountMicros: v.amount * 1e6, currencyCode: v.currency } : v]))); },
      touch: async (type, id) => b.fake.touch(b.store.plan(type).singular, id),
      cleanup: async () => b.fake.stop(),
    };
  },
  async empty(types) { const b = await boot(); await b.store.define({ types }); return { store: b.store, cleanup: async () => b.fake.stop() }; },
};
conformance("twenty store (fake twenty)", { test, before, after }, { assert }, harness);

test("the driver sends our id to Twenty unchanged, and refuses a UUID version Twenty would refuse", async () => {
  const b = await boot(); await b.store.define({ types: SUITE_TYPES });
  const seen = b.fake.requests.filter((r) => r.op === "Create_widget");
  const rec = await b.store.create("widget", { fields: { title: "x" } });
  const sent = b.fake.requests.filter((r) => r.op === "Create_widget").at(-1);
  assert.equal(sent.variables.d.id, rec.id);
  assert.match(rec.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  await assert.rejects(b.store.create("widget", { id: "01a101b0-a370-7000-b5d3-0f0df5924247", fields: { title: "v7" } }), { code: "invalid" });
  assert.equal(seen.length, 0);
  await b.fake.stop();
});

test("the sealed placeholder is all Twenty ever receives", async () => {
  const b = await boot(); await b.store.define({ types: SUITE_TYPES });
  await b.store.create("widget", { fields: { title: "s", secret: "[sealed]" } });
  await assert.rejects(b.store.create("widget", { fields: { title: "s", secret: "123-45-6789" } }), { code: "sealed_value" });
  const wire = JSON.stringify(b.fake.requests);
  assert.ok(!wire.includes("123-45-6789"));
  assert.ok(wire.includes("[sealed]"));
  await b.fake.stop();
});

test("update is a compare-and-set on updatedAt and sends nothing when the version is stale", async () => {
  const b = await boot(); await b.store.define({ types: SUITE_TYPES });
  const rec = await b.store.create("widget", { fields: { title: "cas", qty: 1 } });
  b.fake.behind("widget", rec.id, { qty: 9 });
  await assert.rejects(b.store.update("widget", rec.id, { qty: 2 }, rec.version), { code: "conflict" });
  assert.equal(b.fake.rows.get("widget").get(rec.id).qty, 9);
  await b.fake.stop();
});

test("a rate limit is retried, then reported plainly", async () => {
  const b = await boot(); await b.store.define({ types: SUITE_TYPES });
  b.fake.limit = 0;
  await assert.rejects(b.store.get("widget", crypto.randomUUID()), { code: "rate_limited" });
  b.fake.limit = Infinity; b.fake.served = 0;
  assert.equal(await b.store.get("widget", crypto.randomUUID()), null);
  await b.fake.stop();
});

test("Twenty unreachable is 'unavailable', not a crash", async () => {
  const b = await boot(); await b.store.define({ types: SUITE_TYPES });
  await b.fake.stop();
  await assert.rejects(b.store.get("widget", crypto.randomUUID()), { code: "unavailable" });
  assert.equal((await b.store.health()).ok, false);
});

test("webhook: a bad signature, a replayed nonce and a stale timestamp are not changes", async () => {
  const b = await boot(); await b.store.define({ types: SUITE_TYPES });
  const rec = await b.store.create("widget", { fields: { title: "hook" } });
  const payload = { eventName: "widget.updated", objectMetadata: { nameSingular: "widget" }, record: { ...b.fake.rows.get("widget").get(rec.id), updatedAt: "2030-01-01T00:00:00.000Z", name: "changed" }, updatedFields: ["name"] };
  const raw = JSON.stringify(payload);
  const sign = (ts, secret = b.secret) => crypto.createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
  const now = String(Date.now());
  assert.equal((await b.store.handleWebhook({ "x-twenty-webhook-timestamp": now, "x-twenty-webhook-signature": sign(now, "wrong") }, raw)).status, 401);
  const old = String(Date.now() - 3_600_000);
  assert.equal((await b.store.handleWebhook({ "x-twenty-webhook-timestamp": old, "x-twenty-webhook-signature": sign(old) }, raw)).status, 401);
  assert.equal(b.store.changes(0).changes.length, 0);
  const ok = { "x-twenty-webhook-timestamp": now, "x-twenty-webhook-signature": sign(now), "x-twenty-webhook-nonce": "n1" };
  assert.deepEqual(await b.store.handleWebhook(ok, raw), { status: 200, recorded: 1 });
  assert.deepEqual(await b.store.handleWebhook(ok, raw), { status: 200, recorded: 0 }, "a replay is ignored");
  const c = b.store.changes(0).changes;
  assert.equal(c.length, 1);
  assert.equal(c[0].source, "twenty");
  assert.equal(c[0].after.title, "changed");
  assert.equal(c[0].before.title, "hook");
  assert.equal(b.store.feed.rejected, 2);
  assert.equal((await b.store.handleWebhook({}, "not json")).status, 400);
  await b.fake.stop();
});

test("state survives a restart: types, snapshots and the change log", async () => {
  const dir = tmp();
  const a = await boot({ dir }); await a.store.define({ types: SUITE_TYPES });
  await a.store.registerWebhook("fn:store");
  const rec = await a.store.create("widget", { fields: { title: "persist", qty: 3 } });
  a.fake.behind("widget", rec.id, { qty: 4 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.store.changes(0).changes.length, 1);
  const b = await boot({ dir, fake: a.fake, secret: a.secret });
  assert.ok(b.store.plans.has("widget"), "types reload");
  assert.equal(b.store.snapshots.get("widget", rec.id).fields.title, "persist");
  assert.equal(b.store.changes(0).changes.length, 1, "the change log reloads");
  assert.equal(b.store.feed.seq, 1);
  await a.fake.stop();
});

test("translate: names, reserved words, filters and orderBy", () => {
  const plan = planType(SUITE_TYPES[0]);
  assert.equal(plan.singular, "widget"); assert.equal(plan.plural, "widgets");
  assert.equal(plan.byVyre.get("title").twenty, "name");
  assert.deepEqual(toFilter(plan, { kind: "Beta", qty: { gt: 1 } }), { and: [{ kind: { eq: "BETA" } }, { qty: { gt: 1 } }] });
  assert.deepEqual(toFilter(plan, { price: { gte: 2.5 } }), { price: { amountMicros: { gte: 2_500_000 } } });
  assert.deepEqual(toFilter(plan, { updatedAt: { gt: "2026-01-01T00:00:00.000Z" } }), { updatedAt: { gt: "2026-01-01T00:00:00.000Z" } });
  assert.deepEqual(toOrderBy(plan, [{ field: "price", dir: "desc" }]), [{ price: { amountMicros: "DescNullsLast" } }]);
  assert.deepEqual(toInput(plan, { status: "Active" }), { status: "ACTIVE" });
  assert.throws(() => planType({ name: "person", fields: [{ name: "t", kind: "text" }] }), { code: "name_reserved" });
  assert.throws(() => planType({ name: "thing", fields: [{ name: "t", kind: "text" }, { name: "position", kind: "number" }] }), { code: "name_reserved" });
  assert.throws(() => planType({ name: "thing", fields: [{ name: "t", kind: "text" }, { name: "full_name", kind: "text" }, { name: "fullName", kind: "text" }] }), /same Twenty name/);
  assert.throws(() => toFilter(plan, { secret: "x" }), { code: "invalid" });
});
