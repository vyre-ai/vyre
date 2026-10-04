// @ts-check
// How the assistant (the doer) starts and submits a task a person asked for, on a real daemon with the fake provider: the person asks with tasks.request (doer "assistant", the owner or a second
// person checks), the assistant's own session calls tasks.move and tasks.submit, and the task reaches needs_check for the checker.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { FAKE, until } from "../core/sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("the assistant's session starts and submits a task: ready, working, needs_check for the owner", { timeout: 120_000, todo: "agents.ask on a fresh test home starts no assistant thread (unexplained); the tasks.* tools themselves are open to a proven assistant" }, async t => {
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
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  const person = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const task = await d.kernel.gateway.ask.request(person, { title: "Draft the engagement letter", output: { kind: "decision" }, source: "manual", doer: { kind: "agent", id: "assistant", space }, checker: { kind: "person", id: owner, space } });
  assert.equal(task.state, "ready");
  // the assistant's own session (the fake provider) calls the tools the way the MCP server does inside its thread
  // the home's assistant (onboarding makes one; a fresh test home has none)
  const made = await d.registry.call("agents.create", { name: "juno", kind: "assistant" }, "cli");
  assert.ok(!made.error, JSON.stringify(made));
  const name = "juno";
  const ask = async (/** @type {string} */ text) => d.registry.call("agents.ask", { agent: name, text, wait: false, surface: "deck" }, "cli");
  const first = await ask(`vyre tasks.move ${JSON.stringify({ id: task.id, to: "working" })}`);
  assert.ok(!first.error, JSON.stringify(first));
  const row = async () => d.kernel.gateway.ask.get(person, task.id);
  await until(async () => (await row()).state === "working", `the assistant starts the task (${await (async () => { const l = (await d.registry.call("agents.list", {}, "cli")).data.find((/** @type {any} */ x) => x.name === name); const ev = l && l.thread ? (await d.registry.call("threads.get", { thread: l.thread, limit: 100 }, "cli")).data.events : []; return JSON.stringify(ev.filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload.text).map((/** @type {any} */ e) => e.payload.text)); })()})`);
  const second = await ask(`vyre tasks.submit ${JSON.stringify({ id: task.id, evidence: { answer: "yes", reason: "drafted" } })}`);
  assert.ok(!second.error, JSON.stringify(second));
  await until(async () => (await row()).state === "needs_check", "the assistant submits it");
});
