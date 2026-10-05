// @ts-check
// HD-4 / HD-4b: harness.enrich believes `interactive` (a person typing in a terminal, so a bare "yes" may accept a lesson) only when the PERSON is behind the call and the session's own transcript
// says they typed exactly this prompt. With the kernel on the person is the call's chain, never a label; with it off (SHIM(legacy labels)) it is the hook's own label.
// The attacks: a session plants a lesson then calls enrich with `interactive: true, prompt: "yes"`, from a thread, as an agent that sends the `harness` label, or as a model in a person's
// terminal that cannot make Claude Code write the line.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import harness from "./index.js";

const person = { hops: [{ actor: { kind: "person", id: "per_a" }, entered_by: "surface" }] };
const agent = { hops: [{ actor: { kind: "person", id: "per_a" }, entered_by: "session" }, { actor: { kind: "agent", id: "kit" }, entered_by: "registry" }] };
const service = { hops: [{ actor: { kind: "service", id: "harness" }, entered_by: "registry" }] };

async function rig({ kernelChain = undefined, lastUser = "yes" } = {}) {
  const signals = [];
  const tools = new Map();
  /** @type {any} */ const ctx = {
    store: { db: { exec() {}, prepare: () => ({ run() {}, get() {}, all: () => [] }) }, migrate() {} },
    events: { on: () => () => {}, emit() {} }, log() {}, config: {}, paths: {},
    ...(kernelChain === undefined ? {} : { kernel: { chain: async () => kernelChain } }),
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      if (tool === "learn.signal") { signals.push(input); return { data: { text: "" } }; }
      if (tool === "threads.claimed") return { data: { headless: input.session === "headless-1" } };
      if (tool === "recall.transcript") return { data: { blocks: lastUser === null ? [] : [{ kind: "turn" }, { kind: "user", text: lastUser }] } };
      return { data: null };
    },
  };
  await harness.start(ctx);
  const enrich = async (/** @type {any} */ input, /** @type {any} */ meta) => { await tools.get("harness.enrich").run({ prompt: "yes", cwd: "/tmp/x", ...input }, meta); return signals.at(-1).interactive; };
  return { enrich };
}

test("the person comes from the chain, never the label", async () => {
  assert.equal(await (await rig({ kernelChain: person })).enrich({ session: "term-1", interactive: true }, { caller: "cli" }), true, "a person chain and the transcript line");
  assert.equal(await (await rig({ kernelChain: person, lastUser: "other" })).enrich({ session: "term-1", interactive: true }, { caller: "cli" }), false, "a person chain still needs the transcript line");
  // The attack: an agent sends the `harness` label. The chain says agent (or no person at all), so the label counts for nothing.
  assert.equal(await (await rig({ kernelChain: agent })).enrich({ session: "term-1", interactive: true }, { caller: "harness" }), false, "an agent chain with the harness label");
  assert.equal(await (await rig({ kernelChain: service })).enrich({ session: "term-1", interactive: true }, { caller: "harness" }), false, "no person chain with the harness label");
  assert.equal(await (await rig({ kernelChain: { ...person, viewer: true } })).enrich({ session: "term-1", interactive: true }, { caller: "cli" }), false, "a viewer");
  assert.equal(await (await rig({ kernelChain: { ...person, delegated: true } })).enrich({ session: "term-1", interactive: true }, { caller: "cli" }), false, "a delegated session");
});
