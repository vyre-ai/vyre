// @ts-check
// The flow-runs contract (team/contracts/flow-runs.md), on a REAL vyred: a stage move says so once, starts a Flow once, and the run is about the record: flows.runs names it and the
// record's timeline (work.timeline) shows it in plain words.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../../core/daemon/index.js";
import { tempHome, present } from "../helpers.js";
import { RUN_ROW, TIMELINE_ENTRY } from "./flow-runs.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const DOSSIER = { name: "dossier", label: "Dossier", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement"] }], stages: [{ name: "Intake" }, { name: "Engagement" }] };
const NOTE = { name: "welcome-note", label: "Welcome note", fields: [{ name: "body", kind: "text", label: "Body" }] };

test("flow-runs contract: one stage move, one entry, one run; the run names its record and shows on the record's timeline", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  await d.kernel.gateway.records.define(admin, { add_types: [DOSSIER, NOTE] });
  const def = await d.registry.call("flows.define", { flow: { format: 1, name: "welcome", label: "Welcome the client", authorship: "human", trigger: { on: "stage", type: "dossier", stage: "Engagement" }, steps: [{ id: "n", kind: "create", type: "welcome-note", set: { body: "Welcome" } }] } }, "cli", await meta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });

  const rec = await d.kernel.gateway.records.create(admin, "dossier", { name: "Rivera Family Trust", stage: "Intake" });
  await d.kernel.gateway.records.update(admin, "dossier", rec.id, { stage: "Engagement" }, rec.version);
  const runs = await until(async () => { const r = (await d.registry.call("flows.runs", { id: def.data.id }, "cli", await meta())).data || []; return r.length && r.every((/** @type {any} */ x) => x.state === "done") ? r : null; }, "the Flow to finish");
  assert.equal(d.kernel.log.read({ type: "record.stage-entered" }).filter((/** @type {any} */ e) => e.data.stage === "Engagement" && e.subject === rec.urn).length, 1, "one move, one entry on the log");
  assert.equal(runs.length, 1, "one entry, one run");
  assert.deepEqual(Object.keys(runs[0]).sort(), Object.keys(RUN_ROW).sort(), "the row has the contract's fields");
  assert.equal(runs[0].record, rec.urn, "the run names the record the move was about");
  assert.equal(runs[0].label, "Welcome the client");

  const story = (await d.registry.call("work.timeline", { record: rec.urn }, "cli", await meta())).data.entries;
  const hit = story.find((/** @type {any} */ e) => e.type === "flow-run");
  assert.ok(hit, `the record's timeline shows the run: ${JSON.stringify(story)}`);
  for (const k of Object.keys(TIMELINE_ENTRY)) assert.equal(hit[k], /** @type {any} */ (TIMELINE_ENTRY)[k], k);
});
