import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("the Space's agents as a member sees them: the roster (name, kind, role, model, status), never instructions or sign-ins", async () => {
  const { spaceAgents, askWords } = await import("./space-agents-model.js");
  const rows = [
    { id: "1", name: "research", kind: "agent", model: "opus", status: "idle", instructions: "SECRET INSTRUCTIONS", auth: "setup-token" },
    { id: "2", name: "assistant", kind: "assistant", model: "sonnet", status: "working" },
  ];
  const got = spaceAgents(rows);
  assert.deepEqual(got.map((a) => a.name), ["assistant", "research"], "the assistant first");
  assert.deepEqual(got[1], { name: "research", kind: "agent", role: "", model: "opus", status: "idle" });
  assert.ok(!JSON.stringify(got).includes("SECRET") && !JSON.stringify(got).includes("setup-token"), "no instructions, no sign-in");
  assert.deepEqual(spaceAgents(null), []);
  assert.match(askWords({ name: "research" }, "agent"), /Nothing was started\./);
  assert.equal(askWords({ name: "Drafter" }, "teammate"), "Only the owner and admins can ask this teammate in this release.");
});
