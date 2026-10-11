// @ts-check
// G23 on a real vyred: a person narrows their own assistant, and the assistant is refused that tool in a real session, with the reason in plain words. The assistant cannot narrow or widen itself, narrowing a
// name that is not a tool is refused, and the person's own calls are never limited (only their assistant's).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, kernelCaller } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "access-box", machine: "server", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
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
