// @ts-check
// HD-4: harness.enrich believes `interactive` (a person typing in a terminal, so a bare "yes" may accept a lesson) only from the hook's own label with no Vyre thread behind it.
// The attack: a session plants a lesson, then calls enrich with `interactive: true, prompt: "yes"` to accept it itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import harness from "./index.js";

async function rig() {
  const signals = [];
  const tools = new Map();
  /** @type {any} */ const ctx = {
    store: { db: { exec() {}, prepare: () => ({ run() {}, get() {}, all: () => [] }) }, migrate() {} },
    events: { on: () => () => {}, emit() {} }, log() {}, config: {}, paths: {},
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      if (tool === "learn.signal") { signals.push(input); return { data: { text: "" } }; }
      if (tool === "threads.claimed") return { data: { headless: input.session === "headless-1" } };
      if (tool === "threads.origin") return { data: null };
      return { data: null };
    },
  };
  await harness.start(ctx);
  const enrich = (/** @type {any} */ input, /** @type {any} */ meta) => tools.get("harness.enrich").run({ prompt: "yes", cwd: "/tmp/x", ...input }, meta);
  return { signals, enrich };
}

test("interactive is believed only from the hook's own label, with no Vyre thread, for a session that is not headless", async () => {
  const r = await rig();
  await r.enrich({ session: "term-1", interactive: true }, { caller: "harness" });
  assert.equal(r.signals.at(-1).interactive, true, "a terminal hook may answer a lesson");
  // The attack, each way a session could say it: an mcp caller, a thread's own socket, a headless thread's session, a named agent, and no claim at all.
  await r.enrich({ session: "term-1", interactive: true }, { caller: "mcp:thread:t1", thread: "term-1" });
  assert.equal(r.signals.at(-1).interactive, false, "a model's own mcp call");
  await r.enrich({ session: "t1", interactive: true }, { caller: "harness", thread: "t1" });
  assert.equal(r.signals.at(-1).interactive, false, "a Vyre thread is a program's session even through the hook label");
  await assert.rejects(r.enrich({ session: "headless-1", interactive: true }, { caller: "harness" }), { code: "denied" }, "a headless thread's session cannot be named without its own verified channel");
  await r.enrich({ session: "term-1", interactive: true, agent: "kit" }, { caller: "harness" });
  assert.equal(r.signals.at(-1).interactive, false, "an agent's session never");
  await r.enrich({ session: "term-1" }, { caller: "harness" });
  assert.equal(r.signals.at(-1).interactive, false, "no claim, no yes");
});
