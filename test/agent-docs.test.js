// @ts-check
// docs/agents: the agent docs (0.3.1, R031-00l). They are written for agents, never offered to a person, never published, short enough to afford, and true. This test holds the set to its contract:
//   - nav.json's `agents` list is exactly the files of docs/agents, and the folder is unpublished
//   - every page is agents-only, carries `tokens` (its budget) and `when`, and is within its budget; the set stays under a total
//   - the generated blocks match the code (scripts/gen-agent-docs.mjs), and every Flow step kind and every error code it can name has words
//   - every tool, command, event, config key and variable a page names exists (the same stale-mention check the human docs have)
//   - no human page links to an agent page, and the website build contains none of them
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCorpus } from "../lib/docs-corpus.js";
import { tokens } from "../lib/tokens.js";
import { ROOT, renderAll, renderPage, STEP_HELP, NEXT } from "../scripts/gen-agent-docs.mjs";

const nav = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/nav.json"), "utf8"));
const corpus = loadCorpus(ROOT);
const TOTAL_BUDGET = 12000;

test("nav.agents is exactly the files of docs/agents, and docs/agents is an unpublished folder", () => {
  const files = fs.readdirSync(path.join(ROOT, "docs/agents")).filter((f) => f.endsWith(".md")).map((f) => `agents/${f}`).sort();
  assert.deepEqual([...nav.agents].sort(), files);
  assert.ok(nav.unpublished.includes("agents/"), "agents/ must be in nav.unpublished so the site, the human nav and the human search never see it");
  assert.ok(files.length >= 14);
});

test("every agent page is agents-only, has a budget and a `when`, is within its budget, and the set is within its total", () => {
  assert.equal(corpus.agent.length, nav.agents.length, "a listed page is missing");
  let total = 0;
  for (const p of corpus.agent) {
    assert.deepEqual(p.audience, ["agents"], `${p.path}: audience must be exactly agents`);
    assert.ok(p.budget, `${p.path}: needs a tokens budget`);
    assert.ok(p.when && p.when.length >= 20 && p.when.length <= 200, `${p.path}: needs a \`when\` line of 20 to 200 characters`);
    assert.ok(p.tokens <= p.budget, `${p.path} is ${p.tokens} tokens, over its budget of ${p.budget}`);
    assert.ok(p.tokens >= p.budget * 0.35, `${p.path} is ${p.tokens} tokens against a budget of ${p.budget}: lower the budget so it means something`);
    assert.ok(!/—|§/.test(p.body), `${p.path}: no em dash, no section sign`);
    total += p.tokens;
  }
  assert.ok(total <= TOTAL_BUDGET, `the agent docs are ${total} tokens in all; the cap is ${TOTAL_BUDGET}`);
});

test("the generated blocks are current, and every step kind and error code has words", async () => {
  const out = await renderAll();
  for (const [name, text] of Object.entries(out)) {
    const file = { outward: "outward-acts.md", tools: "tools.md", records: "records.md", flows: "flows.md", connections: "connections.md", errors: "errors.md" }[name];
    assert.equal(fs.readFileSync(path.join(ROOT, "docs/agents", file), "utf8"), text, `docs/agents/${file} is out of date: run node scripts/gen-agent-docs.mjs`);
  }
  const idx = await renderPage("index", fs.readFileSync(path.join(ROOT, "docs/agents/index.md"), "utf8"));
  assert.equal(fs.readFileSync(path.join(ROOT, "docs/agents/index.md"), "utf8"), idx, "docs/agents/index.md is out of date: run node scripts/gen-agent-docs.mjs");
  const { STEP_KINDS } = await import("../kernel/flows/schema.js");
  assert.deepEqual(STEP_KINDS.filter((k) => !STEP_HELP[k]), [], "a Flow step kind has no words in scripts/gen-agent-docs.mjs");
  assert.deepEqual(Object.keys(STEP_HELP).filter((k) => !STEP_KINDS.includes(k)), [], "STEP_HELP names a step kind that is gone");
  assert.ok(Object.values(NEXT).every((t) => t.length > 15), "every error code needs a next step");
});

test("every tool, command, event, config key and variable the agent pages name exists", async () => {
  const { staleMentions } = await import("../scripts/lib/docs/terms.js");
  const pages = corpus.agent.map((p) => ({ rel: p.path, source: fs.readFileSync(path.join(ROOT, "docs", p.path), "utf8") }));
  const problems = staleMentions(ROOT, pages).filter((p) => p.file.startsWith("docs/agents/"));
  assert.deepEqual(problems.map((p) => `${p.file}:${p.line}: ${p.problem}`), []);
});

test("no human page links to an agent page, and the website build contains none of them", async () => {
  for (const p of corpus.human) assert.ok(!/\]\((?:\.\.\/)*agents\//.test(p.body) && !/docs\/agents\//.test(p.body), `${p.path} links to an agent page`);
  const { build } = await import("../scripts/lib/docs/build.js");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-docs-site-"));
  try {
    build({ root: ROOT, out, log: () => {} });
    const all = fs.readdirSync(out, { recursive: true }).map(String);
    assert.deepEqual(all.filter((f) => /(^|\/)agents(\/|$)/.test(f)), [], "an agent page was written to the site");
    // what is unique to an agent page: its `when` line and its own file path
    const marks = corpus.agent.flatMap((p) => [p.when, p.path]);
    for (const f of all.filter((x) => /\.(json|txt|xml|md|html)$/.test(x))) {
      const text = fs.readFileSync(path.join(out, f), "utf8");
      for (const m of marks) assert.ok(!text.includes(m), `${f} contains "${m}" from an agent page`);
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
