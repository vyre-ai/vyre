// reviewer-2 repro HD-4b against work/memory-access 9379afb82 (drop into core/harness/): after the label fix, `interactive` is believed from the label "harness" with no thread and a session Vyre does not hold as headless.
// "harness" is also a label any process can send on the socket (MODEL_LABEL keeps it as is), and a terminal session's model shares that terminal, so it can forge a person's "yes" for its own session.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import harness from "./index.js";
import { DatabaseSync } from "node:sqlite";

async function run(caller, meta, claimed, session = "term1") {
  const tools = {}, calls = [];
  const ctx = { tool: (n, d) => { tools[n] = d; }, call: async (n, i) => { calls.push([n, i]); if (n === "threads.claimed") return claimed; return null; },
    events: { on: () => () => {}, emit: () => {} }, log: () => {}, config: {}, now: Date.now, kernel: null, settings: { get: () => undefined }, paths: { root: "/nonexistent" },
    store: (() => { const db = new DatabaseSync(":memory:"); return { db, migrate: ms => { for (const m of ms) db.exec(typeof m === "string" ? m : m.sql || String(m)); } }; })() };
  await harness.start(ctx);
  await tools["harness.enrich"].run({ prompt: "yes", session, prompt_id: "p2", interactive: true }, { caller, ...meta });
  return calls.find(c => c[0] === "learn.signal")[1].interactive;
}

test("HD-4: the headless thread case is closed", async () => {
  assert.equal(await run("mcp:thread:t1", { thread: "t1" }, { headless: true }, "t1"), false);
});
test("HD-4b: a model's shell in a person's terminal session sending the label harness must not be taken as the person typing", async () => {
  const v = await run("harness", {}, { headless: false });
  console.log("HD-4b learn.signal interactive:", v);
  assert.equal(v, false, "the label alone cannot say a person typed this; verify the prompt against the session's own transcript (the line Claude Code wrote) instead");
});
