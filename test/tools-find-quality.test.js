// @ts-check
// The find-quality test (R031-00k): 100 intents in plain words, each with the tool (or tools) that answers it, written before the ranker was tuned (test/fixtures/tools-find-intents.json)
// and kept out of the synonym list and the hand asks. tools_find must put an accepted tool first for at least 90 of them. Prints the score and each miss.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { indexOf, find, weak, shapeFind } from "../harness/mcp/core-tools.js";
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

// R031-00k: asks written by people who had not seen the tool list or the ranker (the author never saw a tool name; two labelers each named the tool the assistant should call first, and an ask they did not
// agree on was dropped). dev (92) is what the ranker was tuned on; sealed (202) is scored once per change and never tuned on: its hash is pinned, so the set cannot be edited to improve the score, and the
// score can only go up (tools-find-baseline.json holds the counts; raise them when a change earns it). Set FIND_MISSES=1 to print the misses.
const fixture = (/** @type {string} */ n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const baseline = JSON.parse(fixture("tools-find-baseline.json"));
/** A new tool in the catalog can take one ask from another: two asks of slack, no more. */
const SLACK = 2;

/** @param {any} catalog @param {{ id: string, intent: string, expect: string[] }[]} set */
function scoreSet(catalog, set) {
  const index = indexOf(catalog);
  const have = new Set(catalog.map((/** @type {any} */ c) => c.name));
  let n = 0, top1 = 0, top3 = 0;
  /** @type {string[]} */ const misses = [];
  for (const x of set) {
    const want = new Set(x.expect.filter((e) => have.has(e)));
    if (!want.size) continue;
    n++;
    const got = find(index, x.intent, 3);
    if (got[0] && want.has(got[0].name)) top1++; else misses.push(`${x.id} ${x.intent} => ${got.map((g) => g.name).join(", ") || "nothing"} (wanted ${[...want].join(" | ")})`);
    if (got.some((g) => want.has(g.name))) top3++;
  }
  return { n, top1, top3, misses };
}

for (const name of ["dev", "sealed"]) {
  test(`tools_find on the ${name} asks: first place and first three can only go up (baseline in tools-find-baseline.json)`, async (t) => {
    const raw = fixture(`tools-find-${name}.json`);
    if (name === "sealed") assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), fixture("tools-find-sealed.sha256").trim(), "the sealed set was edited; it may only be replaced by a new sealed set, said openly, with a new hash and a new baseline");
    const r = scoreSet(await agentCatalog(t), JSON.parse(raw));
    console.log(`tools_find ${name}: top-1 ${r.top1} of ${r.n} (${Math.round((100 * r.top1) / r.n)}%), top-3 ${r.top3} of ${r.n} (${Math.round((100 * r.top3) / r.n)}%)`);
    if (process.env.FIND_MISSES) for (const m of r.misses) console.log(`  miss: ${m}`);
    const b = baseline[name];
    assert.ok(r.n >= b.n - 2, `only ${r.n} of ${b.n} asks are answerable now: a tool the labels name was renamed or removed`);
    assert.ok(r.top1 >= b.top1 - SLACK, `top-1 fell from ${b.top1} to ${r.top1} of ${r.n}`);
    assert.ok(r.top3 >= b.top3 - SLACK, `top-3 fell from ${b.top3} to ${r.top3} of ${r.n}`);
  });
}

/** None is tolerated (a preflight guard): a tool brings three asks in lib/tools-asks-bank.js, a renamed tool takes its asks along. */
const GRACE = 0;

test("every tool an agent has carries at least three example asks, and the bank names only tools that exist ", async (t) => {
  const { ASK_BANK } = await import("../lib/tools-asks-bank.js");
  const catalog = await agentCatalog(t);
  const have = new Set(catalog.map((c) => c.name));
  const stale = Object.keys(ASK_BANK).filter((k) => !have.has(k));
  const index = indexOf(catalog);
  const thin = index.docs.filter((d) => d.page.asks.length < 3 || !(ASK_BANK[d.page.path] && ASK_BANK[d.page.path].length >= 3)).map((d) => d.page.path);
  console.log(`tools without three asks of their own: ${thin.length}${thin.length ? ` (${thin.slice(0, 12).join(", ")})` : ""}; bank keys that are no tool: ${stale.length}${stale.length ? ` (${stale.slice(0, 12).join(", ")})` : ""}`);
  assert.ok(thin.length <= GRACE, `give each of these tools three or more ordinary asks in lib/tools-asks-bank.js (what a person says when it is the right tool): ${thin.join(", ")}`);
  assert.ok(stale.length <= GRACE, `these tools were renamed or removed; rename or drop their asks in lib/tools-asks-bank.js: ${stale.join(", ")}`);
});

test("a close call names the two tools and tells the model to ask the person when their words do not settle it", async (t) => {
  const index = indexOf(await agentCatalog(t));
  const found = find(index, "send it", 3);
  const s = /** @type {any} */ (shapeFind(found));
  if (weak(found)) { assert.match(s.unsure, /Close call between \S+ and \S+/); assert.match(s.unsure, /ask them which they mean/); } else assert.equal(s.unsure, undefined);
  assert.equal(s.tools.length, 3);
});
