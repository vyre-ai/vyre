// @ts-check
// s3: template test mode.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, ALEX } from "./testing/world.js";
import { createFlows } from "./index.js";

/** A Kit with a staged type and a Flow that starts when a matter enters Engagement. */
const kit = () => ({
  format: 1, id: "try-me", version: 1, name: "Try me", description: "d",
  includes: {
    types: [{ name: "case", label: "Case", fields: [{ name: "client", kind: "text", label: "Client" }, { name: "paid", kind: "text", label: "Paid" }, { name: "stage", kind: "stage", label: "Stage" }],
      stages: [
        { name: "Intake", owner: "role:attorney", tasks: [{ title: "Call the client", doer: "role:attorney", output: { kind: "note" }, brief: "Call {record.client}.", checklist: [{ say: "Paid is set", check: { field: "paid != null" } }] }] },
        { name: "Engagement", enter_if: 'paid == "yes"', tasks: [{ title: "Letter", doer: "role:attorney", output: { kind: "note" } }] },
        { name: "Done" },
      ] }],
    flows: [{ format: 1, name: "on_engagement", label: "On engagement", authorship: "kit", trigger: { on: "stage", type: "case", stage: "Engagement" },
      steps: [{ id: "n", kind: "find", type: "case" }, { id: "o", kind: "create", type: "case", set: { client: "x" } }] }],
  },
});
const toolsOf = (/** @type {any} */ w) => createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, store: w.store, catalog: () => w.runner.catalogFn() });
const chainOf = () => ({ hops: [{ actor: ALEX }] });

test("s3: a Kit is tried on a sample: tasks, the filled brief, the checklist, the gate and the Flow at a stage, with nothing stored", async () => {
  const w = await world({});
  const f = toolsOf(w);
  const before = (await w.runner.listRuns({})).length;
  const r = await f.tools["kits.test"](chainOf(), { kit: kit(), sample: { type: "case", data: { client: "Jane" } } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const text = r.lines.join("\n");
  assert.match(text, /^Trying Try me on a case \(a sample\)\. Nothing is sent, stored or changed\./);
  assert.match(text, /Stage Intake \(owner role:attorney\):/);
  assert.match(text, /task "Call the client" for role:attorney/);
  assert.match(text, /brief: Call Jane\./);
  assert.match(text, /must hold: Paid is set \(field\)/);
  assert.match(text, /moves on when the required tasks are done; role:attorney or an admin can move it early\./);
  assert.match(text, /Engagement needs paid == "yes": this record does not meet it, so the gate would hold here\./);
  assert.match(text, /Flow on_engagement starts here: it completes; 0 approvals, 1 case written, 0 outward acts \(stubbed\)\./);
  assert.match(r.totals, /^3 stages, 2 tasks, 1 Flow tried, 0 approvals, 0 sent\.$/);
  assert.equal((await w.runner.listRuns({})).length, before, "no run was stored");
});

test("s3: a sample that meets the next stage's condition says so, and a bad Kit is refused with the same words as install", async () => {
  const w = await world({});
  const f = toolsOf(w);
  const ok = await f.tools["kits.test"](chainOf(), { kit: kit(), sample: { data: { client: "Jane", paid: "yes" } } });
  assert.match(ok.lines.join("\n"), /this record meets it/);
  const bad = kit();
  bad.includes.types[0].stages[0].tasks[0].checklist = [{ say: "x", check: { field: "paidd != null" } }];
  const r = await f.tools["kits.test"](chainOf(), { kit: bad });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /did you mean paid\?/);
  const none = await f.tools["kits.test"](chainOf(), { kit: kit(), sample: { type: "nope" } });
  assert.equal(none.ok, false);
  assert.match(none.errors[0].message, /no type nope with stages; it has case/);
});

test("s3: the Kit's own types need not exist in the Space: reads of them come back empty", async () => {
  const w = await world({});
  const f = toolsOf(w);
  const k = kit();
  k.includes.flows[0].steps = [{ id: "n", kind: "find", type: "case" }, { id: "d", kind: "decide", if: "steps.n.count == 0", then: [{ id: "o", kind: "create", type: "case", set: { client: "x" } }], else: [] }];
  const r = await f.tools["kits.test"](chainOf(), { kit: k, sample: { data: { client: "J" } } });
  assert.match(r.lines.join("\n"), /it completes; 0 approvals, 1 case written/);
});
