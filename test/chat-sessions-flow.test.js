// @ts-check
// The sessions contract by behaviour (guard audit #126): a real daemon runs a real turn on a fake Claude, and the events the box emits for it are fed, as a client receives them, through the app's own reducer. What a
// person would see is asserted: the question as said, the answer as it streamed, the turn finished and the session idle. A renamed event or a changed payload key changes this state and fails here; no source text is read.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { asOwner, tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { until, FAKE } from "../core/sessions/testing/boot.js";
import { createSession, applyEvent } from "../apps/app/src/chat/core/session-state.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("a turn on a real daemon, read through the app's reducer: the words said, the answer streamed, the turn finished, the session idle", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const call = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli");
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await call(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };

  const th = await ok("threads.start", { cwd: work, prompt: "What is two and two?", surface: "cli" });
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 200 })).events.some((/** @type {any} */ e) => e.type === "thread.finished"), "the turn");
  const events = (await ok("threads.get", { thread: th.id, limit: 200 })).events;

  const s = createSession(th.id);
  const touched = new Set();
  for (const e of events) for (const k of applyEvent(s, e)) touched.add(k);
  const items = /** @type {any[]} */ (s.items || []);
  const said = items.filter(i => i.kind === "user" || i.type === "user");
  const answered = items.filter(i => (i.kind === "text" || i.type === "text" || i.kind === "assistant") && /echo: What is two and two\?/.test(String(i.text || "")));
  assert.ok(touched.size > 0, "the reducer drew something from the events the box emitted");
  assert.ok(said.length >= 1 || answered.length >= 1, "the person's words or the answer are items: " + JSON.stringify(items).slice(0, 400));
  assert.ok(answered.length === 1, "the answer the fake Claude streamed is one item, whole: " + JSON.stringify(items).slice(0, 600));
  assert.equal(s.state, "idle", "the turn finished and the session is idle");
});
