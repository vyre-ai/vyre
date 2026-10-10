// @ts-check
// Ask about this on a real daemon: words the person quotes from the conversation travel with their next message, and the assistant hears them.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";
import { makeHighlight, withQuotes } from "../../apps/app/src/chat/highlight.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("Ask about this: a quote picked in the conversation goes with the person's next message, so the assistant hears the words quoted and the chat shows them too", { timeout: 180_000 }, async t => {
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
  const call = (tool, input, caller = "cli") => d.registry.call(tool, input, caller);
  const ok = async (tool, input) => { const r = await call(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const th = await ok("threads.start", { cwd: work, prompt: "hello", surface: "cli" });
  const chat = (await ok("threads.get", { thread: th.id, limit: 1 })).thread.chat;
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 50 })).events.some(e => e.type === "thread.finished"), "the first turn");
  // what the app does: the person picks words in an answer, then types; the message carries the quote as the app builds it
  const picked = makeHighlight({ from: "juno", text: "The retainer is $4,200 and is due on signing.", selected: "due on signing" });
  const words = withQuotes("Can this wait a week?", picked ? [picked] : []);
  assert.equal(words, "> due on signing\n> \u2014 juno\n\nCan this wait a week?");
  const sent = await call("stream.send", { chat, text: words });
  assert.ok(!sent.error, JSON.stringify(sent));
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 200 })).events.filter(e => e.type === "thread.finished").length >= 2, "the second turn");
  const said = (await ok("threads.get", { thread: th.id, limit: 200 })).events.filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice).map(e => e.payload.text).at(-1);
  assert.ok(said.includes("> due on signing") && said.includes("Can this wait a week?"), "the assistant heard the quote and the question: " + said);
  const frames = /** @type {any[]} */ (d.registry.modules.get("stream").handle.logs.get(chat).read(0));
  assert.equal(frames.filter(f => f.type === "chat.user-message").at(-1).data.text, words, "the chat shows what the person sent, quote included");
});
