// @ts-check
// Memory, measured (docs/adr/0007-intelligence.md, decision 5). Runs scripts/eval-memory.js on
// the fictional world in this process and holds the line:
//
//  - leakage is 0, always: a fact from one room showing in another is a hard failure;
//  - no metric falls more than 0.02 below test/eval/memory-baseline.json;
//  - the ADR's targets are checked too, and the ones the baseline does not meet yet are marked
//    todo, so they show in every run without failing it. Once a target is met and the baseline
//    is rewritten (npm run eval:memory -- --write-baseline), its todo drops and it holds.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runEval, regressions, THRESHOLDS, BASELINE_FILE } from "../../scripts/eval-memory.js";

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")).metrics;
/** One run for every test below. */
const report = runEval();
report.catch(() => {});   // each test reports the failure itself

test("memory eval: nothing leaks between rooms", async () => {
  const r = await report;
  assert.equal(r.leakage, 0, "facts crossed rooms:\n" + r.failures.leaks.map(x => `  ${x.room}  ${x.id}  (${x.via})`).join("\n"));
});

test("memory eval: nothing leaks with the optional relations switched on either", async () => {
  const r = await report;
  assert.equal(r.optional?.leakage, 0, "facts crossed rooms with config.memory.relations on:\n" + (r.optional?.failures.leaks || []).map(x => `  ${x.room}  ${x.id}  (${x.via})`).join("\n"));
});

test("memory eval: the threads picked into a project are members of its room", async () => {
  const r = await report;
  const rooms = Object.entries(r.rooms).filter(([room, v]) => room.startsWith("project:") && v && typeof v === "object" && v.picked !== null);
  assert.ok(rooms.length, "no project in the world has picked threads to check");
  for (const [room, v] of rooms) assert.equal(v.picked, true, `${room}: its picked threads are not in its room`);
});

test("memory eval: no metric is more than 0.02 below the baseline", async () => {
  const r = await report;
  const worse = regressions(r.metrics, baseline);
  assert.deepEqual(worse, [], worse.map(w => `${w.key}: ${w.was} -> ${w.now}`).join("\n"));
});

const meets = (t, v) => typeof v === "number" && ("max" in t ? v <= /** @type {number} */ (t.max) : v >= /** @type {number} */ (t.min));

for (const t of THRESHOLDS) {
  if (t.key === "leakage") continue;
  const was = baseline[t.key];
  const todo = meets(t, was) ? undefined : `not met yet (baseline ${was === undefined ? "unsupported" : was})`;
  test(`memory eval target: ${t.label}`, { todo }, async () => {
    const v = (await report).metrics[t.key];
    assert.ok(meets(t, v), `${t.key} is ${v === undefined ? "unsupported" : v}`);
  });
}
