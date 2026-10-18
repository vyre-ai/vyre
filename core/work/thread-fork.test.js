// @ts-check
// Fork a thread from one of the agent's replies. The new thread is another chat of the same person and agent that starts at that reply: its first run is the original's conversation up to and including the reply (the
// original run's transcript is not touched), the link to the origin is kept, and the original thread is unchanged. Real daemon with the fake claude, kernel on. Run on a test box, never on a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { callerFacts } from "../daemon/index.js";
import { asOwner, tempHome, present, startDaemonBounded } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";
import { holdersOf, createRing } from "../../lib/chat-keys.js";
import { newDeviceKey } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";
process.env.VYRE_KERNEL ??= "1";

test("a fork keeps the conversation up to and including the chosen reply, starts its own run from there, and leaves the original thread and its transcript alone", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  const transcripts = path.join(root, "transcripts");
  const launchLog = path.join(root, "launches.log");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts, FAKE_CLAUDE_LOG: launchLog });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await startDaemonBounded(t, { root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-fork-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const K = d.kernel, OWNER = K.id.owner;
  const cli = () => ({ kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) });
  const call = (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli", meta = cli()) => d.registry.call(tool, input, caller, meta);
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await call(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  await ok("agents.create", { name: "juno", kind: "agent" });
  const dev = newDeviceKey(), agree = toB64u(Uint8Array.from([4, ...fromB64u(dev.publicJwk.x), ...fromB64u(dev.publicJwk.y)]));
  let n = 0;
  const ring = () => { const id = `chat_00000000-0000-4000-8000-0000000001${String(++n).padStart(2, "0")}`; return { id, ring: createRing(id, holdersOf([{ device: "dev_a", agree }])).doc }; };

  // a thread with juno that has had a conversation: two replies
  const thread = (await ok("work.agent.thread.new", { agent: "juno", title: "the original", ...ring() })).thread;
  const first = await call("threads.start", { cwd: work, prompt: "first question", surface: "deck", chat: thread, asker: OWNER }, "module:stream", {});
  assert.ok(first.data, JSON.stringify(first.error));
  const run = first.data.id;
  // the fake writes <transcripts>/<the folder's name>/<session>.jsonl, as Claude Code does
  const lines = () => fs.readdirSync(transcripts).flatMap(dir => { const p = path.join(transcripts, dir); return fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter(f => f.endsWith(".jsonl")).map(f => ({ f: path.join(dir, f), text: fs.readFileSync(path.join(p, f), "utf8") })) : []; });
  const launches = () => (fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }) : []);
  const assistantLines = (/** @type {string} */ text) => text.split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(j => j.type === "assistant");
  await until(() => lines().some(x => assistantLines(x.text).length >= 1), "the first reply is in the transcript", 30000);
  await until(async () => ((await call("threads.get", { thread: run, limit: 5 })).data.thread || {}).status !== "starting", "the run is up", 30000);
  // the stream holds the keyboard of a run it started, so the second question comes the way the stream sends it
  const second = await call("threads.send", { thread: run, text: "second question", surface: "deck", chat: thread, asker: OWNER }, "module:stream", {});
  assert.ok(!second.error && second.data && second.data.sent !== false, `the second question was sent: ${JSON.stringify(second)}`);
  await until(() => lines().some(x => assistantLines(x.text).length >= 2), "the second reply is in the transcript", 30000);
  const original = lines().find(x => assistantLines(x.text).length >= 2);
  assert.ok(original);
  const replies = assistantLines(original.text);
  const firstReply = replies[0];
  const before = fs.readFileSync(path.join(transcripts, original.f), "utf8");
  const msgId = firstReply.message && firstReply.message.id ? String(firstReply.message.id) : String(firstReply.uuid);

  // a fork from the FIRST reply: the second exchange is not in it
  const forked = await ok("work.thread.fork", { thread, message: msgId, ...ring() });
  assert.notEqual(forked.thread, thread);
  assert.deepEqual(forked.forked_from, { thread, message: msgId });
  const rows = (await ok("work.agent.threads", { agent: "juno" })).threads;
  assert.deepEqual(rows.map((/** @type {any} */ r) => r.thread).sort(), [thread, forked.thread].sort(), "both are threads with juno");
  assert.deepEqual(rows.find((/** @type {any} */ r) => r.thread === forked.thread).forked_from, { thread, message: msgId });
  assert.equal(rows.find((/** @type {any} */ r) => r.thread === thread).forked_from, null, "the original is not marked");
  assert.match(rows.find((/** @type {any} */ r) => r.thread === forked.thread).title, /\(fork\)$/);

  // the fork has no run until it is first answered; the stream then asks where it starts, and only the stream may
  assert.equal((await call("threads.of-chat", { chat: forked.thread }, "module:work", {})).data.runs.length, 0);
  assert.ok((await call("work.chat.fork-source", { chat: forked.thread }, "module:mcp", {})).error, "another module is refused");
  const src = (await call("work.chat.fork-source", { chat: forked.thread }, "module:stream", {})).data;
  assert.equal(src.run, run);
  assert.equal(src.resume_at, String(firstReply.uuid), "the cut is the first reply's own line");
  assert.equal((await call("work.chat.fork-source", { chat: thread }, "module:stream", {})).data, null, "an ordinary thread has no fork source");

  // the first answer in the fork starts a run from that point, in the fork's chat
  const start = await call("threads.start", { cwd: work, prompt: "a different second question", surface: "deck", chat: forked.thread, asker: OWNER, fork: src.run, resumeAt: src.resume_at }, "module:stream", {});
  assert.ok(start.data, JSON.stringify(start.error));
  assert.notEqual(start.data.id, run);
  assert.equal((await call("threads.of-chat", { chat: forked.thread }, "module:work", {})).data.runs.length, 1, "one run, in the fork's chat");
  assert.equal((await call("work.chat.fork-source", { chat: forked.thread }, "module:stream", {})).data, null, "once it has a run it is an ordinary thread");
  await until(() => lines().some(x => x.f !== original.f && assistantLines(x.text).length >= 2), "the fork's transcript has its own reply", 30000);
  // the provider was told to fork the original and to resume at the first reply's own line: that is the cut (the provider drops what comes after it)
  const launch = launches().find(l => l.argv && l.argv.includes("--fork-session") && l.argv.includes("--resume-session-at"));
  assert.ok(launch, "the fork's run was started as a fork with a cut");
  assert.equal(launch.argv[launch.argv.indexOf("--resume-session-at") + 1], String(firstReply.uuid), "the cut is the chosen reply, included");
  const forkText = lines().find(x => x.f !== original.f && assistantLines(x.text).length >= 2)?.text || "";
  assert.ok(forkText.includes(String(firstReply.uuid)), "the fork carries the conversation up to the reply");

  // the original is unchanged: its transcript is byte for byte what it was, and it still has its one run
  assert.equal(fs.readFileSync(path.join(transcripts, original.f), "utf8"), before, "the original transcript is untouched");
  assert.equal((await call("threads.of-chat", { chat: thread }, "module:work", {})).data.runs.length, 1);
  assert.equal((await ok("work.chat.get", { chat: thread })).chat.title, "the original");

  // refusals: a message that is not a reply, a thread that is not yours, a message that does not exist
  const bad = await call("work.thread.fork", { thread, message: crypto.randomUUID(), ...ring() });
  assert.equal(bad.error?.code, "not_found", JSON.stringify(bad));
  const nobody = await call("work.thread.fork", { thread: "chat_00000000-0000-4000-8000-00000000ffff", message: msgId, ...ring() });
  assert.equal(nobody.error?.code, "not_found", JSON.stringify(nobody));
});
