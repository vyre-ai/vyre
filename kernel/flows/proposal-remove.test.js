// reviewer-2 repro PR-5 against work/flows 648e10c77: a types proposal's card names only the types added or changed; `remove_types` in the same diff rides along unseen and is applied on the yes.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { Proposals } from "./proposals.js";

test("PR-5: a diff with remove_types must be refused or shown on the card, not applied under a card that names only another type", async () => {
  const w = await world({ store: "records" });
  const applied = [];
  const chains = { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) };
  const proposals = new Proposals({ kernel: w.kernel, runner: w.runner, store: w.store, chain: () => w.kernel.sysChain(), chains, catalog: () => w.cat, isAdmin: who => who.id === ALEX.id, applyTypes: async (approver, diff) => { applied.push(diff); } });
  w.offs.push(w.kernel.onEvent(e => { void proposals.onEvent(e); }, "proposals"));
  const assistant = w.kernel.chains.fromFacts({ kind: "agent_session", person: ALEX.id, agent: "research", session: "s", thread: "t", vouched: true });
  const diff = { add_types: [{ name: "intake-note", label: "Intake note", fields: [{ name: "body", kind: "text", label: "Body" }] }], remove_types: ["contact"] };
  let p; try { p = await proposals.propose(assistant, { what: "types", diff }); } catch (e) { console.log("propose refused:", e.code || e.message); return; }
  await settle(w);
  const task = w.kernel.tasks.find(t => t.id === p.task);
  console.log("card title:", task.title, "| diff has remove_types:", JSON.stringify(task.form.diff.remove_types));
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  console.log("applied diffs:", JSON.stringify(applied.map(d => ({ add: (d.add_types || []).map(t => t.name), remove: d.remove_types }))));
  assert.ok(!applied.some(d => d.remove_types && d.remove_types.length), "the yes on a card that says 'Change your definitions: intake-note' removed a type nobody named");
});
