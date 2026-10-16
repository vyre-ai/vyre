// @ts-check
// flows.kit.propose waits for the person on every session adapter and every named agent except the one assistant the registry holds (kind assistant) on a daemon-bound thread.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { loginAdapters, sessionCaller } from "../lib/agent-adapters.js";

const KIT = { kit: "starter" };

test("flows.kit.propose is held for every session adapter and agent label", async (t) => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  await d.registry.call("agents.create", { name: "kit", kind: "agent", projects: [] }, "cli");
  const login = loginAdapters(d.registry.providers.keys());
  assert.deepEqual(login, ["claude", "codex", "grok"]);
  const HELD = new Set(["held_for_approval", "held_unavailable"]);
  for (const id of login) {
    for (const caller of [sessionCaller(id), sessionCaller(id, { agent: id }), sessionCaller(id, { agent: "kit" })]) {
      const r = await d.registry.call("flows.kit.propose", KIT, caller);
      assert.ok(HELD.has(String(r.error && r.error.code)), `${caller}: ${JSON.stringify(r.error)}`);
    }
  }
});

test("flows.kit.propose runs for the registry assistant on a proven session, not for other agents", async (t) => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const made = await d.registry.call("agents.create", { name: "juno", kind: "assistant", projects: "*" }, "cli");
  assert.ok(!made.error, JSON.stringify(made.error));
  await d.registry.call("agents.create", { name: "kit", kind: "agent", projects: [] }, "cli");
  const ok = await d.registry.call("flows.kit.propose", KIT, "mcp:agent:juno", { thread: "thr_prove", agent: "juno" });
  assert.notEqual(ok.error && ok.error.code, "held_for_approval", JSON.stringify(ok.error));
  const held = await d.registry.call("flows.kit.propose", KIT, "mcp:agent:kit", { thread: "thr_prove", agent: "kit" });
  assert.equal(held.error && held.error.code, "held_for_approval", JSON.stringify(held));
});
