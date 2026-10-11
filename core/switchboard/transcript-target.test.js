// @ts-check
// threads.transcript-target is where a lender's transcript is placed on this server, so it answers only for the chat of the person it is asked for: a computer that names another person's thread gets nothing placed.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { until, FAKE } from "../sessions/testing/boot.js";

test("a transcript is placed only in the chat of the person it is for", { timeout: 90_000 }, async t => {
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF };
  const root = tempHome(t);
  const transcripts = path.join(root, "transcripts"); fs.mkdirSync(transcripts);
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts, VYRE_SESSION_SANDBOX_OFF: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root); t.after(() => d.stop());
  const ownerId = String(d.kernel.id.owner);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: ownerId, path: "direct", session: "s1" });
  const chat = await d.kernel.gateway.grants.chats.create(ownerChain, {});
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "tt-work-")));
  const started = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", chat: chat.id, asker: ownerId }, "module:stream");
  assert.ok(!started.error, JSON.stringify(started));
  const th = started.data;
  await until(async () => (await d.registry.call("threads.get", { thread: th.id, limit: 50 }, "cli")).data.events.some((/** @type {any} */ e) => e.type === "thread.finished"), "the first turn", 60_000);
  const ask = (/** @type {any} */ i) => d.registry.call("threads.transcript-target", i, "module:vyred", { door: true });
  const mine = await ask({ thread: th.id, person: ownerId });
  assert.ok(mine.data && mine.data.file, "the chat's own person gets its place: " + JSON.stringify(mine));
  const other = await ask({ thread: th.id, person: "per_" + "x".repeat(26) });
  assert.ok(other.error && other.error.code === "not_allowed" && /ask the chat's owner/.test(other.error.message), "another person is refused with a next step: " + JSON.stringify(other));
  const byNative = await ask({ thread: th.id, person: "per_" + "x".repeat(26) });
  assert.ok(!byNative.data, "and gets nothing, by whatever name the thread is called");
  assert.ok((await ask({ thread: th.id })).error, "a call that names no person is refused");
});
