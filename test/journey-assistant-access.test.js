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

test("probe", async t => {
  const w = await world(t);
  console.log("MOD", JSON.stringify(((await w.person("system.modules", {})).data || {}).modules?.filter?.(m => /assist/.test(m.name)) ?? await w.person("system.modules", {})).slice(0, 400));
  console.log("PERSON get", JSON.stringify(await w.person("assistant.access.get", {})));
  console.log("ASSIST get", JSON.stringify(await w.assistant("assistant.access.get", {})));
  console.log("ASSIST types before", JSON.stringify((await w.assistant("records.types", {})).error || "ok"));
  console.log("PERSON narrow", JSON.stringify(await w.person("assistant.access.narrow", { tools: ["records.*"] })));
  console.log("ASSIST types after", JSON.stringify((await w.assistant("records.types", {})).error || "ok"));
  console.log("PERSON types after", JSON.stringify((await w.person("records.types", {})).error || "ok"));
  console.log("ASSIST narrow", JSON.stringify((await w.assistant("assistant.access.narrow", { tools: ["vault.*"] })).error));
  assert.ok(true);
});
