// Text written before braces had a meaning in the editor stays literal at run time: the runner never reads {word} in a plain string, so an older agent instruction reaches the agent as typed
// (the editor shows it escaped and saves it back as the same plain text: apps/app/ui/flows/text-lists.test.js).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { createAgentWake } from "../../core/daemon/agent-wake.js";

test("an agent instruction stored as plain text with {client} in it reaches the agent with the braces as written", async () => {
  const w = await world({ kernel: "real" });
  w.kernel.addActor({ kind: "agent", id: "research", space: w.cat.space });
  const { id } = await install(w, { format: 1, name: "t", label: "T", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "go", kind: "agent", assistant: "teammate:research", title: "Reply to {client}", instructions: "Greet {client}, then ask about {topic}. Keep {{this}} as it is.", output: { kind: "note" } }] });
  await w.runner.start(id, { client: "Jane" }, w.kernel.as(ALEX));
  await settle(w);
  const woke = [];
  const onEvent = createAgentWake({ space: w.cat.space, gw: { ask: { get: (c, i) => w.kernel.ask.get(c, i), edit: (c, i, p) => w.kernel.tasksApi.edit(c, i, p) } }, chain: () => w.kernel.sysChain(), editChain: () => w.kernel.as(ALEX),
    clock: () => w.kernel.clock(), callModule: async (_tool, input) => { woke.push(input); return { agent: input.agent, thread: "thr-1", already: false }; }, log: () => {} });
  for (const e of w.kernel.rawLog.read({ type: "task.*" })) await onEvent(e);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].instructions, "Greet {client}, then ask about {topic}. Keep {{this}} as it is.", "the braces are not filled");
  assert.equal(woke[0].title, "Reply to {client}", "nor in the title");
});
