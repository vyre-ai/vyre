import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("the Space's agents and teammates as a member sees them: names, kinds, tags and roles, never instructions or sign-ins", { skip: !strip && false }, async () => {
  const { spaceAgents, spaceTeammates, askWords } = await import("./space-agents-model.js");
  const rows = { rows: [
    { id: "1", data: { name: "research", kind: "agent", owner: "per_x", model: "opus", tags: "intake, drafting", instructions: "SECRET INSTRUCTIONS", auth: "setup-token" } },
    { id: "2", data: { name: "assistant", kind: "assistant", tags: "" } },
  ] };
  const got = spaceAgents(rows);
  assert.deepEqual(got.map((a) => a.name), ["assistant", "research"], "the assistant first");
  assert.deepEqual(got[1].tags, ["intake", "drafting"]);
  assert.ok(!JSON.stringify(got).includes("SECRET") && !JSON.stringify(got).includes("setup-token") && !JSON.stringify(got).includes("opus"), "no instructions, no auth, no model");
  assert.deepEqual(spaceTeammates({ rows: [{ data: { name: "Drafter", role: "researcher", project: { urn: "x" } } }] }), [{ name: "Drafter", role: "researcher" }]);
  assert.deepEqual(spaceAgents(null), []);
  assert.match(askWords({ name: "research" }, "agent"), /Nothing was started\./);
});
