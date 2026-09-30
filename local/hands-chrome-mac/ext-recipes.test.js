// @ts-check
// Recipes: a batch that worked, kept as data with no typed value in it, replayed as one batch with the same guards.
import test from "node:test";
import assert from "node:assert/strict";
import { toRecipe, fill } from "./extension/lib/recipes.js";
import recipe, { remember } from "./extension/caps/recipe.js";
import batch from "./extension/caps/batch.js";

const STEPS = [
  { op: "ghl.section", label: "open Workflows", args: { section: "workflows" } },
  { op: "page.act", label: "click Create Workflow", args: { tabId: 7, selector: { name: "Create Workflow", identifier: "create-workflow" }, kind: "click" } },
  { op: "page.fill", label: "name it", args: { tabId: 7, fields: [{ selector: { identifier: "workflow-name" }, label: "Workflow Name", value: "Harlow intake for Robin Ellis" }] } },
  { op: "api.call", label: "create", args: { tabId: 7, entry: "e1", args: { body: { name: "Harlow intake", status: "draft" } } } },
];

test("a batch becomes a recipe: what a person typed turns into parameters and is never stored", () => {
  const r = toRecipe("create-workflow", STEPS, [{}, {}, {}, { method: "POST" }]);
  assert.deepEqual(r.params.map(p => p.name), ["workflow_name", "name", "status"]);
  const text = JSON.stringify(r);
  for (const typed of ["Harlow intake for Robin Ellis", "Harlow intake", "draft"]) assert.ok(!text.includes(typed), `${typed} must not be stored`);
  assert.equal(r.steps[2].args.fields[0].value, "{workflow_name}");
  assert.equal(r.steps[3].write, "create", "a write is named so a plan can see it in advance");
  assert.ok(r.steps.every(s => s.args.tabId === undefined && s.args.asked === undefined), "no tab and no approval claim is stored");
  assert.equal(r.steps[1].args.selector.identifier, "create-workflow", "selectors stay");
});

test("replay fills every parameter and names a missing one", () => {
  const r = toRecipe("create-workflow", STEPS, [{}, {}, {}, { method: "POST" }]);
  const steps = fill(r, { workflow_name: "Probate intake", name: "Probate", status: "draft" });
  assert.equal(steps[2].args.fields[0].value, "Probate intake");
  assert.equal(steps[3].args.args.body.name, "Probate");
  assert.throws(() => fill(r, { workflow_name: "x" }), /name, status/);
});

function ctxWith(/** @type {any} */ over = {}) {
  const store = /** @type {Record<string, any>} */ ({});
  const calls = /** @type {any[]} */ ([]);
  const ctx = {
    storage: { get: async (/** @type {string} */ _a, /** @type {string} */ k) => store[k], set: async (/** @type {string} */ _a, /** @type {any} */ o) => Object.assign(store, o) },
    tabs: { get: async () => ({ id: 7, url: "https://app.gohighlevel.com/v2/location/L1/automation/workflows" }) },
    stopped: () => false,
    call: async (/** @type {string} */ op, /** @type {any} */ a) => { calls.push([op, a]); return over.call ? over.call(op, a) : { ok: true, did: "x", method: "POST" }; },
  };
  return { ctx, calls, store };
}

test("batch.run with saveAs keeps a recipe only when every step worked; recipe.run replays it as one batch on the named tab", async () => {
  const { ctx, calls } = ctxWith();
  const res = await batch.ops["batch.run"]({ tabId: 7, saveAs: "Create Workflow!", steps: STEPS }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.recipe.name, "create-workflow");
  assert.deepEqual(res.recipe.params, ["workflow_name", "name", "status"]);
  const list = await recipe.ops["recipe.list"]({ tabId: 7 }, ctx);
  assert.equal(list.recipes[0].name, "create-workflow");
  assert.deepEqual(list.recipes[0].writes, ["create"]);
  calls.length = 0;
  const run = await recipe.ops["recipe.run"]({ tabId: 7, name: "create-workflow", params: { workflow_name: "Probate", name: "Probate", status: "draft" } }, ctx);
  assert.equal(calls.length, 1, "one batch, not one call per step");
  assert.equal(calls[0][0], "batch.run");
  assert.equal(calls[0][1].tabId, 7);
  assert.equal(calls[0][1].asked, false, "replay never claims the person asked");
  assert.equal(calls[0][1].steps.length, 4);
  assert.equal(run.steps, 4);
  // a failed batch keeps nothing
  const bad = ctxWith({ call: (/** @type {string} */ op) => (op === "page.fill" ? { ok: false, why: "no" } : { ok: true }) });
  const r2 = await batch.ops["batch.run"]({ tabId: 7, saveAs: "x", steps: STEPS }, bad.ctx);
  assert.equal(r2.ok, false);
  assert.equal((await recipe.ops["recipe.list"]({ tabId: 7 }, bad.ctx)).recipes.length, 0);
});

test("a recipe gains trust when it works and loses it when it fails; an unknown name and a missing parameter are refused plainly", async () => {
  const { ctx } = ctxWith();
  await remember(ctx, "https://app.gohighlevel.com", toRecipe("r", [STEPS[1]], [{}]));
  const a = await recipe.ops["recipe.run"]({ tabId: 7, name: "r" }, ctx);
  assert.ok(a.conf > 0.5);
  const fail = ctxWith({ call: () => ({ ok: false, why: "gone" }) });
  await remember(fail.ctx, "https://app.gohighlevel.com", toRecipe("r", [STEPS[1]], [{}]));
  const b = await recipe.ops["recipe.run"]({ tabId: 7, name: "r" }, fail.ctx);
  assert.ok(b.conf < 0.5);
  await assert.rejects(recipe.ops["recipe.run"]({ tabId: 7, name: "nope" }, ctx), { code: "not_found" });
  await remember(ctx, "https://app.gohighlevel.com", toRecipe("p", [STEPS[2]], [{}]));
  await assert.rejects(recipe.ops["recipe.run"]({ tabId: 7, name: "p", params: {} }, ctx), { code: "bad_request" });
  assert.equal((await recipe.ops["recipe.forget"]({ tabId: 7, name: "p" }, ctx)).forgotten, true);
});
