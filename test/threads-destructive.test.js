// @ts-check
// threads.delete and threads.rewind destroy a conversation (and, with restore, files). The 4 Oct declaration opened every session tool to a model, the body scoping each one; for these two the body is not
// enough, so they are also on ASK_FIRST (core/modules/agent-reach.js): a call that claims an agent or a thread is held for the person, and a plain mcp or harness session (no thread, no agent) never reaches them.
// The person's own surface still deletes and rewinds. Real daemon, kernel on, temp home, fakes only.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { ASK_FIRST } from "../core/modules/agent-reach.js";
import { tempHome, present } from "./helpers.js";
import { FAKE } from "../core/sessions/testing/boot.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("delete and rewind are held or refused for every model caller, and the thread survives; the person's own surface deletes", { timeout: 300_000 }, async t => {
  assert.ok(ASK_FIRST.has("threads.delete") && ASK_FIRST.has("threads.rewind"), "both are ask first");
  const root = fs.realpathSync(tempHome(t));
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.VYRE_SESSION_SANDBOX_OFF = "1";
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on", max_live: 50 } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(root, "work-")));
  const made = await d.registry.call("threads.start", { cwd: work, prompt: "the person's own thread", surface: "deck" }, "cli");
  assert.ok(made.data && made.data.id, JSON.stringify(made));
  const id = made.data.id;
  const exists = async () => Boolean((await d.registry.call("threads.get", { thread: id }, "cli")).data);
  /** @type {string[]} */ const ran = [];
  for (const tool of ["threads.delete", "threads.rewind"]) {
    for (const [caller, meta] of /** @type {[string, any][]} */ ([
      ["mcp", {}], ["harness", {}], ["mcp:agent:kit", {}], ["mcp:thread:x", { thread: id }], ["mcp:agent:kit", { agent: "kit", agentKind: "assistant", thread: id }],
    ])) {
      const r = await d.registry.call(tool, tool === "threads.rewind" ? { thread: id, uuid: "00000000-0000-4000-8000-000000000000" } : { thread: id }, caller, meta);
      if (!r.error) ran.push(`${caller} ${tool}`);
      else assert.ok(["held_unavailable", "denied", "no_such_tool", "person_session_required", "not_declared", "presence_required"].includes(r.error.code), `${caller} ${tool}: ${JSON.stringify(r.error)}`);
    }
  }
  assert.deepEqual(ran, [], "no model caller deleted or rewound");
  assert.equal(await exists(), true, "the thread is untouched");
  const gone = await d.registry.call("threads.delete", { thread: id }, "cli");
  assert.ok(!gone.error, JSON.stringify(gone));
  assert.equal(await exists(), false, "the person's own surface deleted it");
});
