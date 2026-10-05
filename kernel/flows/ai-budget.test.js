// @ts-check
// AI steps are metered: a daily Space allowance an admin sets, a per-run allowance, and a plain refusal when one is used up.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";

const flowOf = (/** @type {any[]} */ steps) => ({ format: 1, name: "t", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const classify = [{ id: "c", kind: "classify", input: { expr: "trigger.text" }, labels: ["urgent", "normal"] }];
const last = async (/** @type {any} */ w, /** @type {string} */ id) => (await w.runner.listRuns({ flow: id }))[0];

test("AI budget: the default allowance is there, an admin's number replaces it, and spend is counted per day", async () => {
  const w = await world();
  w.kernel.modelLabel = "urgent";
  const b0 = await w.runner.aiBudget();
  assert.equal(b0.tokens_per_day, 200_000);
  assert.equal(b0.used_today, 0);
  const { id } = await install(w, flowOf(classify));
  w.kernel.inbound("payment.received", { text: "help me now" });
  await settle(w);
  assert.equal((await last(w, id)).state, "done");
  const b1 = await w.runner.aiBudget();
  assert.ok(b1.used_today > 0, "the call was counted");
  w.advance(86_400_000);
  assert.equal((await w.runner.aiBudget()).used_today, 0, "a new day starts at zero");
  await assert.rejects(() => w.runner.setAiBudget(-1), { code: "bad_input" });
});

test("AI budget: when the day's allowance is used up the step is refused in plain words and the model is not asked", async () => {
  const w = await world();
  w.kernel.modelLabel = "urgent";
  await w.runner.setAiBudget(0);
  const { id } = await install(w, flowOf(classify));
  w.kernel.inbound("payment.received", { text: "x" });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.state, "failed");
  assert.equal(run.error.code, "ai_budget");
  assert.equal(run.error.message, "This space's AI budget for today is used up");
});

test("AI budget: one run may not keep asking past its own allowance", async () => {
  const w = await world({ limits: { ai_tokens_per_run: 10 } });
  w.kernel.modelLabel = "urgent";
  const { id } = await install(w, flowOf([...classify, { id: "d", kind: "classify", input: { expr: "trigger.text" }, labels: ["urgent", "normal"] }]));
  w.kernel.inbound("payment.received", { text: "a fairly long message that costs more than ten tokens to classify, well over" });
  await settle(w);
  const run = await last(w, id);
  assert.equal(run.error && run.error.code, "ai_budget", JSON.stringify(run.error));
  assert.match(run.error.message, /used its AI allowance/);
});

test("the context budget is a Space setting kept with the Space's Flows: default 1,200, set within 200 to 8,000", async () => {
  const w = await world();
  assert.equal((await w.runner.aiBudget()).context_tokens, 1200);
  assert.equal((await w.runner.setContextTokens(3000)).context_tokens, 3000);
  await assert.rejects(() => w.runner.setContextTokens(100), { code: "bad_input" });
  await assert.rejects(() => w.runner.setContextTokens(9000), { code: "bad_input" });
  const other = await world();
  assert.equal((await other.runner.aiBudget()).context_tokens, 1200, "another Space is untouched");
});
