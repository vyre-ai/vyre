// reviewer-2 repro PR-3: a person with no checker writes a proposal task for themselves and completes it; onEvent applies it as the "approver" (the doer).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX, BOB } from "./testing/world.js";
import { onPayment } from "./testing/fixtures.js";
import { Proposals } from "./proposals.js";

test("PR-3: a task with no checker, written and completed by a non-admin, must not apply a proposal", async () => {
  const w = await world({ store: "records" });
  const applied = [];
  const chains = { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) };
  const proposals = new Proposals({ kernel: w.kernel, runner: w.runner, store: w.store, chain: () => w.kernel.sysChain(), chains, catalog: () => w.cat, isAdmin: who => who.id === ALEX.id, applyTypes: async (approver, diff) => { applied.push(approver.id); } });
  w.offs.push(w.kernel.onEvent(e => { void proposals.onEvent(e); }, "proposals"));
  let t;
  try {
    t = await w.kernel.ask.request(w.kernel.as(BOB), { title: "Change your definitions: evil?", output: { kind: "decision" }, source: "manual", doer: BOB,
      form: { kind: "proposal", what: "types", names: ["evil"], diff: { add_types: [{ name: "evil", label: "Evil", fields: [{ name: "x", kind: "text", label: "X" }] }] } } });
  } catch (e) { console.log("request refused:", e.code); return; }
  await settle(w);
  try { w.kernel.completeTask(t.id, { outcome: "approved" }); } catch (e) { console.log("complete refused:", e.code || e.message); }
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  console.log("applied as:", JSON.stringify(applied));
  assert.deepEqual(applied, [], "a non-admin's own task must never apply a definition change (and onEvent must not check only the form)");
});
