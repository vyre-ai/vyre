// @ts-check
// `flows.kit.credentials` (the vault's question before it lends a Connection to a task's doer): the Connections an INSTALLED Kit version names for a task template, found by record type, stage and title.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { KitManager, MemoryKitStore } from "./kits.js";

const kit = (/** @type {any} */ extra = {}) => ({ id: "estate", version: 3, name: "Estate", includes: { types: [{ name: "matter",
  stages: [{ name: "Intake", tasks: [{ title: "Look the client up", doer: "teammate:research", credentials: ["orbit-crm", "mail"] }, { title: "Call them", doer: "role:attorney" }] }, { name: "Draft", tasks: [] }],
  stage_sets: [{ stages: [{ name: "Probate intake", tasks: [{ title: "Pull the docket", doer: "teammate:research", credentials: ["court-feed"] }] }] }] }] }, ...extra });

async function mk(/** @type {any} */ row) {
  const store = new MemoryKitStore();
  if (row) await store.put(row);
  return new KitManager({ kernel: /** @type {any} */ ({}), runner: /** @type {any} */ ({}), store, catalog: () => /** @type {any} */ ({}), chains: /** @type {any} */ ({}) });
}

test("an installed Kit's template gives its Connections with the Kit id and version", async () => {
  const m = await mk({ kit_id: "estate", version: 3, status: "installed", kit: kit() });
  assert.deepEqual(await m.credentialsFor({ type: "matter", stage: "Intake", title: "Look the client up" }), { approved: true, kit: "estate", version: 3, credentials: ["orbit-crm", "mail"] });
  assert.deepEqual((await m.credentialsFor({ type: "matter", stage: "Probate intake", title: "Pull the docket" }))?.credentials, ["court-feed"], "a stage set's stages count too");
});

test("nothing is lent from a template that names nothing, a task of another type or stage, a title that is not there, or a Kit that is not installed", async () => {
  const m = await mk({ kit_id: "estate", version: 3, status: "installed", kit: kit() });
  assert.equal(await m.credentialsFor({ type: "matter", stage: "Intake", title: "Call them" }), null);
  assert.equal(await m.credentialsFor({ type: "client", stage: "Intake", title: "Look the client up" }), null);
  assert.equal(await m.credentialsFor({ type: "matter", stage: "Draft", title: "Look the client up" }), null);
  assert.equal(await m.credentialsFor({ type: "matter", stage: "Intake", title: "Look the client UP" }), null);
  for (const status of ["installing", "removed", "declined"]) assert.equal(await (await mk({ kit_id: "estate", version: 3, status, kit: kit() })).credentialsFor({ type: "matter", stage: "Intake", title: "Look the client up" }), null, status);
  assert.equal(await (await mk(null)).credentialsFor({ type: "matter", stage: "Intake", title: "Look the client up" }), null);
});
