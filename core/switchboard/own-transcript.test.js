// @ts-check
// threads.own-transcript: what the sessions side tells the runner so each finished turn of a session on the person's own server is sealed (ports.ownServer.resolve).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE, until } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("threads.own-transcript names a session's transcript and the projects folder it sits under, only for the runner and only for a session it started", { timeout: 90_000 }, async t => {
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
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  await until(async () => (await d.registry.call("threads.get", { thread: r.data.id, limit: 100 }, "cli")).data.events.some((/** @type {any} */ e) => e.type === "thread.finished"), "the turn");
  const got = (await d.registry.call("threads.own-transcript", { session: r.data.id }, "module:runner")).data;
  assert.ok(got, "a session it started has a transcript");
  assert.equal(path.basename(got.file), `${r.data.id}.jsonl`);
  assert.equal(got.root, transcripts, "root is the provider's projects folder, the file sits at <root>/<project>/<session>.jsonl");
  assert.equal(path.dirname(path.dirname(got.file)), got.root);
  assert.equal((await d.registry.call("threads.own-transcript", { session: "aaaaaaaa-1111-4000-8000-000000000009" }, "module:runner")).data, null, "a session it never started is nobody's");
  assert.ok((await d.registry.call("threads.own-transcript", { session: r.data.id }, "cli")).error, "internal: a person's surface does not reach it");
  assert.ok((await d.registry.call("threads.own-transcript", { session: r.data.id }, "mcp")).error, "nor does a model");
});
