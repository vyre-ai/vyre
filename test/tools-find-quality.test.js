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
// 17 of the 100 above name acts only a person has (inviting a member, approving a Flow): the registry offers an agent no tool for them. These 17 replace them, and were written AFTER the ranker was
// tuned, so they are reported on their own and are not part of the held-out score.
const after = JSON.parse(fs.readFileSync(new URL("./fixtures/tools-find-intents-after.json", import.meta.url), "utf8"));

test("tools_find puts the right tool first for at least 90% of the held-out intents an agent has a tool for", async (t) => {
  const catalog = await agentCatalog(t);
  const index = indexOf(catalog);
  // an expected tool is named by its registry name; the agent calls some of them (the memory tools) under another
  const called = new Map(catalog.map((c) => [c.tool, c.name]));
  const mcpName = (/** @type {string} */ t) => called.get(t) || t;
  const have = new Set(catalog.map((c) => c.name));
  assert.equal(intents.length, 100);
  // Some intents name acts that are only a person's (inviting a member, approving a Flow): the registry offers an agent no tool for them, so there is nothing to find. They are counted apart.
  const answerable = intents.filter((/** @type {any} */ x) => x.expect.some((/** @type {string} */ e) => have.has(mcpName(e))));
  console.log(`intents an agent has a tool for: ${answerable.length} of ${intents.length}`);
  assert.ok(answerable.length >= 80, `only ${answerable.length} intents are answerable`);
  let top1 = 0, top3 = 0;
  const misses = [];
  for (const x of answerable) {
    const want = new Set(x.expect.map(mcpName));
    const got = find(index, x.intent, 3);
    if (got[0] && want.has(got[0].name)) top1++; else misses.push(`${x.intent} => ${got.map((g) => g.name).join(", ") || "nothing"} (wanted ${x.expect.join(" or ")})`);
    if (got.some((g) => want.has(g.name))) top3++;
  }
  const late = after.filter((/** @type {any} */ x) => { const g = find(index, x.intent, 3); return g[0] && x.expect.some((/** @type {string} */ e) => mcpName(e) === g[0].name); }).length;
  console.log(`tools_find on the ${after.length} written after tuning: top-1 ${late}`);
  for (const x of after) { const g = find(index, x.intent, 3); if (!(g[0] && x.expect.some((/** @type {string} */ e) => mcpName(e) === g[0].name))) console.log(`  late miss: ${x.intent} => ${g.map((y) => y.name).join(", ")} (wanted ${x.expect.join(" or ")})`); }
  console.log(`tools_find: top-1 ${top1} of ${answerable.length}, top-3 ${top3} of ${answerable.length}`);
  for (const m of misses) console.log(`  miss: ${m}`);
  assert.ok(top1 / answerable.length >= 0.9, `top-1 is ${top1} of ${answerable.length}; it must be at least 90%`);
});

test("every answer carries a ready example call", async (t) => {
  const index = indexOf(await agentCatalog(t));
  const got = find(index, "remind me to call the bank tomorrow", 3);
  assert.equal(got.length, 3);
  for (const g of got) { assert.equal(typeof g.call.tool, "string"); assert.equal(typeof g.call.arguments, "object"); }
});

// Held-out sets (R031-00q): 51 intents written by an author who had not seen the ranker or the ask table (fresh4) and 49 by another (fresh5, scored once, after all tuning). The
// ask table was then tuned on fresh4's misses, so fresh4 is a regression pin; fresh5 is the honest number and is only reported, because a held-out score that gates a build stops being held out.
for (const name of ["fresh4", "fresh5"]) {
  test(`tools_find on the held-out set ${name} (reported)`, async (t) => {
    const catalog = await agentCatalog(t);
    const index = indexOf(catalog);
    const set = JSON.parse(fs.readFileSync(new URL(`./fixtures/tools-find-intents-${name}.json`, import.meta.url), "utf8"));
    const have = new Set(catalog.map((c) => c.name));
    let n = 0, top1 = 0, top3 = 0;
    for (const x of set) {
      const want = new Set(x.expect.filter((/** @type {string} */ e) => have.has(e)));
      if (!want.size) continue;
      n++;
      const got = find(index, x.intent, 3);
      if (got[0] && want.has(got[0].name)) top1++;
      if (got.some((g) => want.has(g.name))) top3++;
    }
    console.log(`tools_find ${name}: top-1 ${top1} of ${n} (${Math.round((100 * top1) / n)}%), top-3 ${top3} of ${n} (${Math.round((100 * top3) / n)}%)`);
    assert.ok(n >= 40);
  });
}

test("every line of the ask table names a tool an agent has, so a renamed tool does not leave a stale ask", async (t) => {
  const { TOOL_ASKS } = await import("../lib/tools-asks.js");
  const have = new Set((await agentCatalog(t)).map((c) => c.name));
  const stale = Object.keys(TOOL_ASKS).filter((k) => !have.has(k));
  assert.deepEqual(stale, []);
  const covered = [...have].filter((n) => TOOL_ASKS[n]).length;
  console.log(`ask table covers ${covered} of ${have.size} tools`);
});
