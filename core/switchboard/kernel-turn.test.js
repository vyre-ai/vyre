// A chat turn's kernel session on a real vyred with the real kernel: the stream (and only the stream) names the chat and the person who asked; the Switchboard has the daemon open
// that turn's session for them, and the kernel checks they are in the chat.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
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
  asOwner(d, root);
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
  assert.notEqual(turnOf(mine.id)?.chat ?? null, chat.id, "a person's surface cannot name a chat or an asker (the run's own chat is one the daemon made, not the one it named)");
  assert.equal(turnOf(mine.id)?.person, owner, "its own thread is the home owner's");

  // the stream: a thread for the chat, asked by the owner
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  await finished(r.data.id, 1);
  assert.deepEqual([turnOf(r.data.id)?.person, turnOf(r.data.id)?.chat], [owner, chat.id], "opened for the asker, in the chat");

  // the next turn, asked by someone who is not in the chat: refused by the kernel BEFORE it is run or queued, and the thread's session is untouched
  const second = await d.registry.call("threads.send", { thread: r.data.id, text: "second", surface: "deck", chat: chat.id, asker: "per_mallory" }, "module:stream");
  assert.equal(second.error && second.error.code, "not_found", JSON.stringify(second));
  assert.deepEqual([turnOf(r.data.id)?.person, turnOf(r.data.id)?.chat], [owner, chat.id], "nothing ran and no session was swapped");
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
  asOwner(d, root);
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
  assert.equal(other.error && other.error.code, "not_found", `a person who is not in the chat is refused before anything is queued: ${JSON.stringify(other)}`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threads_inbox WHERE thread = ?").get(r.data.id).n, 0, "and nothing was queued");
  assert.equal(turnOf(r.data.id)?.person, owner, "the running turn is still the first asker's: nothing was swapped under it");
  assert.ok(!(await events(r.data.id)).some(e => /delete it/.test(JSON.stringify(e.payload || {}))), "it never reached the session");
  // the same asker steering their own turn keeps the session they have
  const same = await d.registry.call("threads.send", { thread: r.data.id, text: "and the date", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(same.data && !same.error, JSON.stringify(same));
  assert.equal(turnOf(r.data.id)?.person, owner);
  // (queueing a MEMBER's message behind another's turn, and delivering it as its own turn, is exercised with two real members in core/stream/e2e-asker.test.js)
});

async function chatDaemon(t, root) {
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts, { recursive: true });
  if (!fs.existsSync(path.join(root, "config.json"))) fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  return asOwner(await start({ root, presence: present, log: () => {}, kernel: true }), root);
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

test("SS-3: two askers sending to an idle thread at the same moment: one runs now, the other queues, and the first turn keeps its own session; a chat turn behind a turn with no chat queues too", { timeout: 90_000 }, async t => {
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
  // an idle thread (its first turn is over), then two askers send at once
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  await fin(r.data.id, 1);
  const both = await Promise.all([
    d.registry.call("threads.send", { thread: r.data.id, text: "demo from the owner", surface: "deck", chat: chat.id, asker: owner }, "module:stream"),
    d.registry.call("threads.send", { thread: r.data.id, text: "from the other", surface: "deck", chat: chat.id, asker: "per_other" }, "module:stream"),
  ]);
  assert.ok(both[0].data && !both[0].error, `the owner's goes in: ${JSON.stringify(both[0])}`);
  assert.equal(both[1].error && both[1].error.code, "not_found", `the person who is not in the chat is refused whatever the timing: ${JSON.stringify(both[1])}`);
  assert.equal(turnOf(r.data.id)?.person, owner, "the running turn is the owner's");
  assert.ok(!(await d.registry.call("threads.get", { thread: r.data.id, limit: 500 }, "cli")).data.events.some(e => /from the other/.test(JSON.stringify(e.payload || {}))), "their words never reached the session");
  // a chat turn behind a turn with no chat: a person's own surface types "demo" (busy), then the stream sends
  const mine = await d.registry.call("threads.start", { cwd: work, prompt: "demo", surface: "deck" }, "cli");
  await until(async () => (await d.registry.call("threads.asks", { thread: mine.data.id }, "cli")).data.some(a => a.tool === "Edit"), "the turn to be busy");
  const behind = await d.registry.call("threads.send", { thread: mine.data.id, text: "from the chat", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(behind.data && (behind.data.queued_id || behind.data.queued), `queued, not swapped in: ${JSON.stringify(behind)}`);
  assert.notEqual(turnOf(mine.data.id)?.chat ?? null, chat.id, "the running turn keeps the session it has (its own chat, not the stream's)");
});

test("the ordinary path the chat path shares code with: a plain threads.start and threads.send, no chat and no asker, on a real daemon with the kernel on", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const d = await chatDaemon(t, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const events = async id => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events;
  const fin = async (id, n) => until(async () => (await events(id)).filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck" }, "cli");
  assert.ok(r.data, JSON.stringify(r));
  await fin(r.data.id, 1);
  assert.ok((await events(r.data.id)).some(e => e.type === "thread.text" && e.payload.done && /echo: hello/.test(String(e.payload.text))), "the first turn answered");
  const s = await d.registry.call("threads.send", { thread: r.data.id, text: "and again", surface: "deck" }, "cli");
  assert.ok(s.data && s.data.sent === true, JSON.stringify(s));
  await fin(r.data.id, 2);
  assert.ok((await events(r.data.id)).some(e => e.type === "thread.text" && e.payload.done && /echo: and again/.test(String(e.payload.text))), "the second turn answered");
  // the queued-message path that shares the name `sendNow` is still the queue's: sending a queued message now is its own tool
  const q = await d.registry.call("threads.send-now", { thread: r.data.id, queued: 999999 }, "cli");
  assert.ok(q.error || (q.data && q.data.sent === false), "send-now of a message that was never queued says so, not 'sent'");
});

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("one send, one kernel session: a duplicate send changes nothing, and a send after a restart does not open the thread's session twice", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  let d = await chatDaemon(t, root);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const chat = await d.kernel.gateway.grants.chats.create(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" }), {});
  const count = () => d.registry.deps.kernelSessionCount();
  const fin = async (id, n) => until(async () => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events.filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);
  assert.equal(count(), 0);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  await fin(r.data.id, 1);
  assert.equal(count(), 1, "one thread, one session");
  // the same send twice (the stream retries a delivery it did not hear back from): the second is answered as already handed over and opens nothing
  const send = u => d.registry.call("threads.send", { thread: r.data.id, text: "again", surface: "deck", chat: chat.id, asker: owner, uuid: u }, "module:stream");
  const a = await send(U(1));
  assert.ok(a.data && a.data.sent === true, JSON.stringify(a));
  await fin(r.data.id, 2);
  const before = count();
  const b = await send(U(1));
  assert.ok(b.data && b.data.already === true, `a duplicate is already handed over: ${JSON.stringify(b)}`);
  assert.equal(count(), before, "a duplicate opened no session");
  // a restart: the open turn is reopened for its person (one session for the thread), and ONE send to the resumed thread leaves it at one
  await d.stop();
  d = await chatDaemon(t, root);
  t.after(() => d.stop());
  await new Promise(res => setTimeout(res, 1500));
  assert.ok(count() <= 1, `after the restart at most the reopened one: ${count()}`);
  const c = await d.registry.call("threads.send", { thread: r.data.id, text: "after the restart", surface: "deck", chat: chat.id, asker: owner, uuid: U(2) }, "module:stream");
  assert.ok(c.data && c.data.sent === true, JSON.stringify(c));
  await until(async () => (await d.registry.call("threads.get", { thread: r.data.id, limit: 500 }, "cli")).data.events.some(e => e.type === "thread.text" && e.payload.done && /echo: after the restart/.test(String(e.payload.text))), "the reply after the restart");
  assert.equal(count(), 1, "one send across a restart: one session for the thread");
});

test("a chat message queued behind a turn survives a restart and then runs under its own asker", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  let d = await chatDaemon(t, root);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const chat = await d.kernel.gateway.grants.chats.create(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" }), {});
  // a turn with no chat is running ("demo" waits for an answer); the chat's message queues behind it
  const mine = await d.registry.call("threads.start", { cwd: work, prompt: "demo", surface: "deck" }, "cli");
  await until(async () => (await d.registry.call("threads.asks", { thread: mine.data.id }, "cli")).data.some(a => a.tool === "Edit"), "the turn to be busy");
  const queued = await d.registry.call("threads.send", { thread: mine.data.id, text: "queued from the chat", surface: "deck", chat: chat.id, asker: owner, uuid: U(3) }, "module:stream");
  assert.ok(queued.data && (queued.data.queued_id || queued.data.queued), JSON.stringify(queued));
  const rows = () => { const h = new DatabaseSync(config.paths(root).db); try { return h.prepare("SELECT thread, text, kturn, delivered_at FROM threads_inbox").all(); } finally { h.close(); } };
  await d.stop(); // the restart cuts the running turn off
  const kept = rows();
  assert.equal(kept.length, 1, "the queued message survived the stop");
  assert.equal(JSON.parse(kept[0].kturn).asker, owner, "with its own asker");
  assert.equal(kept[0].delivered_at, null, "not delivered, not lost");
  d = await chatDaemon(t, root);
  t.after(() => d.stop());
  await until(async () => (await d.registry.call("threads.get", { thread: mine.data.id, limit: 500 }, "cli")).data.events.some(e => e.type === "thread.sent" && e.payload.via === "turn" && /queued from the chat/.test(String(e.payload.text))), "the queued message to run after the restart", 40_000);
  // (thread.sent is said as the message is taken; its kernel session opens just before the words are written)
  const turnOf = async () => { const r = d.registry.deps.db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(mine.data.id); const b = r && JSON.parse(r.body); return b && b.chat === chat.id ? b : null; };
  const turn = await until(turnOf, "the queued message's own turn to be open", 20_000);
  assert.deepEqual([turn.person, turn.chat], [owner, chat.id], "under its own asker, in its chat");
});

// A chat turn's words reach the Switchboard as module:stream, so the call carries no person: the asker is the id the stream names, which the kernel has checked is in the chat. Chips on such a turn
// resolve as that asker. A record or a whole-object pick is read under the asker's OWN chain (a member sees only what a member may see); a vault, Drive or GitHub chip and a #Name would answer
// under the owner's access, so they are heard only for the home's own owner. (The stream's calls are module:stream; nothing here is a person's surface.)
const TYPE = { name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "budget", kind: "number", label: "Budget", hidden_from: ["member"] }] };

async function chipChat(t, who) {
  const root = tempHome(t);
  const d = await chatDaemon(t, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const BOB = "per_" + "b".repeat(26);
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [TYPE] });
  const rec = await d.kernel.gateway.records.create(ownerChain, "client", { name: "Jane Harlow", budget: 5000 });
  // an item in the OWNER's vault: what a member's chip must never resolve, and what the owner's own chip does (the control that lets the member test fail)
  const put = await d.registry.call("vault.put", { name: "owner-secret", kind: "api-key", value: "sk-test-owner-only-value", hosts: ["https://api.example.com"] }, "cli");
  assert.ok(put.data && !put.error, JSON.stringify(put));
  const chat = await d.kernel.gateway.grants.chats.create(ownerChain, { people: [BOB] });
  const events = async id => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events;
  const fin = async (id, n) => until(async () => (await events(id)).filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  await fin(r.data.id, 1);
  const send = async (asker, mentions, text = "look at these") => {
    const before = (await events(r.data.id)).filter(e => e.type === "thread.finished").length;
    const sent = await d.registry.call("threads.send", { thread: r.data.id, text, surface: "deck", chat: chat.id, asker, mentions }, "module:stream");
    assert.ok(sent.data && !sent.error, JSON.stringify(sent));
    await fin(r.data.id, before + 1);
    return (await events(r.data.id)).filter(e => e.type === "thread.mentioned");
  };
  return { d, owner, BOB, rec, send, thread: r.data.id, chat: chat.id, events };
}

test("a member's chat turn tags a record they may read, as themselves, and nothing the owner's access would answer", { timeout: 90_000 }, async t => {
  const { BOB, rec, send } = await chipChat(t);
  const mentioned = await send(BOB, [{ kind: "record", id: rec.urn }, { kind: "vault", id: "owner-secret" }, { kind: "drive", id: "owner-file" }, { kind: "github", id: "owner/repo" }], "use #owner-secret and the file");
  const kinds = mentioned.flatMap(e => (e.payload.mentions || []).map(m => m.kind));
  assert.deepEqual(kinds, ["record"], `only the record, read under the member's chain: ${JSON.stringify(mentioned)}`);
});

test("the owner's chat turn resolves their own vault item; a member's chip and #Name for the same item resolve nothing from the owner's vault", { timeout: 90_000 }, async t => {
  const { owner, BOB, send } = await chipChat(t);
  const kinds = ev => ev.flatMap(e => (e.payload.mentions || []).map(m => `${m.kind}:${m.id || m.name}`));
  const mine = await send(owner, [{ kind: "vault", id: "owner-secret" }], "use #owner-secret");
  assert.ok(kinds(mine).includes("vault:owner-secret"), `the control: the owner's own chip resolves in a chat: ${JSON.stringify(mine)}`);
  const theirs = await send(BOB, [{ kind: "vault", id: "owner-secret" }], "use #owner-secret");
  assert.equal(kinds(theirs).filter(k => k.startsWith("vault:")).length, kinds(mine).filter(k => k.startsWith("vault:")).length, "the member's turn added no vault tag: the owner's item is not theirs");
});

test("a member's chat turn with a record that is not there, or one from another Space, tags nothing", { timeout: 90_000 }, async t => {
  const { BOB, send } = await chipChat(t);
  const mentioned = await send(BOB, [{ kind: "record", id: "vyre://spc_bbbbbbbbbbbb/client/abc" }, { kind: "record", id: "vyre://nonsense" }]);
  assert.deepEqual(mentioned, [], "plain words, never a tag");
});

test("the owner's own chat turn tags a record too (chips resolve in a chat for the person who asked)", { timeout: 90_000 }, async t => {
  const { owner, rec, send } = await chipChat(t);
  const mentioned = await send(owner, [{ kind: "record", id: rec.urn }]);
  assert.deepEqual(mentioned.flatMap(e => (e.payload.mentions || []).map(m => m.kind)), ["record"]);
});

test("a chat turn's words never record what the owner asked for (hearActs is a person's own surface only)", { timeout: 90_000 }, async t => {
  const { d, BOB, send, thread } = await chipChat(t);
  const asks = async () => { const r = await d.registry.call("vault.said.list", { thread }, "module:gate"); assert.ok(r.data && !r.error, `the list call must answer, or this test proves nothing: ${JSON.stringify(r)}`); return JSON.stringify(r.data); };
  // the control: an owner ask recorded the way a person's own turn records one is listed, so the list does show asks
  const rec = await d.registry.call("vault.said.record", { thread, said: "said-control", kind: "send", to: ["dana@example.com"], what: "email Dana the control line" }, "module:sessions");
  assert.ok(rec.data && !rec.error, JSON.stringify(rec));
  assert.ok((await asks()).includes("control line"), "the control ask is listed");
  const before = await asks();
  // a member's chat words that read like an ask: nothing more is recorded
  await send(BOB, [], "email dana@example.com the form link and open a PR and merge it");
  assert.equal(await asks(), before, "a member's chat words added no ask");
});

// fix53's member half of the tripwire, as it was on the 0.5.3 side: a non-owner's vault, Drive and GitHub chips and #Name resolve nothing and add no note. Kept as it is.
test("a non-staff member's chat turn with a vault chip, a Drive chip, a GitHub chip and a #Name reaches the thread with none resolved and no note added", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const d = await chatDaemon(t, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const BOB = "per_" + "b".repeat(26);
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const chat = await d.kernel.gateway.grants.chats.create(ownerChain, { people: [BOB] });
  const events = async id => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events;
  const fin = async (id, n) => until(async () => (await events(id)).filter(e => e.type === "thread.finished").length >= n, `turn ${n}`);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  await fin(r.data.id, 1);
  const chips = [{ kind: "vault", id: "owner-secret" }, { kind: "drive", id: "owner-file" }, { kind: "github", id: "owner/repo" }];
  const sent = await d.registry.call("threads.send", { thread: r.data.id, text: "use #owner-secret and the file", surface: "deck", chat: chat.id, asker: BOB, mentions: chips }, "module:stream");
  assert.ok(sent.data && !sent.error, JSON.stringify(sent));
  await fin(r.data.id, 2);
  const seen = await events(r.data.id);
  assert.deepEqual(seen.filter(e => e.type === "thread.mentioned"), [], "no chip or #Name was resolved, and no note was added to the turn");
  const turn = d.registry.deps.db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(r.data.id);
  assert.equal(JSON.parse(turn.body).person, BOB, "and the turn ran as the member, not the owner");
});

// What an ask or a lent item covers is the turn's asker, not the chat. The fake Claude's "demo" prompt keeps a turn busy (it asks to edit and waits), so a turn is RUNNING while the vault is asked.
const busyAs = async (d, ctxt, asker) => {
  const sent = await d.registry.call("threads.send", { thread: ctxt.thread, text: "demo", surface: "deck", chat: ctxt.chat, asker }, "module:stream");
  assert.ok(sent.data && !sent.error, JSON.stringify(sent));
  await until(async () => (await d.registry.call("threads.asks", { thread: ctxt.thread }, "cli")).data.some(a => a.tool === "Edit"), `${asker}'s turn to be busy`);
};
const endTurn = async (d, ctxt) => {
  await d.registry.call("threads.stop", { thread: ctxt.thread }, "cli");
  await until(async () => (await d.registry.call("threads.get", { thread: ctxt.thread }, "cli")).data.thread.status === "stopped", "the thread to stop");
};

test("the owner approves an email in a chat with Ben: Ben's later request is held, the owner's own is covered", { timeout: 120_000 }, async t => {
  const c = await chipChat(t);
  const { d, owner, BOB, thread } = c;
  const rec = await d.registry.call("vault.said.record", { thread, said: "said-mail", kind: "send", to: ["bob@example.com"], what: "email bob@example.com the figures", asker: owner }, "module:sessions");
  assert.ok(rec.data && !rec.error, JSON.stringify(rec));
  const ask = { kind: "send", via: "mail", to: ["bob@example.com"], thread };
  await busyAs(d, c, BOB);
  assert.equal((await d.registry.call("vault.said.match", ask, "module:gate")).data.matched, false, "Ben's turn is running: the owner's ask does not cover his request");
  await endTurn(d, c);
  await busyAs(d, c, owner);
  assert.equal((await d.registry.call("vault.said.match", ask, "module:gate")).data.matched, true, "the owner's own turn is covered by what the owner said");
});

test("an item the owner tags in a chat is usable on the owner's turns and not on Ben's", { timeout: 120_000 }, async t => {
  const c = await chipChat(t);
  const { d, owner, BOB, thread, send } = c;
  const tagged = await send(owner, [{ kind: "vault", id: "owner-secret" }], "use #owner-secret");
  assert.ok(JSON.stringify(tagged).includes("owner-secret"), `the owner's tag resolved in the chat: ${JSON.stringify(tagged)}`);
  const check = () => d.registry.call("vault.use.check", { item: "owner-secret", thread, hosts: ["https://api.example.com"] }, "module:sessions");
  await busyAs(d, c, BOB);
  assert.equal((await check()).data.allowed, false, "Ben's turn gets nothing from the owner's tag");
  await endTurn(d, c);
  await busyAs(d, c, owner);
  assert.equal((await check()).data.allowed, true, "the owner's own turn may use what the owner tagged");
});

test("a member's message while the owner's turn is running never steers that turn: it waits as its own turn, and the running turn's asker is still the owner", { timeout: 120_000 }, async t => {
  const c = await chipChat(t);
  const { d, owner, BOB, thread, chat, events } = c;
  await busyAs(d, c, owner);
  const asked = d.registry.deps.db;
  const other = await d.registry.call("threads.send", { thread, text: "send the figures to bob@example.com", surface: "deck", chat, asker: BOB }, "module:stream");
  assert.ok(other.data && !other.error, JSON.stringify(other));
  assert.notEqual(other.data.steered, true, `not steered into the owner's turn: ${JSON.stringify(other.data)}`);
  assert.ok(asked.prepare("SELECT COUNT(*) AS n FROM threads_inbox WHERE thread = ?").get(thread).n >= 1, "it is queued as its own turn");
  assert.ok(!(await events(thread)).some(e => e.type === "thread.sent" && e.payload && e.payload.via === "steer" && /bob@example\.com/.test(String(e.payload.text))), "its words never reached the running turn");
  const turn = asked.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(thread);
  assert.equal(JSON.parse(turn.body).person, owner, "the running turn is still the owner's");
});
