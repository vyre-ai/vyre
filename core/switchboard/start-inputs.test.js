// @ts-check
// HD-2: threads.start from a model's call takes the declared fields only. resume (a write into any live thread), fork, agent and agent_kind (another agent's credentials) are ignored, never obeyed.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("HD-2: a session's threads.start cannot resume another live thread, fork it, or borrow an agent; the person's surface still can", async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root); // calls from cli/deck arrive as the owner's device, as on the real socket (chat gate)
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const events = async (/** @type {string} */ id) => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events;
  const b = await d.registry.call("threads.start", { cwd: work, prompt: "bash npm test", surface: "deck" }, "cli");
  assert.ok(b.data && b.data.id, JSON.stringify(b));
  const a = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck" }, "cli");
  // the attack, both ways: a bare model session starts nothing at all; the home's assistant (proven) is refused the person's-only fields (resume, fork, agent, agent_kind, env, account) outright
  await d.registry.call("agents.create", { name: "assistant", kind: "assistant", projects: "*" }, "cli");
  await d.registry.call("projects.create", { name: "Work", home: work }, "cli");
  const evilFields = { cwd: work, prompt: "INJECTED INTO B", resume: b.data.id, fork: b.data.id, agent: "assistant", agent_kind: "assistant", env: { X: "1" }, account: "other" };
  const bare = await d.registry.call("threads.start", evilFields, "mcp", { thread: a.data.id });
  assert.ok(bare.error && ["denied", "bad_input"].includes(bare.error.code), `a bare model session starts nothing: ${JSON.stringify(bare)}`);
  const bareClean = await d.registry.call("threads.start", { cwd: work, prompt: "plain child", surface: "deck" }, "mcp", { thread: a.data.id });
  assert.equal(bareClean.error && bareClean.error.code, "denied", `even with no extra fields: ${JSON.stringify(bareClean)}`);
  const proven = await d.registry.call("threads.start", evilFields, "mcp:agent:assistant", { thread: a.data.id, agent: "assistant", agentKind: "assistant", granted: "*" });
  assert.equal(proven.error && proven.error.code, "bad_input", `the assistant cannot send the person's-only fields: ${JSON.stringify(proven)}`);
  assert.ok(!JSON.stringify(await events(b.data.id)).includes("INJECTED INTO B"), "nothing was written into B");
  // without the extra fields the assistant starts a session of its own
  const fine = await d.registry.call("threads.start", { cwd: work, prompt: "my own child", surface: "deck" }, "mcp:agent:assistant", { thread: a.data.id, agent: "assistant", agentKind: "assistant", granted: "*" });
  assert.ok(!fine.error && fine.data && fine.data.id && fine.data.id !== b.data.id, JSON.stringify(fine));
});
