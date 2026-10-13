// @ts-check
// The Flow catalog lists the Space's real agents, live; compile still refuses a name that is not one.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { teammateNames } from "./teammate-names.js";
import { compileFlow } from "../../kernel/flows/compile.js";
import { catalog, onPayment } from "../../kernel/flows/testing/fixtures.js";

test("teammateNames: the assistant and every agent the agents module lists, asked each time", async () => {
  let roster = [{ name: "juno" }];
  const call = async (/** @type {string} */ tool) => { assert.equal(tool, "agents.list"); return roster; };
  assert.deepEqual(await teammateNames(call, "s"), ["assistant", "juno"]);
  roster = [{ name: "juno" }, { name: "scribe" }];
  assert.deepEqual(await teammateNames(call, "s"), ["assistant", "juno", "scribe"], "an agent made later is there at once");
});

test("teammateNames: no agents module, or one that fails, leaves just the assistant and says so", async () => {
  assert.deepEqual(await teammateNames(undefined, "s"), ["assistant"]);
  const logs = /** @type {string[]} */ ([]);
  assert.deepEqual(await teammateNames(async () => { throw new Error("down"); }, "s", m => logs.push(m)), ["assistant"]);
  assert.match(logs[0], /down/);
});

test("a Flow agent step for a custom agent compiles with the live list, and an unknown name is still refused", () => {
  const withAgent = (/** @type {string} */ who) => { const f = /** @type {any} */ (onPayment()); f.steps.push({ id: "ag", kind: "agent", assistant: `teammate:${who}`, title: "t", instructions: "i", output: { kind: "note" } }); return f; };
  const cat = /** @type {any} */ (catalog());
  cat.teammates = ["assistant", "scribe"];
  const errs = (/** @type {string} */ who) => JSON.stringify(compileFlow(withAgent(who), cat).errors || []);
  assert.doesNotMatch(errs("scribe"), /no teammate/);
  assert.match(errs("ghost"), /no teammate ghost/);
});
