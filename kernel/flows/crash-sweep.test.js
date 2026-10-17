// @ts-check
// The crash-injection sweep (roadmap 0.6 item 5): for every step kind the run is killed at each write point (each time the runner writes its ledger: before a step, after it, between steps), a new runner
// recovers it, and the world holds exactly what a run that was never killed leaves: one effect for each step. A step kind that is added with no scenario fails the build here.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { STEP_KINDS } from "./schema.js";
import { SCENARIOS, COVERED_BY, runScenario } from "./safety-net.js";

test("every step kind has a place in the safety net: a scenario, or the scenario that runs it", () => {
  const missing = STEP_KINDS.filter(k => !(k in SCENARIOS) && !(k in COVERED_BY));
  assert.deepEqual(missing, [], `add a scenario for ${missing.join(", ")} in kernel/flows/safety-net.js (SCENARIOS), so it is swept, replayed and round-tripped before it ships`);
  for (const [kind, by] of Object.entries(COVERED_BY)) assert.ok(by in SCENARIOS, `${kind} is covered by ${by}, which has no scenario`);
  for (const name of Object.keys(SCENARIOS)) assert.ok(STEP_KINDS.includes(/** @type {any} */ (name)) || name.startsWith("compound: "), `${name} is neither a step kind nor a compound shape`);
});

for (const name of Object.keys(SCENARIOS)) {
  test(`crash sweep: ${name}: killed at every write point, a new runner leaves exactly what an unbroken run leaves`, { timeout: 240_000 }, async () => {
    const sc = SCENARIOS[name];
    const base = await runScenario(name);
    assert.ok(base.root, "the plain run exists");
    assert.equal(base.root.state, sc.ends || "done", JSON.stringify(base.root.error));
    assert.ok(base.writes >= 2 && base.writes <= 80, `a run writes its ledger a few times, not ${base.writes}`);
    for (let n = 1; n <= base.writes; n++) {
      const r = await runScenario(name, { crashAt: n });
      if (!r.root) { assert.equal(r.runs.length, 0, `killed at write ${n}: no run was kept, so nothing was done`); continue; }
      assert.equal(r.root.state, base.root.state, `killed at write ${n} of ${base.writes}: the run ends ${base.root.state}, not ${r.root.state}: ${JSON.stringify(r.root.error)}`);
      assert.equal(r.fingerprint, base.fingerprint, `killed at write ${n} of ${base.writes}: the records and tasks are not what an unbroken run leaves (an effect was repeated or lost)`);
    }
  });
}
