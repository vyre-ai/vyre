// Estate planning, end to end on the real gateway and tasks: a payment arrives, the Kit's Flow opens the contact and the matter at Intake,
// entering the stage makes its tasks, Research fills the fields, the welcome draft waits for the attorney, the attorney's approval (a real
// presence proof) releases it, and the matter moves to Engagement by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "../testing/world.js";
import { estateKit, catalogOf, onPaymentFlow, paymentEvent } from "./estate.fixture.js";

const rows = async (w, type) => (await w.kernel.records.query(w.kernel.sysChain(), type, { page: { limit: 50 } })).rows;

test("estate planning: payment, matter, tasks, research, approved welcome email, next stage", async () => {
  const kit = estateKit();
  assert.deepEqual(kit.roles.map(r => r.name).sort(), ["attorney", "intake", "research"]);
  const w = await world({ kernel: "real", cat: catalogOf(kit) });
  await install(w, onPaymentFlow());

  // 1. the payment: the event data is what the Stripe connector's normaliser gives the Space
  const pay = paymentEvent();
  assert.equal(pay.customer, "cus_test_1");
  w.kernel.inbound("payment.received", pay, "external");
  await settle(w);

  // 2. the matter exists at Intake, linked to its contact, with the fee
  const [contact] = await rows(w, "contact"), [matter] = await rows(w, "matter");
  assert.equal(contact.data.full_name, "Sam Rivera");
  assert.equal(matter.data.stage, "Intake");
  assert.equal(matter.data.client, contact.urn ?? `vyre://${w.cat.space}/contact/${contact.id}`);
  assert.deepEqual(matter.data.fee, { amount: 3500, currency: "USD" });

  // 3. entering Intake made the Kit's tasks: research ready, the welcome email waiting on it
  const byTitle = async t => (await w.kernel.allTasks()).find(x => x.title === t);
  const research = await byTitle("Research the client"), welcome = await byTitle("Welcome email");
  assert.deepEqual([research.state, research.doer.id], ["ready", "research"]);
  assert.deepEqual([welcome.state, welcome.doer.id, welcome.checker.role, welcome.output.kind], ["waiting", "intake", "attorney", "sent"]);

  // 4. Research starts, writes onto the matter (never privately), and finishes: the kernel checks the fields are there
  const rchain = w.kernel.as(research.doer);
  await w.kernel.tasksApi.start(rchain, research.id);
  await assert.rejects(() => w.kernel.tasksApi.complete(rchain, research.id, {}), { code: "output_check_failed" }, "an assistant cannot finish while the fields are empty");
  const cur = await w.kernel.records.get(rchain, "matter", matter.id);
  await w.kernel.records.update(rchain, "matter", matter.id, { practice_area: "Estate planning", household_size: 2, decision_maker: "Sam Rivera" }, cur.version);
  await w.kernel.tasksApi.complete(rchain, research.id, {});
  await settle(w);
  assert.equal((await byTitle("Research the client")).state, "done");
  assert.equal((await byTitle("Welcome email")).state, "ready", "finishing research readied the draft");
  assert.equal((await rows(w, "matter"))[0].data.stage, "Intake", "one task still open");

  // 5. Intake drafts the email; it lands in the attorney's check, nothing leaves the Space yet
  const ichain = w.kernel.as(welcome.doer);
  await w.kernel.tasksApi.start(ichain, welcome.id);
  const sent = await w.kernel.tasksApi.complete(ichain, welcome.id, { payload: { what: "the welcome email", recipients: [{ address: "sam@example.test", verified: false }], template: { id: welcome.template, version: 1 } }, action: "email.send", resource: `vyre://${w.cat.space}/message/m1` });
  assert.equal(sent.state, "needs_check");
  assert.equal(w.kernel.released.length, 0);
  assert.equal((await w.kernel.tasksApi.needsYou(w.kernel.as(ALEX))).some(t => t.id === welcome.id), true, "it shows in the attorney's Now");

  // 6. the attorney approves with a presence proof: the email is released once, the stage moves on by itself
  await w.kernel.approve(welcome.id);
  await settle(w);
  assert.equal(w.kernel.released.length, 1);
  assert.equal(w.kernel.released[0].body.recipients[0].address, "sam@example.test");
  assert.equal((await rows(w, "matter"))[0].data.stage, "Engagement");
  const next = await byTitle("Engagement letter signed");
  assert.deepEqual([next.state, next.doer.id, next.stage], ["ready", "per_alex", "Engagement"]);

  // 7. nothing was made twice, and the audit chain is whole
  assert.equal((await w.kernel.allTasks()).length, 3);
  assert.equal(w.kernel.rawLog.verify().ok, true);
  assert.ok(w.stageEvents.some(e => e.type === "stage.advanced" && e.data.to === "Engagement"));
});
