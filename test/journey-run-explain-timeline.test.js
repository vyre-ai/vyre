// @ts-check
// "Explain this run" and a record's timeline, on a REAL vyred (design, rc.2): a stage move starts a Flow; the run's own plain-words explanation (flows.describe by run) is what the card on the run page shows, and the
// record's whole story (work.timeline by record) is what its timeline pane lists, through the app's own models. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { explainText } from "../apps/app/screens/flows/real-model.js";
import { groupByDay, entryRoute } from "../apps/app/screens/projects/days.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const DOSSIER = { name: "dossier", label: "Dossier", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement"] }], stages: [{ name: "Intake" }, { name: "Engagement" }] };
const NOTE = { name: "welcome-note", label: "Welcome note", fields: [{ name: "body", kind: "text", label: "Body" }] };

test("a run explains itself in plain words, and the record it was about has one timeline of its whole story", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const host = d.registry.deps.flowsHost.get(d.kernel.id.space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  await d.kernel.gateway.records.define(admin, { add_types: [DOSSIER, NOTE] });
  const def = await d.registry.call("flows.define", { flow: { format: 1, name: "welcome", label: "Welcome the client", authorship: "human", trigger: { on: "stage", type: "dossier", stage: "Engagement" }, steps: [{ id: "note", kind: "create", label: "Welcome note", type: "welcome-note", set: { body: "Welcome" } }] } }, "cli", await meta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });
  const rec = await d.kernel.gateway.records.create(admin, "dossier", { name: "Rivera Family Trust", stage: "Intake" });
  await d.kernel.gateway.records.update(admin, "dossier", rec.id, { stage: "Engagement" }, rec.version);
  const runs = await until(async () => { const r = (await d.registry.call("flows.runs", { id: def.data.id }, "cli", await meta())).data || []; return r.length && r.every((/** @type {any} */ x) => x.state === "done") ? r : null; }, "the run to finish");

  // the card on the run page
  const described = await d.registry.call("flows.describe", { run: runs[0].id }, "cli", await meta());
  assert.ok(!described.error, JSON.stringify(described.error));
  const words = explainText(described.data);
  assert.ok(words.length > 20, "the box gave a paragraph");
  assert.match(words, /Welcome note/, "it names what the run did, by the step's own label");
  assert.match(words, /finished/, "and where it stands");
  assert.ok(!/step_|\{|\}/.test(words), "no ids or data in it");

  // the record's timeline pane
  const story = (await d.registry.call("work.timeline", { record: rec.urn, limit: 100 }, "cli", await meta())).data.entries;
  assert.ok(story.length >= 1 && story.every((/** @type {any} */ e) => typeof e.line === "string" && e.line), "every entry is one plain line");
  const days = groupByDay(story);
  assert.ok(days.length >= 1 && days[0].items.length >= 1, "the pane has a day to show");
  const run = story.find((/** @type {any} */ e) => e.type === "flow-run");
  assert.ok(run, "the Flow run is on the record's story");
  assert.equal(entryRoute(run), null, "a run line is the story, it opens nothing");
});
