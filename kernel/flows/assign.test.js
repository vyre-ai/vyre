// @ts-check
// Best-suited doer: a role or a pool is given to the candidate with the skills, the most history on this record and the lightest load, and the choice says why.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX, BOB } from "./testing/world.js";
import { SPACE } from "./testing/fixtures.js";
import { chooseDoer } from "./assign.js";

const A = (/** @type {string} */ id, kind = "agent") => ({ kind, id, space: SPACE });

test("chooseDoer: skills first, then history on the record, then the lightest load, then the order given; and it says why", () => {
  const cs = [{ actor: A("a"), skills: ["probate"] }, { actor: A("b"), skills: ["probate", "spanish"] }, { actor: A("c"), skills: ["probate", "spanish"] }];
  assert.equal(chooseDoer({ candidates: cs, skills: ["spanish"] }).pick?.actor.id, "b", "the skills decide, then the order");
  assert.equal(chooseDoer({ candidates: cs, skills: ["spanish"], involvement: { c: 2 } }).pick?.actor.id, "c", "the one who knows the record");
  assert.equal(chooseDoer({ candidates: cs, skills: ["spanish"], load: { b: 5, c: 1 } }).pick?.actor.id, "c", "the lighter load");
  assert.equal(chooseDoer({ candidates: cs }).pick?.actor.id, "a", "no skills, no signals: the first");
  const r = chooseDoer({ candidates: cs, skills: ["spanish"], involvement: { c: 2 }, load: { c: 1 } });
  assert.match(String(r.why), /^c: has spanish; has worked on this record 2 times; 1 open task \(chosen from 2\)$/);
  const none = chooseDoer({ candidates: cs, skills: ["tax"] });
  assert.equal(none.pick, null);
  assert.match(none.why, /nobody among 3 candidate\(s\) has tax/);
  assert.equal(chooseDoer({ candidates: [] }).pick, null);
  assert.equal(chooseDoer({ candidates: [{ actor: A("a"), skills: ["Probate "] }], skills: ["probate"] }).pick?.actor.id, "a", "case and spaces do not matter");
});

const flow = (/** @type {any} */ step) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps: [step] });
const pool = [{ actor: A("research"), name: "Research", skills: ["probate"] }, { actor: A("intake"), name: "Intake", skills: ["intake", "spanish"] }];
const last = async (/** @type {any} */ w, /** @type {string} */ id) => (await w.runner.listRuns({ flow: id }))[0];

test("an assign step to a pool picks by skills and history, gives the task to that doer, and records why on the task and the run", async () => {
  const w = await world({ ports: { pool: async () => pool, signals: async () => ({ involvement: { intake: 2 }, load: { research: 0, intake: 1 } }) } });
  const { id } = await install(w, flow({ id: "a", kind: "assign", to: "pool:legal", skills: ["spanish"], title: "Call the client", output: { kind: "note" }, how: "assistant" }));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "done", JSON.stringify(run.error));
  assert.equal(run.steps.a.output.chosen.doer, "intake");
  assert.match(run.steps.a.output.chosen.why, /^Intake: has spanish; has worked on this record 2 times; 1 open task/);
  await w.kernel.idle();
  const task = w.kernel.tasks.find((/** @type {any} */ t) => t.title === "Call the client");
  assert.equal(task.doer.id, "intake");
  assert.match(task.form.chosen, /Intake: has spanish/);
  assert.ok(w.emitted.some((/** @type {any} */ e) => e.type === "step.assigned" && e.data.doer === "intake"));
});

test("with no signal the pool's most-loaded candidate is passed over; a role still keeps its holders as helpers; nobody fitting is a plain failure", async () => {
  const w = await world({ ports: { pool: async () => pool, signals: async () => ({ involvement: {}, load: { research: 3, intake: 0 } }) } });
  const { id } = await install(w, flow({ id: "a", kind: "assign", to: "pool:legal", title: "Triage", output: { kind: "note" }, how: "assistant" }));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  assert.equal((await last(w, id)).steps.a.output.chosen.doer, "intake");
  const w2 = await world({ ports: { pool: async () => pool } });
  const f2 = await install(w2, flow({ id: "a", kind: "assign", to: "pool:legal", skills: ["tax"], title: "Tax", output: { kind: "note" }, how: "assistant" }));
  w2.kernel.inbound("payment.received", {});
  await settle(w2);
  const r2 = await last(w2, f2.id);
  assert.equal(r2.error.code, "nobody");
  assert.match(r2.error.message, /no one fits: nobody among 2 candidate\(s\) has tax/);
  const w3 = await world();
  const f3 = await install(w3, flow({ id: "a", kind: "assign", to: "role:attorney", title: "Review", output: { kind: "note" }, how: "person" }));
  w3.kernel.inbound("payment.received", {});
  await settle(w3);
  await w3.kernel.idle();
  const t = w3.kernel.tasks.find((/** @type {any} */ x) => x.title === "Review");
  assert.equal(t.doer.id, ALEX.id);
  assert.deepEqual((t.helpers || []).map((/** @type {any} */ h) => h.id), [BOB.id], "a role's other holders still help");
  void f3;
});
