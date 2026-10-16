// An Ask step's form through the engine: what the person fills in comes back as steps.<id>.values, and the form's rules hold (a required question, a number, a choice).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { readForm } from "./form.js";

const mine = (w, type) => [...(w.kernel.tables.get(type) || new Map()).values()];
const FORM = [{ name: "client", label: "Client", required: true }, { name: "amount", label: "Refund amount", kind: "number", required: true }, { name: "how", label: "How paid", kind: "choice", choices: ["Card", "Cash"] }, { name: "when", kind: "date" }, { name: "ok", kind: "boolean" }];
const flow = () => ({ format: 1, name: "refund", label: "Refund", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: [
  { id: "q", kind: "ask", to: "role:manager", title: "Approve the refund?", form: FORM },
  { id: "m", kind: "create", type: "payment", set: { client: { expr: "steps.q.values.client" }, amount: { expr: "steps.q.values.amount" } } },
] });

const answer = async (w, values, yes = true) => {
  await settle(w);
  const task = w.kernel.tasks.find((t) => t.title === "Approve the refund?");
  assert.ok(task, "the question reached the manager");
  const given = { answer: yes ? "yes" : "no", reason: "ok", ...(values ? { values } : {}) };
  await w.kernel.completeTask(task.id, { evidence: given, answer: given, ...(yes ? {} : { outcome: "rejected" }) });
  await settle(w);
  return (await w.runner.listRuns())[0];
};

test("what the person filled in comes back as steps.<id>.values, typed by the form", async () => {
  const w = await world();
  await install(w, flow());
  w.kernel.inbound("payment.received", {});
  const run = await answer(w, { client: "Rivera", amount: "1250.5", how: "Card", when: "2026-11-04", ok: "yes" });
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.deepEqual(run.steps.q.output.values, { client: "Rivera", amount: 1250.5, how: "Card", when: "2026-11-04", ok: true });
  const [pay] = mine(w, "payment");
  assert.deepEqual([pay.client ?? pay.data?.client, pay.amount ?? pay.data?.amount], ["Rivera", 1250.5], "a later step read the typed values");
});

test("a required question left empty fails the step in the question's own words, and nothing after it runs", async () => {
  const w = await world();
  await install(w, flow());
  w.kernel.inbound("payment.received", {});
  const run = await answer(w, { client: "Rivera", amount: "" });
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "invalid_answer");
  assert.match(run.error.message, /"Refund amount" is required/);
  assert.equal(mine(w, "payment").length, 0);
});

test("a no needs no values", async () => {
  const w = await world();
  await install(w, flow());
  w.kernel.inbound("payment.received", {});
  const run = await answer(w, undefined, false);
  assert.notEqual(run.error && run.error.code, "invalid_answer");
  assert.equal(run.steps.q.output?.values, undefined);
});

test("readForm checks each kind", () => {
  const bad = (values) => readForm(FORM, { values: { client: "A", amount: 1, ...values } });
  assert.match(bad({ amount: "abc" }).message, /not a number/);
  assert.match(bad({ how: "Gold" }).message, /not one of its choices/);
  assert.match(bad({ when: "2026-02-30" }).message, /not a day/);
  assert.match(bad({ ok: "maybe" }).message, /not yes or no/);
  assert.deepEqual(readForm([{ name: "n", kind: "number" }], { values: { n: "7" } }), { ok: true, values: { n: 7 } });
  assert.deepEqual(readForm([{ name: "t" }], {}), { ok: true, values: { t: null } }, "an optional question left empty is null");
  assert.match(readForm([{ name: "f", kind: "file", required: true }], { values: { f: "../x" } }).message, /not a file/);
});
