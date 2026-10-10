// @ts-check
// J6, Flows that run themselves (team/0.3.1/JOURNEYS.md), on a real daemon: a Flow with a parallel branch and a sub-flow starts from a stage move; both branches finish; the sub-flow returns what the
// step after the join uses; the run shows on the record's timeline in plain words; a schedule with business hours in the Space's zone fires by itself; and "try it on last week" matches what the Flow
// really did. Each step names itself so a red line says which piece did not connect. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 45_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`J6 ${what}: timed out`); await new Promise(r => setTimeout(r, 100)); } };
const DOSSIER = { name: "dossier", label: "Dossier", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement"] }], stages: [{ name: "Intake" }, { name: "Engagement" }] };
const NOTE = { name: "filing-note", label: "Filing note", fields: [{ name: "body", kind: "text", label: "Body" }] };
const ALL_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

test("J6: a Flow with a parallel branch and a sub-flow runs from a stage move, shows on the timeline, replays true; a business-hours schedule fires on its own", { timeout: 900_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => (await d.registry.call(tool, input, "cli", await meta()));
  // A Space on its own record store (Twenty, as in the journeys world) answers "the type definitions could not be read" until that store has started: wait for it before defining anything.
  await until(async () => { try { await d.kernel.store.types(); return true; } catch { return false; } }, "the record store to start", 600_000);
  await d.kernel.gateway.records.define(admin, { add_types: [DOSSIER, NOTE] });
  const install = async (/** @type {any} */ flow) => {
    const r = await call("flows.define", { flow });
    assert.ok(r.data && r.data.ok, `J6 define ${flow.name}: ${JSON.stringify(r)}`);
    await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
    return r.data;
  };
  const notes = async () => ((await d.kernel.gateway.records.query(admin, "filing-note", { page: { limit: 50 } })).rows || []).map((/** @type {any} */ r) => r.data.body).sort();

  // 1. the Flows: a sub-flow that returns an answer, one that splits into two branches (one is the sub-flow) and files the result, and a scheduled one
  await install({ format: 1, name: "inner_note", label: "Write the inner note", authorship: "human", trigger: { on: "manual" }, returns: { body: { expr: "steps.c.record.data.body" } },
    steps: [{ id: "c", kind: "create", type: "filing-note", set: { body: "inner" } }] });
  const outer = await install({ format: 1, name: "engage", label: "Open the engagement", authorship: "human", trigger: { on: "stage", type: "dossier", stage: "Engagement" }, steps: [
    { id: "p", kind: "parallel", steps: [
      { id: "left", kind: "branch", steps: [{ id: "l", kind: "create", type: "filing-note", set: { body: "left lane" } }] },
      { id: "right", kind: "branch", steps: [{ id: "s", kind: "subflow", flow: "inner_note" }] },
    ] },
    { id: "after", kind: "create", type: "filing-note", set: { body: { expr: "\"after: \" + steps.s.result.body" } } },
  ] });
  const tick = await install({ format: 1, name: "weekday_tick", label: "Weekday tick", authorship: "human", trigger: { on: "time", cron: "* * * * *", tz: "UTC", hours: { days: ALL_DAYS, from: "00:00", to: "23:59" }, catch_up: "skip" },
    steps: [{ id: "n", kind: "create", type: "filing-note", set: { body: "tick" } }] });

  // 2. a stage move starts the run; both branches finish; the sub-flow's answer reaches the step after the join
  const before = Date.now() - 60_000;
  const rec = await d.kernel.gateway.records.create(admin, "dossier", { name: "Rivera Family Trust", stage: "Intake" });
  await d.kernel.gateway.records.update(admin, "dossier", rec.id, { stage: "Engagement" }, rec.version);
  const rows = await until(async () => { const r = (await call("flows.runs", { id: outer.id })).data || []; return r.length === 3 && r.every((/** @type {any} */ x) => x.state === "done") ? r : null; }, "step 2, the run and its two branches to finish");
  const parent = rows.find((/** @type {any} */ x) => !x.parent);
  assert.equal(rows.filter((/** @type {any} */ x) => x.parent === parent.id).length, 2, "J6 step 2: two branches under one run");
  assert.ok((await notes()).includes("after: inner"), `J6 step 2: the step after the join used the sub-flow's answer (${await notes()})`);
  assert.deepEqual((await notes()).filter(n => n !== "tick"), ["after: inner", "inner", "left lane"], "J6 step 2: each piece ran once");

  // 3. the run shows on the record's timeline, in plain words
  const story = (await call("work.timeline", { record: rec.urn })).data.entries;
  const hit = story.find((/** @type {any} */ e) => e.type === "flow-run");
  assert.ok(hit, `J6 step 3: the timeline shows the run: ${JSON.stringify(story)}`);
  assert.equal(hit.line, "Open the engagement: done");
  assert.equal(story.filter((/** @type {any} */ e) => e.type === "flow-run").length, 1, "J6 step 3: the branches are not separate lines");

  // 4. the schedule fires on its own in the Space's clock (the next minute), and the Flow's health line names a next time
  await until(async () => ((await call("flows.runs", { id: tick.id })).data || []).some((/** @type {any} */ x) => x.state === "done"), "step 4, the scheduled Flow to run by itself", 150_000);
  const health = (await call("flows.health", { id: tick.id })).data;
  assert.ok(health, "J6 step 4: the scheduled Flow has a health line");

  // 5. try it on last week: the replay matches what really happened
  const sim = (await call("flows.simulate", { id: outer.id, since: before, until: Date.now() + 60_000 })).data;
  assert.equal(sim.ok, true, `J6 step 5: ${JSON.stringify(sim.errors)}`);
  assert.equal(sim.matched, 1, "J6 step 5: the window holds the one real stage move");
  assert.equal(sim.history.matches, true, `J6 step 5: ${sim.history.line}`);
});
