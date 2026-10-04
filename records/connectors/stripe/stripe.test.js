import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compile } from "../../language/compile.js";
import { createMemoryStore } from "../../../kernel/store/memory.js";
import { createRecordsHost } from "../../host.js";
import { verifySignature, signForTest, normalize, createStripeHandler } from "./stripe.js";

const SECRET = "whsec_test_sample_secret";
const q = (store, type) => store.query(type, { page: { limit: 100 } });
const kit = compile(fs.readFileSync(new URL("../../kits/estate-planning/kit.ts", import.meta.url), "utf8"));

// Made-up sample world: Sam Rivera buys a trust package from Harlow Legal. Shapes follow Stripe's docs.
const checkout = (o = {}) => ({ id: "evt_1", type: "checkout.session.completed", livemode: false, created: 1791000000, data: { object: { id: "cs_test_1", object: "checkout.session", payment_status: "paid", payment_intent: "pi_test_1", amount_total: 350000, currency: "usd", customer: "cus_test_1", customer_details: { email: "Sam@Example.test", name: "Sam Rivera" }, metadata: { plan: "Trust" }, ...o } } });
const intent = (o = {}) => ({ id: "evt_2", type: "payment_intent.succeeded", livemode: false, created: 1791000001, data: { object: { id: "pi_test_1", object: "payment_intent", amount: 350000, amount_received: 350000, currency: "usd", customer: "cus_test_1", receipt_email: "sam@example.test", ...o } } });
const charge = (o = {}) => ({ id: "evt_3", type: "charge.succeeded", livemode: false, created: 1791000002, data: { object: { id: "ch_test_1", object: "charge", paid: true, amount: 350000, currency: "usd", customer: "cus_test_1", payment_intent: "pi_test_1", billing_details: { name: "Sam Rivera", email: "sam@example.test" }, ...o } } });

const SPACE = "spc_harlow000001";
async function setup(store = createMemoryStore()) {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store });
  await host.installKit(kit);
  const handle = createStripeHandler({ secret: SECRET, host, now: () => 1791000100_000 });
  const send = (ev, o = {}) => { const raw = JSON.stringify(ev); return handle({ "stripe-signature": o.header ?? signForTest(raw, SECRET, 1791000100_000) }, o.raw ?? raw); };
  return { store, host, handle, send, events: (type) => host.log.read({}).filter((e) => !type || e.type === type) };
}

test("signature: valid, wrong secret, tampered body, stale, missing, malformed, second v1 accepted", () => {
  const raw = '{"a":1}'; const now = 1791000100_000;
  const h = signForTest(raw, SECRET, now);
  assert.deepEqual(verifySignature(raw, h, SECRET, { now: () => now }), { ok: true });
  assert.equal(verifySignature(raw, h, "other", { now: () => now }).reason, "mismatch");
  assert.equal(verifySignature('{"a":2}', h, SECRET, { now: () => now }).reason, "mismatch");
  assert.equal(verifySignature(raw, h, SECRET, { now: () => now + 400_000 }).reason, "stale");
  assert.equal(verifySignature(raw, undefined, SECRET).reason, "missing");
  assert.equal(verifySignature(raw, "garbage", SECRET).reason, "malformed");
  assert.equal(verifySignature(raw, `${h},v1=${"0".repeat(64)}`, SECRET, { now: () => now }).ok, true);
  assert.equal(verifySignature(raw, `t=${Math.floor(now / 1000)},v1=short`, SECRET, { now: () => now }).ok, false);
});

test("normalize: the four event kinds become one payment shape", () => {
  const c = normalize(checkout());
  assert.deepEqual({ ...c, at: undefined }, { event: "evt_1", display: "Sam Rivera", customer: "cus_test_1", email: "sam@example.test", name: "Sam Rivera", payment: "pi_test_1", amount: { amount: 3500, currency: "USD" }, description: "Checkout: Trust", livemode: false, at: undefined, metadata: { plan: "Trust" } });
  assert.equal(normalize(intent()).payment, "pi_test_1");
  assert.equal(normalize(charge()).name, "Sam Rivera");
  assert.equal(normalize({ id: "evt_4", type: "invoice.paid", data: { object: { id: "in_1", payment_intent: "pi_inv", amount_paid: 12000, currency: "usd", customer: "cus_x", customer_email: "a@b.test", customer_name: "A B" } } }).amount.amount, 120);
  assert.equal(normalize(checkout({ payment_status: "unpaid" })), null);
  assert.equal(normalize(charge({ paid: false })), null);
  assert.equal(normalize({ id: "evt_5", type: "customer.created", data: { object: {} } }), null);
  assert.equal(normalize(checkout({ currency: "jpy", amount_total: 5000 })).amount.amount, 5000, "zero-decimal currencies are not divided");
  assert.equal(normalize(checkout({ customer: null })).customer, "guest:sam@example.test");
  assert.equal(normalize(checkout({ customer: null, customer_details: {} })).customer, "payment:pi_test_1");
});

test("a paid checkout finds or creates the contact and the matter through the kit's own flow", async () => {
  const { store, host, send, events } = await setup();
  const r = await send(checkout());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.steps.map((s) => s.id), ["client", "matter"]);
  const contacts = (await q(store, "contact")).rows, matters = (await q(store, "matter")).rows;
  assert.equal(contacts.length, 1); assert.equal(matters.length, 1);
  assert.equal(contacts[0].data.name, "Sam Rivera");
  assert.equal(contacts[0].data.email, "sam@example.test");
  assert.equal(contacts[0].data.stripe_customer, "cus_test_1");
  assert.equal(matters[0].data.title, "Estate plan for Sam Rivera");
  assert.deepEqual(matters[0].data.client, { urn: `vyre://${SPACE}/contact/${contacts[0].id}` });
  assert.equal(matters[0].data.stage, "Intake");
  assert.deepEqual(matters[0].data.fee, { amount: 3500, currency: "USD" });
  assert.equal(matters[0].data.stripe_payment, "pi_test_1");
  const types = events().map((e) => e.type).filter((t) => t !== "types.defined");
  assert.equal(types[0], "payment.received", "the event comes first");
  assert.equal(events("payment.received")[0].actor, `service:connector:stripe@${SPACE}`);
  assert.deepEqual(events("contact.created").length + events("matter.created").length, 2, "each record is written through the gateway, one event each");
  assert.equal(host.log.verify().ok, true);
});

test("the same payment arriving as three Stripe events, twice each, makes one contact, one matter, one event", async () => {
  const { store, send, events } = await setup();
  const evs = [checkout(), intent(), charge(), checkout(), intent(), charge()];
  const rs = await Promise.all(evs.map((e) => send(e)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal((await q(store, "contact")).rows.length, 1);
  assert.equal((await q(store, "matter")).rows.length, 1);
  assert.equal(events("payment.received").length, 1);
  assert.equal(rs.filter((r) => r.body.duplicate).length, 5);
});

test("a second payment from the same customer adds a matter and keeps the one contact", async () => {
  const { store, send } = await setup();
  await send(checkout());
  await send(checkout({ id: "cs_test_2", payment_intent: "pi_test_2" }));
  assert.equal((await q(store, "contact")).rows.length, 1);
  assert.equal((await q(store, "matter")).rows.length, 2);
});

test("a guest checkout without a customer id is matched by email on the next payment", async () => {
  const { store, send } = await setup();
  await send(checkout({ customer: null }));
  await send(checkout({ customer: null, payment_intent: "pi_test_9" }));
  const contacts = (await q(store, "contact")).rows;
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].data.stripe_customer, "guest:sam@example.test");
});

test("refusals: bad signature, live mode, unpaid, other events, bad json", async () => {
  const { store, send, handle, events } = await setup();
  assert.equal((await send(checkout(), { header: "t=1791000100,v1=" + "0".repeat(64) })).status, 400);
  assert.equal((await handle({}, "{}")).status, 400);
  const live = await send({ ...checkout(), livemode: true });
  assert.equal(live.status, 200); assert.match(live.body.ignored, /test mode/);
  assert.equal((await send(checkout({ payment_status: "unpaid" }))).body.ignored.includes("not a received payment"), true);
  assert.equal((await send({ id: "evt_x", type: "customer.created", data: { object: {} } })).body.ignored, "customer.created");
  const raw = "not json"; assert.equal((await handle({ "stripe-signature": signForTest(raw, SECRET, 1791000100_000) }, raw)).status, 400);
  assert.equal((await q(store, "matter")).rows.length, 0);
  assert.equal(events("payment.received").length, 0, "a refused delivery writes nothing");
});

test("the amount is the payment, not a guess: no sealed value or card data ever enters the event", async () => {
  const { events, send } = await setup();
  await send(checkout({ customer_details: { email: "sam@example.test", name: "Sam Rivera", tax_ids: [{ value: "123-45-6789" }] } }));
  assert.ok(!JSON.stringify(events()).includes("123-45-6789"));
});

test("a failing store makes Stripe retry (500), and the retry then finishes the job", async () => {
  const { store, send } = await setup();
  const real = store.create.bind(store);
  let fail = true;
  store.create = async (t, id, d) => { if (t === "matter" && fail) { fail = false; throw Object.assign(new Error("store down"), { code: "unavailable" }); } return real(t, id, d); };
  assert.equal((await send(checkout())).status, 500);
  assert.equal((await send(checkout())).status, 200);
  assert.equal((await q(store, "contact")).rows.length, 1, "the contact from the first try is reused");
  assert.equal((await q(store, "matter")).rows.length, 1);
});

test("fail the first run, redeliver: one event, one run, one matter", async () => {
  const { store, host, send, events } = await setup();
  const real = store.create.bind(store);
  let fail = true;
  store.create = async (t, id, d) => { if (t === "matter" && fail) { fail = false; throw Object.assign(new Error("store down"), { code: "unavailable" }); } return real(t, id, d); };
  assert.equal((await send(checkout())).status, 500);
  const r = await send(checkout());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await send(intent())).status, 200);
  assert.equal(events("payment.received").length, 1);
  assert.equal((await host.flows.runner.listRuns({ limit: 100 })).length, 1);
  assert.equal((await q(store, "matter")).rows.length, 1);
  assert.equal((await q(store, "contact")).rows.length, 1);
});
