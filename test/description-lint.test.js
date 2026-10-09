// @ts-check
// R031-00m: lean tool descriptions. A description an agent can see is capped at about 25 words; the long ones that exist today are listed in test/description-baseline.json with their length and may only
// shrink. A new tool, or a baselined one that has shrunk under the cap, is held to the cap. The baseline never grows: to rewrite it after shortening descriptions, run
// UPDATE_DESCRIPTION_BASELINE=1 node --test test/description-lint.test.js on the test box and commit the file. Prints how many tools are over the cap and the words they carry.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { agentCatalog } from "./tools-universe.js";

const CAP = 25;
const FILE = new URL("./description-baseline.json", import.meta.url);
const words = (/** @type {string} */ s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

test("descriptions are lean: under the cap, or on the baseline and no longer than it", async (t) => {
  const catalog = await agentCatalog(t);
  /** @type {Record<string, number>} */ const now = {};
  for (const c of catalog) now[c.tool || c.name] = words(c.description);
  const over = Object.entries(now).filter(([, n]) => n > CAP);
  console.log(`tools an agent can see: ${catalog.length}; over ${CAP} words: ${over.length} (${over.reduce((n, [, w]) => n + w, 0)} words); total words ${Object.values(now).reduce((a, b) => a + b, 0)}`);
  if (process.env.UPDATE_DESCRIPTION_BASELINE === "1") {
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(over.sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n");
    return;
  }
  const base = /** @type {Record<string, number>} */ (JSON.parse(fs.readFileSync(FILE, "utf8")));
  const problems = [];
  for (const [name, n] of over) {
    if (!(name in base)) problems.push(`${name}: ${n} words, over the ${CAP}-word cap and not on the baseline (shorten it; put the detail in docs or the tool's input)`);
    else if (n > base[name]) problems.push(`${name}: ${n} words, longer than its baseline ${base[name]}`);
  }
  for (const name of Object.keys(base)) if (name in now && now[name] <= CAP) problems.push(`${name}: now ${now[name]} words, under the cap; remove it from the baseline (UPDATE_DESCRIPTION_BASELINE=1)`);
  assert.deepEqual(problems, []);
});
