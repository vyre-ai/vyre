// @ts-check
// Which of threads.start, agents.ask and team.ask an assistant acting for its person may call on a real daemon, and which a bare model caller may not.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { FAKE } from "../core/sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("a proven assistant starts sessions and asks agents; a bare model caller does not", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  assert.ok(!(await d.registry.call("agents.create", { name: "assistant", kind: "assistant", projects: "*" }, "cli")).error);
  const base = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "deck" }, "cli");
  const own = base.data.id;
  const asAssistant = { thread: own, agent: "assistant", agentKind: "assistant", granted: "*" };
  const out = {};
  for (const [label, caller, meta] of [["assistant", "mcp:agent:assistant", asAssistant], ["bare", "mcp", { thread: own }]]) {
    out[label] = {};
    out[label]["threads.start"] = (await d.registry.call("threads.start", { cwd: work, prompt: "child", surface: "deck" }, caller, meta)).error?.message || "ok";
    out[label]["agents.ask"] = (await d.registry.call("agents.ask", { agent: "assistant", text: "hello", wait: false }, caller, meta)).error?.message || "ok";
    out[label]["team.ask"] = (await d.registry.call("team.ask", { project: "x", role: "design", text: "hi" }, caller, meta)).error?.message || "ok";
  }
  // an assistant acting for its person starts sessions and asks its agents; the body (sessionMay, modelMay, HD-2/HD-9) still decides what a plain session may do
  assert.equal(out.assistant["threads.start"], "ok", JSON.stringify(out));
  assert.equal(out.assistant["agents.ask"], "ok", JSON.stringify(out));
  // a bare model caller no longer meets the registry's person-only default, but never gets more than a session's own scope: it still cannot ask the assistant (HD-9) or reach another thread
  assert.notEqual(out.bare["agents.ask"], "ok", "a plain session cannot ask the assistant");
});
