// @ts-check
// A session starts on a plain home with the sandbox in force and thread_socket left at "auto" (a checkout, not a spawner box): it gets its own socket. Before, sandboxFor refused every session,
// a person's included, with "Vyre did not start this session because it has no socket of its own to reach Vyre through".
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
delete process.env.VYRE_SESSION_SANDBOX_OFF;

test("with the sandbox on and thread_socket auto, a person's session and an assistant's both start", { timeout: 120_000, todo: "past the socket refusal this test home hits the next one: the session temp folder (<home>/run/session-tmp) is refused as inside the Vyre home (runner HS-2); asked of runner" }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const person = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck" }, "cli");
  assert.ok(!(person.error && /no socket of its own/.test(person.error.message)), JSON.stringify(person));
  assert.ok(person.data && person.data.id, JSON.stringify(person));
  const made = await d.registry.call("agents.create", { name: "assistant", kind: "assistant", projects: "*" }, "cli");
  assert.ok(!made.error, JSON.stringify(made));
  const ask = await d.registry.call("agents.ask", { agent: "assistant", text: "hello there", wait: false }, "cli");
  assert.ok(!(ask.error && /no socket of its own/.test(ask.error.message)), JSON.stringify(ask));
  assert.ok(!ask.error, JSON.stringify(ask));
});
