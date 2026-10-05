import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cloudGate, forgetCloudGate, spaceZone } from "./cloud-gate.js";

test("cloud gate: a person with no Cloud membership at all is refused in plain words; a Personal space with a team, Cloud, no answer and an error are not refused", async () => {
  forgetCloudGate();
  const alone = { call: async (/** @type {string} */ tool) => (tool === "spaces.tier" ? { data: { tier: "basic", cloud: [] } } : { error: { code: "no_such_tool" } }) };
  const g = await cloudGate(alone, "spc_home");
  assert.ok(g);
  assert.equal(g.code, "needs_cloud");
  assert.equal(g.message, "Planner needs a Cloud space: join a team or set up My Cloud");
  assert.deepEqual(g.detail, { tier: "basic", spaces: [] });
  assert.doesNotMatch(g.message, /\b(pro|server)\b/i);
  forgetCloudGate();
  const withTeam = { call: async (/** @type {string} */ tool) => (tool === "spaces.tier" ? { data: { tier: "basic", cloud: [{ id: "spc_a", name: "harlow.example", label: "harlow", secret: "x" }, { id: "spc_b" }] } } : { error: { code: "no_such_tool" } }) };
  assert.equal(await cloudGate(withTeam, "spc_home2"), null, "Personal plus a team keeps its Planner (encrypted on the team's server)");
  for (const [i, answer] of [[1, { data: { tier: "cloud", cloud: [] } }], [2, { error: { code: "no_such_tool" } }], [3, null]]) {
    forgetCloudGate();
    assert.equal(await cloudGate({ call: async () => answer }, `spc_${i}`), null);
  }
  forgetCloudGate();
  assert.equal(await cloudGate({ call: async () => { throw new Error("down"); } }, "spc_x"), null, "a failing spaces module is not Basic");
  forgetCloudGate();
});

test("cloud gate: spaceZone is the zone spaces.tier answers for the space, and null when it has none or the module does not answer", async () => {
  forgetCloudGate();
  const zoned = { call: async (/** @type {string} */ tool) => (tool === "spaces.tier" ? { data: { tier: "cloud", cloud: [], time_zone: "America/Los_Angeles" } } : { error: { code: "no_such_tool" } }) };
  assert.equal(await spaceZone(zoned, "spc_z"), "America/Los_Angeles");
  forgetCloudGate();
  assert.equal(await spaceZone({ call: async () => ({ data: { tier: "cloud", cloud: [], time_zone: null } }) }, "spc_n"), null);
  forgetCloudGate();
  assert.equal(await spaceZone({ call: async () => ({ error: { code: "no_such_tool" } }) }, "spc_e"), null);
  forgetCloudGate();
});
