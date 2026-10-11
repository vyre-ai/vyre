// @ts-check
// G23 on a real vyred: a person narrows their own assistant, and the assistant is refused that tool in a real session, with the reason in plain words. The assistant cannot narrow or widen itself, narrowing a
// name that is not a tool is refused, and the person's own calls are never limited (only their assistant's).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, kernelCaller, writeModule } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "access-box", machine: "server", vault: { keystore: "file" } }));
  // a module of the test's own whose tool runs in another Space the way a team turn or the member door does (ctx.kernel.for(space).call(tool, input, chain), the registry's callInSpace)
  writeModule(path.join(root, "modules"), "probe", { version: "0.1.0", vyre: "1", description: "A tool that runs in a Space.", does: { tools: [{ name: "probe.there", crossSpace: "records.read", reach: "anyone", effect: "read" }, { name: "probe.call", reach: "anyone", effect: "read" }] }, needs: { kernel: { actions: [] } } },
    `export default { async start(ctx) {
      ctx.tool("probe.there", { effect: "read", input: { type: "object" }, run: async () => ({ ran: true }) });
      ctx.tool("probe.call", { effect: "read", input: { type: "object" }, run: async (i) => ctx.kernel.for(i.space).call("probe.there", {}, i.chain) });
      return {};
    } };`);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const person = kernelCaller(d, root);
  /** The person's own assistant in a session of theirs: the person's chain plus a model hop, a thread the daemon bound. */
  const assistant = (/** @type {string} */ tool, input = {}) => d.registry.call(tool, input, "mcp", {
    thread: "t-1", agentKind: "assistant",
    kernelFacts: { kind: "agent_session", agent: "assistant", person: d.kernel.id.owner, session: "s1", thread: "t-1", vouched: true },
  });
  return { d, person, assistant };
}

test("the person narrows their assistant: that tool is refused for the assistant in a real session, in plain words, and the person's own call still works", async t => {
  const w = await world(t);
  assert.ok(!(await w.assistant("threads.list")).error, "the assistant may use it at first");
  const before = (await w.person("assistant.access.get", {})).data;
  assert.deepEqual(before.tools, []);
  assert.ok(before.screens.every(/** @type {any} */ s => s.off === false));
  const narrowed = await w.person("assistant.access.narrow", { tools: ["threads.list"] });
  assert.ok(!narrowed.error, JSON.stringify(narrowed.error));
  assert.deepEqual(narrowed.data.tools.map(/** @type {any} */ x => x.name), ["threads.list"]);
  const refused = await w.assistant("threads.list");
  assert.equal(refused.error?.code, "access_narrowed", JSON.stringify(refused.error));
  assert.equal(refused.error.message, "You turned off threads.list for your assistant, so it cannot use threads.list. You can change this in Settings, Assistant access.");
  assert.ok(!(await w.person("threads.list")).error, "the person's own call is never limited");
  assert.ok(!(await w.assistant("agents.list")).error, "a tool that was not narrowed still works for the assistant");
  // the assistant can read what it may not do, and say so
  assert.deepEqual((await w.assistant("assistant.access.get")).data.tools.map(/** @type {any} */ x => x.name), ["threads.list"]);
});

test("a whole area: turning a screen off stops every tool of it for the assistant", async t => {
  const w = await world(t);
  assert.ok(!(await w.person("assistant.access.narrow", { screens: ["vault"] })).error);
  const r = await w.assistant("vault.list");
  assert.equal(r.error?.code, "access_narrowed", JSON.stringify(r.error));
  assert.match(r.error.message, /^You turned off Vault for your assistant, so it cannot use vault\.list\./);
  assert.equal((await w.person("assistant.access.get")).data.screens.find(/** @type {any} */ s => s.id === "vault").off, true);
});

test("only the person narrows or restores: never the assistant, and a name that is not a tool is refused", async t => {
  const w = await world(t);
  assert.equal((await w.assistant("assistant.access.narrow", { tools: ["threads.list"] })).error?.code, "denied");
  assert.equal((await w.assistant("assistant.access.restore", { tools: ["threads.list"] })).error?.code, "denied");
  for (const bad of [{ tools: ["not a tool"] }, { tools: ["assistant.access.narrow"] }, { screens: ["everything"] }, {}, { tools: "records.*" }]) {
    const r = await w.person("assistant.access.narrow", bad);
    assert.equal(r.error?.code, "bad_input", JSON.stringify([bad, r.error]));
  }
  assert.deepEqual((await w.person("assistant.access.get")).data.tools, [], "nothing was saved");
});

test("narrowing only ever makes it smaller: it cannot be undone through narrow, and restoring is the person's own yes", async t => {
  const w = await world(t);
  assert.ok(!(await w.person("assistant.access.narrow", { tools: ["threads.list"] })).error);
  assert.ok(!(await w.person("assistant.access.narrow", { tools: ["threads.list"] })).error, "narrowing twice is the same");
  assert.equal((await w.person("assistant.access.get")).data.tools.length, 1);
  // there is no input of narrow that widens: nothing here removes a row
  const again = await w.person("assistant.access.narrow", { tools: ["agents.list"] });
  assert.deepEqual(again.data.tools.map(/** @type {any} */ x => x.name), ["agents.list", "threads.list"]);
});

test("a door call that carries the assistant's session is limited like any other, and a door call with no session is not", async t => {
  const w = await world(t);
  assert.ok(!(await w.person("assistant.access.narrow", { tools: ["threads.list"] })).error);
  const meta = { thread: "t-1", agentKind: "assistant", kernelFacts: { kind: "agent_session", agent: "assistant", person: w.d.kernel.id.owner, session: "s1", thread: "t-1", vouched: true } };
  const viaDoor = await w.d.registry.call("threads.list", {}, "mcp", { ...meta, door: true });
  assert.equal(viaDoor.error?.code, "access_narrowed", JSON.stringify(viaDoor.error));
  const internal = await w.d.registry.call("threads.list", {}, "module:vyred", { door: true });
  assert.ok(!internal.error || internal.error.code !== "access_narrowed", "the daemon's own internal call carries no session, so no assistant limit applies to it");
});

test("a team turn or the member door runs a tool in a Space with no thread (callInSpace): the chain decides, so a narrowed tool is refused there, and the person's own chain is not", async t => {
  const w = await world(t);
  const space = w.d.kernel.spaces.list()[0];
  const owner = w.d.kernel.id.owner;
  const session = (/** @type {string} */ agent) => w.d.kernel.chains.fromFacts({ kind: "agent_session", agent, person: owner, session: "s1", thread: "t-1", vouched: true });
  const mine = w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const viaSpace = async (/** @type {any} */ c) => (await w.d.registry.call("probe.call", { space, chain: c }, "cli", { kernelFacts: { kind: "socket", surface: "deck", uid: process.getuid ? process.getuid() : 0, pid: 1, inside_model_process: false, capsule_verified: true } })).data;
  // before anything is narrowed the assistant's chain runs it
  const before = await viaSpace(session("assistant"));
  assert.equal(before?.data?.ran, true, JSON.stringify(before));
  assert.ok(!(await w.person("assistant.access.narrow", { tools: ["probe.there"] })).error);
  const refused = await viaSpace(session("assistant"));
  assert.equal(refused?.error?.code, "access_narrowed", JSON.stringify(refused));
  assert.match(refused.error.message, /You turned off probe\.there for your assistant/);
  const own = await viaSpace(mine);
  assert.equal(own?.data?.ran, true, "the person's own chain in that Space is never limited");
  const named = await viaSpace(session("kit"));
  assert.notEqual(named?.error?.code, "access_narrowed", "a named agent has its own grants and is not limited here");
});
