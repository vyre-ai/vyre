// @ts-check
// A stage gate whose required task a person must do is not skipped by a model, whichever way its call reaches vyred. Four model-shaped paths, each on flows.advance and flows.settle's advance:
//   1. a real chat thread (the fake claude, a child of the daemon, calls the daemon over its local socket as Vyre's MCP server does);
//   2. a real thread bound to the stored Engineer agent (its `only` list and its agent key ride the call);
//   3. the person's own session token on a plain model label (mcp);
//   4. a session opened for the person's assistant (person hop, then an agent hop) on the terminal's label.
// All four are refused and the gate stays closed; the person's own call moves it. (Review row 62: the claim that a one-hop person chain reaches a model was checked here and does not hold.) A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { boot, until } from "../core/sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const MATTER = { name: "matter", label: "Matter", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["Review", "Done"] }],
  stages: [{ name: "Review", owner: "role:owner", tasks: [{ title: "Attorney review", doer: "role:owner", output: { kind: "decision" } }] }, { name: "Done" }] };

test("no model-shaped path moves a record past a stage gate; the person's own call does", { timeout: 300_000 }, async t => {
  const w = await boot(t, { driver: "cli", kernel: true });
  const d = w.d, k = d.kernel, space = k.id.space;
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: k.id.owner, path: "direct", session: "s" });
  const host = d.registry.deps.flowsHost.get(space);
  await k.gateway.records.define(owner, { add_types: [MATTER] });
  const gates = () => host.stages.entries().filter((/** @type {any} */ e) => !e.advanced);
  const seen = new Set();
  const gate = async (/** @type {string} */ name) => { await k.gateway.records.create(owner, "matter", { name, stage: "Review" }); const g = await until(async () => gates().find((/** @type {any} */ e) => e.stage === "Review" && !seen.has(e.run)), `the gate of ${name}`); seen.add(g.run); return g; };
  const g = await gate("Rivera");
  const attempts = (/** @type {string} */ run) => [["flows.advance", { run, reason: "skip it" }], ["flows.settle", { run, action: "advance", reason: "skip it" }]];

  // 1 and 2: real threads. The reply of a `vyre <tool> <json>` turn is the JSON the daemon answered.
  for (const [label, start] of [["a chat thread", {}], ["a thread bound to the stored Engineer", { agent: "engineer" }]]) {
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck", ...start })).data;
    await w.finished(th.id);
    let turn = 1;
    for (const [tool, input] of attempts(g.run)) {
      assert.equal((await w.tool("threads.send", { thread: th.id, text: `vyre ${tool} ${JSON.stringify(input)}`, surface: "deck" })).error, undefined);
      await w.finished(th.id, ++turn);
      const said = (await w.said(th.id)).at(-1) || "";
      let answer; try { answer = JSON.parse(said); } catch { answer = null; }
      assert.ok(answer && answer.error, `${label}: ${tool} is refused (${said.slice(0, 200)})`);
    }
  }

  // 3 and 4: sessions at the registry, labelled as a model reaches it
  const token = async (/** @type {any} */ opts) => ({ token: (await k.surfaces.open(owner, opts)).token });
  for (const [tool, input] of attempts(g.run)) {
    assert.ok((await d.registry.call(tool, input, "mcp", await token({}))).error, `the person's token on a model label: ${tool} is refused`);
    assert.ok((await d.registry.call(tool, input, "cli", await token({ agent: "assistant" }))).error, `a person+assistant session: ${tool} is refused`);
  }
  assert.ok(gates().some((/** @type {any} */ e) => e.run === g.run), "the gate is still closed after eight attempts");

  // the person, in their own name, can
  const mine = await d.registry.call("flows.advance", { run: g.run, reason: "reviewed on the phone" }, "cli", await token({}));
  assert.equal(mine.error, undefined, JSON.stringify(mine.error));
  assert.equal(gates().some((/** @type {any} */ e) => e.run === g.run), false, "and then the gate is over");
});
