// bakery's own tests, on the SDK's testing harness: no vyred, a temp home, and fakes for the Gate,
// the vault, memory and push. From outside the Vyre repo, import "@vyre/module-sdk/testing".

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testModule } from "../../../packages/module-sdk/testing.js";

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** The module started over a temp home, stopped after the test. */
async function bakery(t, opts) {
  const h = await testModule(DIR, opts);
  t.after(() => h.stop());
  return h;
}

test("bakery.add records an order, bakery.orders and bakery.today read it", async t => {
  const h = await bakery(t);
  assert.equal((await h.call("bakery.add", { customer: "juno", items: 3 })).data.items, 3);
  const r = await h.call("bakery.orders", {});
  assert.equal(r.data.count, 1);
  assert.equal(r.data.orders[0].customer, "juno");
  assert.deepEqual((await h.call("bakery.today", {}, { who: "agent" })).data, { title: "Northwind Bakery", detail: "3 of 40 items today", meta: "1 order" });
  assert.deepEqual(h.events.map(e => [e.type, e.payload]), [["bakery.order-added", { id: 1, items: 3, big: false }]]);
  assert.ok(!JSON.stringify(h.events).includes("juno"), "the event carries no customer's name");
  assert.equal((await h.call("bakery.add", { customer: "juno", items: 0 })).error.code, "bad_input");
  assert.equal((await h.call("bakery.orders", { day: "today" })).error.code, "bad_input");
});

test("a big order becomes a memory note, and reaching the target offers a push", async t => {
  const h = await bakery(t, { settings: { "bakery.target": 30 } });
  await h.call("bakery.add", { customer: "Harlow Legal", items: 24 });
  assert.deepEqual(h.memory, [{ kind: "note", text: `Harlow Legal ordered 24 items on ${new Date().toLocaleDateString("en-CA")}.`, subject: "Harlow Legal", source_ref: "bakery:order:1", from: "module:bakery", untrusted: true }]);
  assert.equal(h.calls.filter(c => c.tool === "push.offer").length, 0);
  const r = await h.call("bakery.add", { customer: "alex", items: 6 });
  assert.equal(r.data.reached, true);
  const pushes = h.calls.filter(c => c.tool === "push.offer");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].input.title, "Daily target reached");
  await h.call("bakery.add", { customer: "alex", items: 1 });
  assert.equal(h.calls.filter(c => c.tool === "push.offer").length, 1, "once a day, when it is crossed");
});

test("bakery.target is asked: an agent needs the person's ask, and the change can be undone", async t => {
  const h = await bakery(t);
  assert.equal((await h.call("bakery.target", { target: 60 }, { who: "agent" })).error.code, "not_asked");
  assert.equal(await h.ctx.settings.get("bakery.target"), 40, "nothing changed");
  assert.deepEqual((await h.call("bakery.target", { target: 60 }, { who: "agent", asked: true })).data, { target: 60, was: 40 });
  assert.deepEqual(h.calls.find(c => c.member === "undo.record").inverse, { tool: "bakery.target", input: { target: 40 } });
  assert.deepEqual((await h.call("bakery.target", { target: 50 })).data, { target: 50, was: 60 });
});

test("bakery.flour is outward: held for an agent, run for the person, run once approved", async t => {
  const h = await bakery(t, { vault: { supplier: { status: 201, headers: {}, body: { order: "fc-1" } } } });
  const held = await h.call("bakery.flour", { kg: 25 }, { who: "agent" });
  assert.deepEqual(held, { held: "hold-1" });
  assert.equal(h.calls.filter(c => c.member === "vault.request").length, 0, "nothing reached the supplier");
  assert.deepEqual(h.holds[0], { id: "hold-1", kind: "pay", via: "bakery.flour", content: { kg: 25 }, who: "agent", state: "held" });

  assert.deepEqual((await h.call("bakery.flour", { kg: 10 })).data, { ordered: true, kg: 10, status: 201, cleared: "person" });
  const sent = h.calls.filter(c => c.member === "vault.request");
  assert.deepEqual(sent.map(c => [c.id, c.req.method, c.req.url, c.req.body]), [["supplier", "POST", "https://api.flourco.example/orders", { product: "flour", kg: 10 }]]);

  // The person edits the held order down to 20 kg and approves it.
  assert.deepEqual((await h.approve("hold-1", { kg: 20 })).data, { ordered: true, kg: 20, status: 201, cleared: "approved" });
  assert.equal(h.calls.filter(c => c.member === "vault.request").length, 2);
});

test("bakery.flour says so when the supplier refuses", async t => {
  const h = await bakery(t, { vault: () => ({ status: 503, headers: {}, body: {} }) });
  assert.deepEqual((await h.call("bakery.flour", { kg: 5 })).error, { code: "supplier_refused", message: "the supplier said 503" });
});
