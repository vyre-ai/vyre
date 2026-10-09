// tools-rerank-measure (parked follow-up (c), team/BACKLOG.md): does reranking tools_find's lexical top 20 with Recall's embedder lift the held-out score? Blends the lexical score with the cosine of
// the ask and each candidate's text at several weights and prints top-1, top-3 and top-5. Run on a test box that has the embedder installed:
//   RERANK_CATALOG=<catalog.json from agentCatalog> RERANK_RUNTIME=<home>/embedder RERANK_MODELS=<home>/models node scripts/tools-rerank-measure.mjs test/fixtures/tools-find-intents-fresh5.json
// Ship the rerank only if set B (fresh5) top-1 rises by 5 points or more over w=0.
import fs from "node:fs";
import { indexOf, find } from "../harness/mcp/core-tools.js";
import { TOOL_ASKS } from "../lib/tools-asks.js";
import { load, cosine } from "../core/recall/embed.js";
const cat = JSON.parse(fs.readFileSync(process.env.RERANK_CATALOG, "utf8")); const index = indexOf(cat); const have = new Set(cat.map(c => c.name)); const by = new Map(cat.map(c => [c.name, c]));
const r = await load({ cacheDir: process.env.RERANK_MODELS, runtime: process.env.RERANK_RUNTIME, download: false });
if (!r.embedder) { console.log("no embedder:", r.why); process.exit(1); }
const E = r.embedder;
const first = s => String(s || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0].slice(0, 200);
const text = n => `${n.replace(/[_-]+/g, " ")}. ${first(by.get(n).description)}. ${(TOOL_ASKS[n] || []).slice(0, 3).join(". ")}`;
const cache = new Map();
const vec = async n => { if (!cache.has(n)) cache.set(n, await E.embed(text(n))); return cache.get(n); };
const t0 = Date.now();
const sets = process.argv.slice(2);
const W = [0, 0.3, 0.5, 0.7, 1];
for (const f of sets) {
  const X = JSON.parse(fs.readFileSync(f, "utf8")); const tot = Object.fromEntries(W.map(w => [w, [0, 0, 0]])); let n = 0;
  for (const x of X) { const want = new Set(x.expect.filter(e => have.has(e))); if (!want.size) continue; n++;
    const top = find(index, x.intent, 20); const qv = await E.embed(x.intent); const mx = top[0] ? top[0].score : 1;
    const cos = []; for (const t of top) cos.push(cosine(qv, await vec(t.name)));
    for (const w of W) { const ranked = top.map((t, i) => ({ name: t.name, s: (1 - w) * (t.score / mx) + w * cos[i] })).sort((a, b) => b.s - a.s);
      if (want.has(ranked[0].name)) tot[w][0]++; if (ranked.slice(0, 3).some(y => want.has(y.name))) tot[w][1]++; if (ranked.slice(0, 5).some(y => want.has(y.name))) tot[w][2]++; } }
  console.log(f.split("/").pop(), "n=" + n); for (const w of W) console.log("  w=" + w, "top1", tot[w][0], "top3", tot[w][1], "top5", tot[w][2]);
}
console.log("ms", Date.now() - t0);
