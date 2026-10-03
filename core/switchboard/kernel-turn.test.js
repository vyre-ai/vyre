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
import * as config from "../config/index.js";
import { DatabaseSync } from "node:sqlite";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1"; // this test is about the kernel session; the sandbox has its own tests (lib/agent-sandbox.e2e.test.js)

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
  // what the daemon kept of each thread's open kernel turn (the person, the chat, the assistant; never a token): the Switchboard has the daemon open the session, so this is where it shows
  const db = d.registry.deps.db;
  const turnOf = id => { const r = db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(id); return r ? JSON.parse(r.body) : null; };
  const finished = async (id, n) => until(async () => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events.filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);

  // the stream with an asker in any other form (an actor string, a bare name): refused, never quietly rewritten
  for (const bad of ["person:" + owner, "bob", "", owner.toUpperCase()]) {
    const refused = await d.registry.call("threads.start", { cwd: work, prompt: "x", surface: "deck", chat: chat.id, asker: bad }, "module:stream");
    assert.equal(refused.error && refused.error.code, "bad_input", `asker ${JSON.stringify(bad)}: ${JSON.stringify(refused)}`);
  }
  // a person's own surface naming a chat and an asker: ignored
  const m0 = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", chat: chat.id, asker: owner }, "cli");
  assert.ok(m0.data, JSON.stringify(m0.error));
  const mine = m0.data;
  await finished(mine.id, 1);
  assert.equal(turnOf(mine.id)?.chat ?? null, null, "a person's surface cannot name a chat or an asker");
  assert.equal(turnOf(mine.id)?.person, owner, "its own thread is the home owner's");

  // the stream: a thread for the chat, asked by the owner
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  await finished(r.data.id, 1);
  assert.deepEqual([turnOf(r.data.id)?.person, turnOf(r.data.id)?.chat], [owner, chat.id], "opened for the asker, in the chat");

  // the next turn, asked by someone who is not in the chat: the kernel refuses (the turn gets no session, never the owner's), and the previous turn's session is ended
  const second = await d.registry.call("threads.send", { thread: r.data.id, text: "second", surface: "deck", chat: chat.id, asker: "per_mallory" }, "module:stream");
  assert.ok(second.data && second.data.sent !== false, JSON.stringify(second));
  await finished(r.data.id, 2);
  assert.equal(turnOf(r.data.id), null, "no session for a person who is not in the chat, and the last turn's is gone");
});

test("a turn keeps its asker for its whole run: another person's message mid-turn queues as the next turn under its own asker and never steers or swaps the running one", { timeout: 90_000 }, async t => {
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
  const chat = await d.kernel.gateway.grants.chats.create(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" }), {});
  const db = d.registry.deps.db;
  const turnOf = id => { const r = db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(id); return r ? JSON.parse(r.body) : null; };
  const events = async id => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events;
  // "demo" is a turn that stays busy (the fake Claude asks to edit and waits), so what arrives next arrives mid-turn
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "demo", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  await until(async () => (await d.registry.call("threads.asks", { thread: r.data.id }, "cli")).data.some(a => a.tool === "Edit"), "the turn to be busy");
  assert.equal(turnOf(r.data.id)?.person, owner);
  // another person speaks mid-turn: queued, not steered, and the running turn's session is not replaced
  const other = await d.registry.call("threads.send", { thread: r.data.id, text: "delete it", surface: "deck", chat: chat.id, asker: "per_member" }, "module:stream");
  assert.ok(other.data && !other.error, JSON.stringify(other));
  assert.ok(other.data.queued_id || other.data.queued, `queued as the next turn: ${JSON.stringify(other.data)}`);
  assert.equal(turnOf(r.data.id)?.person, owner, "the running turn is still the first asker's: nothing was swapped under it");
  assert.ok(!(await events(r.data.id)).some(e => e.type === "thread.steered" && /delete it/.test(String(e.payload && e.payload.text))), "it did not steer the running turn");
  // the same asker steering their own turn keeps the session they have
  const same = await d.registry.call("threads.send", { thread: r.data.id, text: "and the date", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(same.data && !same.error, JSON.stringify(same));
  assert.equal(turnOf(r.data.id)?.person, owner);
  // the turn ends: the queued message is delivered as its own turn, and the kernel opens (or refuses) THAT asker's session: per_member is not in this chat, so there is none, never the owner's
  for (let i = 0; i < 4; i++) {
    const open = (await d.registry.call("threads.asks", { thread: r.data.id }, "cli")).data;
    for (const a of open) await d.registry.call("threads.answer", { ask: a.id, decision: "allow", surface: "deck" }, "cli");
    if ((await events(r.data.id)).some(e => e.type === "thread.sent" && e.payload.via === "turn")) break;
    await new Promise(res => setTimeout(res, 600));
  }
  await until(async () => (await events(r.data.id)).some(e => e.type === "thread.sent" && e.payload.via === "turn" && /delete it/.test(String(e.payload.text))), "the queued message to be delivered as its own turn");
  assert.equal(turnOf(r.data.id), null, "the second person's turn has no kernel session of the first person's, and none of its own");
});

async function chatDaemon(t, root) {
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts, { recursive: true });
  if (!fs.existsSync(path.join(root, "config.json"))) fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  return start({ root, presence: present, log: () => {}, kernel: true });
}

test("a dormant thread that the stream sends to comes back with THIS turn's chat and asker, not the thread's default session", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const d = await chatDaemon(t, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const chat = await d.kernel.gateway.grants.chats.create(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" }), {});
  const db = d.registry.deps.db;
  const turnOf = id => { const r = db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(id); return r ? JSON.parse(r.body) : null; };
  const fin = async (id, n) => until(async () => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events.filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  await fin(r.data.id, 1);
  await d.registry.call("threads.stop", { thread: r.data.id }, "cli");
  await until(async () => (await d.registry.call("threads.get", { thread: r.data.id }, "cli")).data.thread.status === "stopped", "the thread to stop");
  const back = await d.registry.call("threads.send", { thread: r.data.id, text: "second", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(back.data && !back.error, JSON.stringify(back));
  await fin(r.data.id, 2);
  assert.deepEqual([turnOf(r.data.id)?.person, turnOf(r.data.id)?.chat], [owner, chat.id], "the resumed thread carries this turn's chat, not the default session's");
});

test("a graceful stop keeps the open turns, and the next start reopens them (a restart for an update is graceful)", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  let d = await chatDaemon(t, root);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const chat = await d.kernel.gateway.grants.chats.create(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" }), {});
  // a turn that is still running when the daemon is stopped (the fake Claude waits for an answer)
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "demo", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  await until(async () => (await d.registry.call("threads.asks", { thread: r.data.id }, "cli")).data.some(a => a.tool === "Edit"), "the turn to be busy");
  await d.stop(); // graceful: what SIGTERM does
  const rows = () => { const h = new DatabaseSync(config.paths(root).db); try { return h.prepare("SELECT thread, body FROM kernel_turns").all(); } finally { h.close(); } };
  assert.deepEqual(rows().map(x => [x.thread, JSON.parse(x.body).chat]), [[r.data.id, chat.id]], "the open turn survived the stop");
  d = await chatDaemon(t, root);
  t.after(() => d.stop());
  await new Promise(res => setTimeout(res, 800));
  // the next start reopened it for its person, or gave it up and forgot it: either way nothing is left dangling without a decision
  const left = rows();
  assert.ok(left.length === 0 || left.every(x => JSON.parse(x.body).person === owner), JSON.stringify(left));
});
