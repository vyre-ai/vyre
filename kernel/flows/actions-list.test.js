// flows.actions: the tools the modules offer as Flow steps, for a picker.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, ALEX } from "./testing/world.js";
import { catalog } from "./testing/fixtures.js";
import { createFlows } from "./index.js";

test("flows.actions lists only the tools a call step can name, sorted, with what each takes and gives", async () => {
  const cat = catalog();
  Object.assign(cat.actions, {
    "documents.generate": { risk: "read", label: "Make a document from a template", tool: true, inputs: { template: "string", values: "object", format: "string" }, outputs: { path: "string" } },
    "comms.send-note": { risk: "outward.send", label: "Send a note", tool: true, inputs: { to: "string", body: "string" } },
  });
  const w = await world({ cat });
  const f = createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, store: w.store, catalog: () => w.runner.catalogFn(), runner: undefined });
  const out = await f.tools["flows.actions"]({ hops: [{ actor: ALEX }] }, {});
  assert.deepEqual(out.actions.map((a) => a.action), ["comms.send-note", "documents.generate"], "the kernel's own actions are not steps; the rest are sorted");
  const doc = out.actions.find((a) => a.action === "documents.generate");
  assert.deepEqual([doc.label, doc.risk, doc.inputs.template, doc.outputs.path], ["Make a document from a template", "read", "string", "string"]);
});
