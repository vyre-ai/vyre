// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetWords, controlWords, tokensFrom } from "./limits-model.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("the allowance and the switch read in plain words", () => {
  assert.deepEqual(budgetWords({ tokens_per_day: 200000, used_today: 12300 }), { line: "12,300 of 200,000 used today", low: false });
  assert.equal(budgetWords({ tokens_per_day: 1000, used_today: 950 }).low, true);
  assert.equal(controlWords({ mode: "running", held: 0, dropped: 0 }), "Flows are running");
  assert.equal(controlWords({ mode: "paused", reason: "owner paused", held: 3, dropped: 0 }), "Flows are paused (owner paused, 3 held)");
  assert.deepEqual(["50,000", " 7 ", "0", "x", "1.5"].map(tokensFrom), [50000, 7, null, null, null]);
});

test("the source sends the budget input, filters connections to the Flow and keeps a refusal's words", { skip: !strip }, async () => {
  const { limitsSource } = await import("./limits-source.ts");
  const seen = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    seen.push([tool, input]);
    if (tool === "flows.budget.set") return { error: { code: "not_allowed", message: "only an owner or an admin sets the AI budget" } };
    if (tool === "flows.connections") return { data: { connections: [{ connection: "crm", flows: [{ id: "f1", label: "A", active: true }] }, { connection: "mail", flows: [{ id: "f2", label: "B", active: true }] }] } };
    return { data: {} };
  };
  const s = limitsSource(/** @type {any} */ (call));
  assert.deepEqual((await s.connectionsOf("f1")).map((c) => c.connection), ["crm"]);
  assert.deepEqual(await s.setBudget(5000), { ok: false, message: "only an owner or an admin sets the AI budget" });
  assert.deepEqual(seen.find((x) => x[0] === "flows.budget.set")?.[1], { tokens_per_day: 5000 });
});
