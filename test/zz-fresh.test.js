import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import fs from "node:fs";
import { indexOf, find } from "../harness/mcp/core-tools.js";
import { agentCatalog } from "./tools-universe.js";
const X = JSON.parse(fs.readFileSync(new URL("./fixtures/tools-find-intents-fresh.json", import.meta.url), "utf8"));
test("fresh", async (t) => {
  const cat = await agentCatalog(t); const have = new Set(cat.map(c => c.name)); const index = indexOf(cat);
  let t1 = 0, t3 = 0, n = 0; const out = [];
  for (const x of X) { const want = x.expect.filter(e => have.has(e)); if (!want.length) { out.push(`SKIP(no tool) ${x.intent}`); continue; } n++;
    const g = find(index, x.intent, 3); const w = new Set(want);
    if (g[0] && w.has(g[0].name)) t1++; else out.push(`miss1: ${x.intent} => ${g.map(y=>y.name).join(", ")} (want ${want.join("|")})`);
    if (g.some(y => w.has(y.name))) t3++; }
  out.push(`FRESH n=${n} top1=${t1} (${(100*t1/n).toFixed(0)}%) top3=${t3} (${(100*t3/n).toFixed(0)}%)`);
  fs.writeFileSync(process.env.OUT || "/tmp/fresh.txt", out.join("\n"));
});
