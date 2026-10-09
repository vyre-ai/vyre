// @ts-check
// The find-quality test (R031-00k): 100 intents in plain words, each with the tool (or tools) that answers it, written before the ranker was tuned (test/fixtures/tools-find-intents.json)
// and kept out of the synonym list and the hand asks. tools_find must put an accepted tool first for at least 90 of them. Prints the score and each miss.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { indexOf, find } from "../harness/mcp/core-tools.js";
import { agentCatalog } from "./tools-universe.js";

const intents = JSON.parse(fs.readFileSync(new URL("./fixtures/tools-find-intents.json", import.meta.url), "utf8"));

test("tools_find puts the right tool first for at least 90 of 100 held-out intents", () => {
  const catalog = agentCatalog();
  const index = indexOf(catalog);
  // an expected tool is named by its registry name; the agent calls some of them (the memory tools) under another
  const called = new Map(catalog.map((c) => [c.tool, c.name]));
  const mcpName = (/** @type {string} */ t) => called.get(t) || t;
  const have = new Set(catalog.map((c) => c.name));
  assert.equal(intents.length, 100);
  const bad = intents.filter((/** @type {any} */ x) => !x.expect.some((/** @type {string} */ e) => have.has(mcpName(e))));
  assert.deepEqual(bad.map((/** @type {any} */ x) => x.intent), [], "intents whose expected tools do not exist for an agent");
  let top1 = 0, top3 = 0;
  const misses = [];
  for (const x of intents) {
    const want = new Set(x.expect.map(mcpName));
    const got = find(index, x.intent, 3);
    if (got[0] && want.has(got[0].name)) top1++; else misses.push(`${x.intent} => ${got.map((g) => g.name).join(", ") || "nothing"} (wanted ${x.expect.join(" or ")})`);
    if (got.some((g) => want.has(g.name))) top3++;
  }
  console.log(`tools_find: top-1 ${top1} of ${intents.length}, top-3 ${top3} of ${intents.length}`);
  for (const m of misses) console.log(`  miss: ${m}`);
  assert.ok(top1 >= 90, `top-1 is ${top1} of 100; it must be at least 90`);
});

test("every answer carries a ready example call", () => {
  const index = indexOf(agentCatalog());
  const got = find(index, "remind me to call the bank tomorrow", 3);
  assert.equal(got.length, 3);
  for (const g of got) { assert.equal(typeof g.call.tool, "string"); assert.equal(typeof g.call.arguments, "object"); }
});
