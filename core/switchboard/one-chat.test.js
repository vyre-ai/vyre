// One Chat (team/0.3/DESIGN-one-chat.md): every run lives in a chat. A start that names no chat (the CLI, a Flow, the assistant) gets one the daemon makes for the home owner; a run the stream
// starts for a chat keeps that chat; a resumed older thread with none gets one; the thread says which chat it is in.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, kernelCaller } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("every threads.start leaves a chat: its own for a plain start, the stream's for a chat's, one made on a resume for an older thread", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: m => { if (/no chat/.test(m)) console.log(m); }, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const grants = d.kernel.gateway.grants;
  const get = async id => (await d.registry.call("threads.get", { thread: id, limit: 5 }, "cli")).data.thread;

  // a plain start: a chat of the owner, made by the daemon, and the thread says which
  const plain = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "cli" }, "cli");
  assert.ok(plain.data, JSON.stringify(plain.error));
  const own = (await get(plain.data.id)).chat;
  assert.match(own, /^chat_/);
  assert.deepEqual([...grants.chats.read(ownerChain, own).people], [owner], "the chat is the owner's and nobody else's");
  const started = (await d.registry.call("threads.get", { thread: plain.data.id, limit: 50 }, "cli")).data.events.find(e => e.type === "thread.started");
  assert.equal(started.payload.chat, own, "thread.started says the chat");

  // two plain starts are two chats
  const second = await d.registry.call("threads.start", { cwd: work, prompt: "again", surface: "cli" }, "cli");
  assert.notEqual((await get(second.data.id)).chat, own);

  // the stream's start keeps the chat it names
  const chat = await grants.chats.create(ownerChain, {});
  const viaStream = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(viaStream.data, JSON.stringify(viaStream.error));
  assert.equal((await get(viaStream.data.id)).chat, chat.id);

  // a person's surface cannot name a chat: its own is made, not the named one
  const named = await d.registry.call("threads.start", { cwd: work, prompt: "x", surface: "cli", chat: chat.id, asker: owner }, "cli");
  assert.notEqual((await get(named.data.id)).chat, chat.id);

  // an older thread with no chat gets one when it is resumed
  d.registry.deps.db.prepare("UPDATE threads_runs SET chat = NULL WHERE id = ?").run(plain.data.id);
  await d.registry.call("threads.stop", { thread: plain.data.id }, "cli");
  await until(async () => ["stopped", "failed"].includes((await get(plain.data.id)).status), "stopped");
  const again = await d.registry.call("threads.send", { thread: plain.data.id, text: "back", surface: "cli" }, "cli");
  assert.ok(again.data, JSON.stringify(again.error));
  assert.match((await get(plain.data.id)).chat, /^chat_/);

  // an agent that runs in the Space is an actor of it (agents.create registers it, on the person's own call); its run's chat is the owner plus that agent, never an owner-only chat that drops it
  const made = await kernelCaller(d, root)("agents.create", { name: "kit", projects: "*" });
  assert.ok(made.data, JSON.stringify(made.error));
  const withKit = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "cli", agent: "kit" }, "cli");
  assert.ok(withKit.data, JSON.stringify(withKit.error));
  const kitChat = (await get(withKit.data.id)).chat;
  assert.match(kitChat, /^chat_/);
  assert.deepEqual([...grants.chats.read(ownerChain, kitChat).assistants], ["kit"], "the agent is in its chat");
  assert.deepEqual([...grants.chats.read(ownerChain, kitChat).people], [owner]);
});

test("the person's own assistant is never a listed participant: its chat is the person's, and its run still has a session in it", { timeout: 90_000 }, async t => {
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
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "cli", agent: "juno", agent_kind: "assistant" }, "cli");
  assert.ok(r.data, JSON.stringify(r.error));
  const chat = (await d.registry.call("threads.get", { thread: r.data.id, limit: 1 }, "cli")).data.thread.chat;
  assert.match(chat, /^chat_/);
  const c = d.kernel.gateway.grants.chats.read(ownerChain, chat);
  assert.deepEqual([...c.assistants], [], "the assistant is not in the chat's list");
  // its run holds a kernel session in that chat, as the assistant acting for the person
  const row = d.registry.deps.db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(r.data.id);
  assert.equal(JSON.parse(row.body).chat, chat);
  // a chat it is not asked into stays closed to it: the assistant reads only chats its person is in
  const other = d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: "per_stranger", agent: "assistant", session: "sx" });
  assert.throws(() => d.kernel.gateway.grants.chats.read(other, chat), { code: "not_found" });
  const mine = d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: owner, agent: "assistant", session: "sy" });
  assert.equal(d.kernel.gateway.grants.chats.read(mine, chat).id, chat, "acting for its person it reads the person's chat without being listed");
});

test("a terminal session's SessionStart leaves a chat of the person's, remembered by the session id and taken by an adopt", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const session = "7d1c1b0a-5e2f-4c3a-9b8d-0a1b2c3d4e5f";
  const brief = await d.registry.call("harness.brief", { session, cwd: work, source: "startup" }, "cli");
  assert.ok(!brief.error, JSON.stringify(brief.error));
  const row = await until(async () => d.registry.deps.db.prepare("SELECT chat FROM threads_terminal_chats WHERE session = ?").get(session), "the terminal session's chat");
  assert.match(row.chat, /^chat_/);
  assert.deepEqual([...d.kernel.gateway.grants.chats.read(ownerChain, row.chat).people], [owner]);
  // a second SessionStart for the same session (a resume) is the same chat
  await d.registry.call("harness.brief", { session, cwd: work, source: "resume" }, "cli");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(d.registry.deps.db.prepare("SELECT COUNT(*) AS n FROM threads_terminal_chats").get().n, 1);
});

test("a person's call on a run needs the person to be in its chat: a member outside the chat gets not_found on every threads tool, the owner and the person added to it do not", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const grants = d.kernel.gateway.grants;
  const BOB = "per_" + "b".repeat(26);
  await grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const bobChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const tokenOf = async chain => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "cli" }, "cli");
  assert.ok(r.data, JSON.stringify(r.error));
  const id = r.data.id;
  const chat = (await d.registry.call("threads.get", { thread: id, limit: 1 }, "cli")).data.thread.chat;
  for (const [tool, input] of [["threads.get", { thread: id, limit: 1 }], ["threads.send", { thread: id, text: "hi", surface: "cli" }], ["threads.rename", { thread: id, name: "x" }], ["threads.items", { thread: id }]]) {
    const res = await d.registry.call(tool, input, "cli", await tokenOf(bobChain));
    assert.equal(res.error && res.error.code, "not_found", `${tool} for a member outside the chat: ${JSON.stringify(res.error)}`);
  }
  const mine = await d.registry.call("threads.get", { thread: id, limit: 1 }, "cli", await tokenOf(ownerChain));
  assert.ok(mine.data && mine.data.thread.chat === chat, "the owner, who is in it, reads it");
  await grants.chats.change(ownerChain, chat, { add_people: [BOB] });
  const bobIn = await d.registry.call("threads.get", { thread: id, limit: 1 }, "cli", await tokenOf(bobChain));
  assert.ok(bobIn.data && bobIn.data.thread.id === id, `a person added to the chat reads it: ${JSON.stringify(bobIn.error)}`);
});


test("work.chat.*: create, change, list and get follow the kernel's chat read; a row shows what the engine knows only to people in the chat; chat-switch and chat-stop reach a slot only for them", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const grants = d.kernel.gateway.grants;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const BOB = "per_" + "b".repeat(26), CAROL = "per_" + "c".repeat(26);
  for (const [p, n] of [[BOB, 2], [CAROL, 3]]) await grants.setRole(ownerChain, { person: p, role: "member" }, { presence: { op: "x", fields: {}, n } });
  const as = async (person, id) => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person, path: "direct", session: `s-${id}` }), {})).token });
  const ownerCall = kernelCaller(d, root);
  const call = async (who, tool, input) => (who === "owner" ? ownerCall(tool, input) : d.registry.call(tool, input, "cli", who));
  const O = "owner", B = await as(BOB, "b"), C = await as(CAROL, "c");

  // making and changing a chat is a person acting directly (a paired device's own chain, as the app's calls arrive); a session token's chain is refused
  assert.equal((await call(B, "work.chat.create", { people: [owner] })).error.code, "chain_not_person");
  assert.equal((await call(O, "work.chat.create", { models: [{ provider: "codex", model: "x" }] })).error.code, "bad_input");
  const made = await call(O, "work.chat.create", { title: "Docket check", people: [BOB] });
  assert.ok(made.data, JSON.stringify(made.error));
  const chat = made.data.chat;
  assert.deepEqual([...made.data.people].sort(), [owner, BOB].sort());
  assert.equal((await call(O, "work.chat.list", {})).data.chats.find(r => r.chat === chat).title, "Docket check");
  const listed = async who => (await call(who, "work.chat.list", {})).data.chats.find(r => r.chat === chat);
  const mineRow = await listed(B);
  assert.deepEqual([mineRow.title, mineRow.open, mineRow.project_name], ["Docket check", true, "General"]);
  const outsider = await listed(C);
  assert.ok(outsider, "an admin or member sees that the chat exists");
  assert.equal(outsider.open, undefined, "but not that it is open to them");
  assert.ok(!("providers" in outsider) && !("last_line" in outsider), "and nothing the engine knows");
  assert.equal((await call(C, "work.chat.get", { chat })).error.code, "not_found");
  assert.equal((await call(C, "work.chat.rename", { chat, title: "mine now" })).error.code, "not_found", "a person outside cannot rename it");
  assert.equal((await call(O, "work.chat.get", { chat })).data.slots.length, 0);

  // a run in the chat: the providers and the last line show to the people in it
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", chat, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r.error));
  await until(async () => (await d.registry.call("threads.get", { thread: r.data.id, limit: 200 }, "cli")).data.events.some(e => e.type === "thread.finished"), "the turn");
  const row = await listed(O);
  assert.deepEqual(row.providers, ["claude"]);
  assert.match(row.last_line, /echo: hello/);
  const got = (await call(B, "work.chat.get", { chat })).data;
  assert.equal(got.slots.length, 1);
  assert.equal(got.slots[0].thread, r.data.id);
  assert.equal((await call(C, "threads.chat-switch", { chat, slot: got.slots[0].slot, model: "sonnet" })).error.code, "not_found");
  assert.equal((await call(C, "threads.chat-stop", { chat })).error.code, "not_found");
  const stopped = await call(B, "threads.chat-stop", { chat });
  assert.ok(stopped.data, JSON.stringify(stopped.error));
  // add carol: she reads it now
  assert.equal((await call(C, "work.chat.change", { chat, add_people: [CAROL] })).error.code, "chain_not_person");
  const added = await call(O, "work.chat.change", { chat, add_people: [CAROL] });
  assert.deepEqual([...added.data.people].sort(), [owner, BOB, CAROL].sort());
  assert.equal((await call(C, "work.chat.get", { chat })).data.open, true);
  assert.equal((await listed(C)).open, true);
});
