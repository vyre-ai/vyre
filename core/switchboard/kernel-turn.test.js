// A chat turn's kernel session on a real vyred with the real kernel: the stream (and only the stream) names the chat and the person who asked; the Switchboard has the daemon open
// that turn's session for them, and the kernel checks they are in the chat.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX = "0"; // this test is about the kernel session; the sandbox has its own tests (lib/agent-sandbox.e2e.test.js)

test("threads.start and threads.send from module:stream open the asker's kernel session in the chat; anyone else's chat and asker are ignored", { timeout: 90_000 }, async t => {
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
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const chat = await d.kernel.gateway.grants.chats.create(ownerChain, {});
  // record what the Switchboard asks the daemon to open, and let the real one run
  const real = d.registry.deps.kernelSession, asked = [];
  d.registry.deps.kernelSession = async q => { asked.push({ thread: q.thread, chat: q.chat || null, asker: q.asker || null }); return real(q); };
  const finished = async (id, n) => until(async () => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events.filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);

  // a person's own surface naming a chat and an asker: ignored
  const m0 = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", chat: chat.id, asker: owner }, "cli");
  assert.ok(m0.data, JSON.stringify(m0.error));
  const mine = m0.data;
  await finished(mine.id, 1);
  assert.deepEqual(asked.at(-1), { thread: mine.id, chat: null, asker: null }, "a person's surface cannot name a chat or an asker");

  // the stream: a thread for the chat, asked by the owner
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  await finished(r.data.id, 1);
  assert.deepEqual(asked.at(-1), { thread: r.data.id, chat: chat.id, asker: owner }, "opened for the asker, in the chat");

  // the next turn, asked by someone who is not in the chat: the daemon is asked for them and the kernel refuses (the turn gets no session, never the owner's)
  const n = asked.length;
  const second = await d.registry.call("threads.send", { thread: r.data.id, text: "second", surface: "deck", chat: chat.id, asker: "per_mallory" }, "module:stream");
  assert.ok(second.data && second.data.sent !== false, JSON.stringify(second));
  await finished(r.data.id, 2);
  assert.deepEqual(asked.slice(n)[0], { thread: r.data.id, chat: chat.id, asker: "per_mallory" });
  // anyone else carrying a chat: nothing is opened
  const n2 = asked.length;
  const third = await d.registry.call("threads.send", { thread: r.data.id, text: "third", surface: "deck", chat: chat.id, asker: owner }, "cli");
  assert.ok(third.data, JSON.stringify(third)); // the keyboard is the stream's, so this is refused; either way nothing is opened for a chat that a person's surface named
  await new Promise(res => setTimeout(res, 300));
  assert.equal(asked.length, n2, "not the stream: nothing opened");
});
