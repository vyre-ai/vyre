// One Chat (team/0.3/DESIGN-one-chat.md): every run lives in a chat. A start that names no chat (the CLI, a Flow, the assistant) gets one the daemon makes for the home owner; a run the stream
// starts for a chat keeps that chat; a resumed older thread with none gets one; the thread says which chat it is in.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present, kernelCaller } from "../../test/helpers.js";
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
  asOwner(d, root);
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
  // a run with no agent is a model slot in its chat: its kernel session carries the slot id as its agent hop, never the assistant's
  const slot = d.registry.deps.db.prepare("SELECT slot FROM threads_runs WHERE id = ?").get(plain.data.id).slot;
  assert.match(slot, /^model:claude\/[^#]+#[0-9]{1,6}$/);
  assert.equal(JSON.parse(d.registry.deps.db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(plain.data.id).body).agent, slot);
  assert.deepEqual((await d.registry.call("threads.of-chat", { chat: own }, "module:work")).data.runs.map(r => r.slot), [slot]);
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
  // (until agents.create registers its actor itself, the owner adds it, with the kernel's own proof)
  await grants.addActor(ownerChain, { kind: "agent", id: "kit", space: d.kernel.id.space }, { presence: { op: "x", fields: {}, n: 1 } }).catch(() => {});
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
  asOwner(d, root);
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
  asOwner(d, root);
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
  asOwner(d, root);
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
  // it fails closed: no person chain (a call with no facts and no token), a chain that cannot be built (a bad token, an unenrolled device) and a non-person first hop are all not_found
  for (const [what, meta] of [["no facts and no token", {}], ["a token that does not verify", { token: "bad.token" }], ["a device that is not enrolled", { kernelFacts: { kind: "device", device_key_id: "dnotenrolled0000001", person: owner, path: "relay", session: "x" } }]]) {
    for (const [tool, input] of [["threads.get", { thread: id, limit: 1 }], ["threads.send", { thread: id, text: "x", surface: "cli" }], ["threads.interrupt", { thread: id }]]) {
      const res = await d.registry.call(tool, input, "cli", meta);
      assert.equal(res.error && res.error.code, "not_found", `${tool} with ${what}: ${JSON.stringify(res.error || res.data).slice(0, 120)}`);
    }
  }
  // a first-party module's own call is exempt (it checks its asker itself), and a thread in no chat is as before
  assert.ok((await d.registry.call("threads.get", { thread: id, limit: 1 }, "module:work")).data, "a first-party module reads it");
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
  asOwner(d, root);
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
  // the one chat id opens the stream: a chat nobody spoke in through the stream, with one run, is that run's log; a person outside it is refused; a thread id is no way in
  const opened = await call(O, "stream.open", { chat });
  assert.ok(opened.data, JSON.stringify(opened.error));
  assert.deepEqual([opened.data.chat, opened.data.session], [chat, r.data.id]);
  assert.equal((await call(C, "stream.open", { chat })).error.code, "not_found");
  assert.equal((await call(O, "stream.open", { chat: r.data.id })).error.code, "not_found", "a thread id is not a chat");
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

test("a chat started outside the stream continues in it: the existing run is adopted (no second run), its history is the chat's transcript, and a message sent in the chat goes to that run", { timeout: 120_000 }, async t => {
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
  const owner = kernelCaller(d, root);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "cli" }, "cli");
  assert.ok(r.data, JSON.stringify(r.error));
  await until(async () => (await d.registry.call("threads.get", { thread: r.data.id, limit: 200 }, "cli")).data.events.some(e => e.type === "thread.finished"), "the first turn");
  const chat = (await d.registry.call("threads.get", { thread: r.data.id, limit: 1 }, "cli")).data.thread.chat;
  const logs = d.registry.modules.get("stream").handle.logs;
  const texts = () => {
    const frames = logs.get(chat).read(0);
    return frames.filter(f => f.type === "chat.text-done").map(done => frames.filter(f => f.type === "chat.text-delta" && f.data.message === done.data.message && !f.data.reasoning).map(f => String(f.data.text)).join(""));
  };
  // before anyone speaks through the stream, the chat opens as the run's own log
  assert.equal((await owner("stream.open", { chat })).data.session, r.data.id);
  // a message sent in the chat: the run that is there answers; no second run starts
  const sent = await owner("stream.send", { chat, text: "and again" });
  assert.ok(sent.data, JSON.stringify(sent.error));
  await until(async () => texts().length >= 2, "the chat's transcript to hold both replies", 60_000);
  assert.deepEqual(texts(), ["echo: hello", "echo: and again"], "history first, then the new reply");
  const said = logs.get(chat).read(0).filter(f => f.type === "chat.user-message").map(f => String(f.data.text));
  assert.ok(said.includes("hello") && said.includes("and again"), JSON.stringify(said));
  assert.equal(((await d.registry.call("threads.of-chat", { chat }, "module:work")).data.runs || []).length, 1, "one run in the chat, not two");
  // and now the chat's own log is the transcript
  assert.equal((await owner("stream.open", { chat })).data.session, chat);
});

test("a new chat has no run until someone speaks in it: the first stream.send starts the default model slot in the chat's own folder, and a chat of several people starts nobody", { timeout: 120_000 }, async t => {
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
  const owner = kernelCaller(d, root);
  const made = await owner("work.chat.create", { title: "Fresh" });
  assert.ok(made.data, JSON.stringify(made.error));
  const chat = made.data.chat;
  assert.equal((await owner("work.chat.get", { chat })).data.slots.length, 0, "no run yet");
  const opened = await owner("stream.open", { chat });
  assert.ok(opened.data, JSON.stringify(opened.error));
  const logs = d.registry.modules.get("stream").handle.logs;
  const texts = () => { const fr = logs.get(chat).read(0); return fr.filter(f => f.type === "chat.text-done").map(done => fr.filter(f => f.type === "chat.text-delta" && f.data.message === done.data.message && !f.data.reasoning).map(f => String(f.data.text)).join("")); };
  const sent = await owner("stream.send", { chat, text: "hello there" });
  assert.ok(sent.data, JSON.stringify(sent.error));
  await until(async () => texts().length >= 1, "the first reply", 60_000);
  assert.deepEqual(texts(), ["echo: hello there"]);
  const got = (await owner("work.chat.get", { chat })).data;
  assert.equal(got.slots.length, 1, "one run, started by the first send");
  assert.ok(fs.existsSync(path.join(root, "chats", chat, "work")), "in the chat's own folder");
  const again = await owner("stream.send", { chat, text: "and more" });
  assert.ok(again.data, JSON.stringify(again.error));
  await until(async () => texts().length >= 2, "the second reply", 60_000);
  assert.equal((await owner("work.chat.get", { chat })).data.slots.length, 1, "still one run");
  // the chat's status follows its run: not "working" once the turn is over
  await until(async () => { const row = (await owner("work.chat.list", {})).data.chats.find(r => r.chat === chat); return row && row.status === "idle"; }, "the chat to be idle after the turn", 30_000);
  assert.ok(((await owner("work.chat.list", {})).data.chats.find(r => r.chat === chat) || {}).last_active, "and last active is kept");
});

test("a message sent in the chat while its run works joins the running turn (steer) by default, waits for the turn's end when asked to queue, and is never refused", { timeout: 120_000 }, async t => {
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
  const owner = kernelCaller(d, root);
  const chat = (await owner("work.chat.create", { title: "Busy" })).data.chat;
  // presence: what the slot is doing, and who is typing, are ephemeral frames on the chat's log
  const logs = d.registry.modules.get("stream").handle.logs;
  /** @type {any[]} */ const seen = [];
  const off = logs.get(chat).subscribe(f => { if (f.type === "chat.presence") seen.push(f.data); });
  t.after(off);
  assert.ok((await owner("stream.typing", { chat })).data);
  await until(async () => seen.some(p => p.state === "typing"), "the typing frame");
  assert.ok((await owner("stream.send", { chat, text: "demo" })).data);
  const thread = await until(async () => { const r = (await owner("work.chat.get", { chat })).data.slots[0]; return r && r.thread; }, "the run");
  await until(async () => seen.some(p => p.state === "doing" && p.who.startsWith("model:") && p.doing), "what the slot is doing");
  await until(async () => (await d.registry.call("threads.asks", { thread }, "cli")).data.some(a => a.state === "open"), "the turn to be busy");
  const events = async () => (await d.registry.call("threads.get", { thread, limit: 200 }, "cli")).data.events;
  // the default: the words join the running turn
  assert.ok((await owner("stream.send", { chat, text: "and also this" })).data);
  await until(async () => (await events()).some(e => e.type === "thread.sent" && e.payload.text === "and also this" && e.payload.via === "steer"), "the words to be steered into the turn");
  // queue: they wait, and can be taken back
  assert.ok((await owner("stream.send", { chat, text: "later please", mode: "queue" })).data);
  await until(async () => (await events()).some(e => e.type === "thread.queued" && e.payload.text === "later please"), "the words to be queued");
  // Stop through the chat: the busy slot's turn is interrupted, and the chat keeps taking messages
  const stopped = await owner("threads.chat-stop", { chat });
  assert.deepEqual(stopped.data && stopped.data.stopped, [thread], JSON.stringify(stopped.error));
  await until(async () => !(await d.registry.call("threads.asks", { thread }, "cli")).data.some(a => a.state === "open"), "the turn's open question to be cancelled");
  assert.equal((await owner("threads.chat-stop", { chat, slot: "model:claude/nonesuch#9" })).error.code, "not_found");
  await until(async () => seen.some(p => p.state === "idle" && p.who.startsWith("model:")), "the slot's line to clear when the turn ends");
  // a run step: the tool calls carry a step id, and one step-summary frame closes the step with plain counts
  const toolFrames = () => logs.get(chat).read(0).filter(f => f.type === "chat.tool-started");
  assert.ok(toolFrames().length >= 1 && toolFrames().every(f => typeof f.data.step === "string"), "tool frames name their step");
  const sum = await until(async () => logs.get(chat).read(0).find(f => f.type === "chat.step-summary" && f.data.step === toolFrames()[0].data.step), "the step to close with a summary");
  void sum;
  const closed = logs.get(chat).read(0).find(f => f.type === "chat.step-summary");
  assert.ok(closed.data.count >= 1 && typeof closed.data.summary === "string" && /^[A-Z]/.test(closed.data.summary) && closed.data.kinds && typeof closed.data.ok === "boolean", JSON.stringify(closed.data));
  // the returning view: what happened since the read marker, as plain facts; reading to the head empties it
  const back = (await owner("stream.catchup", { chat })).data;
  assert.equal(back.chat, chat);
  assert.ok(back.steps.some(x => x.step === closed.data.step && x.summary === closed.data.summary), JSON.stringify(back));
  assert.ok(back.since === 0 && back.head >= 1);
  assert.ok((await owner("stream.mark-read", { chat, upto: logs.get(chat).head })).data);
  const after = (await owner("stream.catchup", { chat })).data;
  assert.deepEqual([after.messages.length, after.steps.length, after.open_asks], [0, 0, 0], "nothing since the head");
});

test("a quoted reply stays in the chat's timeline: the frame carries reply_to and a short quote the box fills from the log, the model is told what it answers, and a message that is not in the chat is refused", { timeout: 120_000 }, async t => {
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
  const owner = kernelCaller(d, root);
  const chat = (await owner("work.chat.create", { title: "Quotes" })).data.chat;
  const logs = d.registry.modules.get("stream").handle.logs;
  const first = await owner("stream.send", { chat, text: "hello there" });
  assert.ok(first.data, JSON.stringify(first.error));
  await until(async () => logs.get(chat).read(0).some(f => f.type === "chat.text-done"), "the first reply", 60_000);
  const reply = logs.get(chat).read(0).find(f => f.type === "chat.text-done");
  assert.equal((await owner("stream.send", { chat, text: "and why?", reply_to: "nonesuch-message" })).error.code, "not_found");
  const sent = await owner("stream.send", { chat, text: "and why?", reply_to: reply.data.message });
  assert.ok(sent.data, JSON.stringify(sent.error));
  const frame = logs.get(chat).read(0).filter(f => f.type === "chat.user-message" && f.data.text === "and why?").pop();
  assert.equal(frame.data.reply_to, reply.data.message);
  assert.deepEqual(frame.data.quote, { message: reply.data.message, author: reply.author, text: "echo: hello there" });
  assert.match(reply.author, /^model:/);
  // the model got the quote as context; the person's own words stay as typed in the chat
  const thread = (await owner("work.chat.get", { chat })).data.slots[0].thread;
  await until(async () => (await d.registry.call("threads.get", { thread, limit: 200 }, "cli")).data.events.some(e => e.type === "thread.sent" && /Replying to .*: "echo: hello there"\s+and why\?/.test(String(e.payload.text))), "the run to be told what it answers", 30_000);
  // quoting a person's own message works too
  const mine = logs.get(chat).read(0).find(f => f.type === "chat.user-message" && f.data.text === "hello there");
  const again = await owner("stream.send", { chat, text: "I mean the first one", reply_to: mine.data.message });
  assert.ok(again.data, JSON.stringify(again.error));
  assert.equal(logs.get(chat).read(0).filter(f => f.type === "chat.user-message" && f.data.text === "I mean the first one").pop().data.quote.text, "hello there");
  // the sending device's time zone rides with the words: on the frame, on the run as the person's current zone, and on thread.sent; an unknown name is dropped, not stored
  assert.ok((await owner("stream.send", { chat, text: "what time is it?", tz: "Asia/Kuala_Lumpur" })).data);
  assert.equal(logs.get(chat).read(0).filter(f => f.type === "chat.user-message" && f.data.text === "what time is it?").pop().data.tz, "Asia/Kuala_Lumpur");
  await until(async () => (await d.registry.call("threads.get", { thread, limit: 200 }, "cli")).data.events.some(e => e.type === "thread.sent" && /what time is it/.test(String(e.payload.text)) && e.payload.tz === "Asia/Kuala_Lumpur"), "thread.sent to say the zone", 30_000);
  assert.equal((await d.registry.call("threads.get", { thread, limit: 1 }, "cli")).data.thread.tz, "Asia/Kuala_Lumpur");
  assert.ok((await owner("stream.send", { chat, text: "and now?", tz: "Mars/Olympus" })).data);
  assert.equal(logs.get(chat).read(0).filter(f => f.type === "chat.user-message" && f.data.text === "and now?").pop().data.tz, undefined);
  assert.equal((await d.registry.call("threads.get", { thread, limit: 1 }, "cli")).data.thread.tz, "Asia/Kuala_Lumpur", "the last good zone stays");
  // unread: the replies made after the person's read marker, on the list row; reading to the head clears it
  const unread = async () => ((await owner("work.chat.list", {})).data.chats.find(r => r.chat === chat) || {}).unread;
  await until(async () => (await unread()) >= 1, "the unread count to show a reply");
  const head = logs.get(chat).head;
  assert.ok((await owner("stream.mark-read", { chat, upto: head })).data);
  await until(async () => (await unread()) === 0, "the unread count to clear once read to the head");
});

test("a person outside a chat sees nothing of its runs through ANY threads tool: every tool that names a thread, an ask, a watch or a session says not_found, and the lists leave the run out", { timeout: 180_000 }, async t => {
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
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const BOB = "per_" + "b".repeat(26);
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const bob = { token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "s-b" }), {})).token };
  // a busy run in the owner's chat, with an open ask and a watch on it
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "demo", surface: "cli" }, "cli");
  assert.ok(r.data, JSON.stringify(r.error));
  const thread = r.data.id;
  const ask = await until(async () => (await d.registry.call("threads.asks", { thread }, "cli")).data.find(a => a.state === "open"), "an open ask");
  const watch = (await d.registry.call("threads.watch", { thread, until: "finished" }, "cli")).data;
  // the lists: the owner sees the run, bob sees nothing of it
  assert.ok((await d.registry.call("threads.list", {}, "cli")).data.some(x => x.id === thread), "the owner lists it");
  assert.deepEqual((await d.registry.call("threads.list", {}, "cli", bob)).data.filter(x => x.id === thread), [], "threads.list leaves it out for bob");
  assert.deepEqual((await d.registry.call("threads.asks", {}, "cli", bob)).data.filter(x => x.thread === thread), [], "threads.asks leaves its ask out for bob");
  assert.ok((await d.registry.call("threads.asks", {}, "cli")).data.some(x => x.thread === thread), "and the owner sees the ask");
  // every tool that names a thread, an ask, a watch or a session: not_found for bob, built from the tool's own schema
  const NOT_A_RUN = new Set(["threads.start", "threads.launch", "threads.quick", "threads.providers.learn", "threads.usage", "threads.history", "threads.live", "threads.list", "threads.asks", "threads.pids", "threads.vouch", "threads.contend", "threads.claimed", "threads.interrupt-in", "threads.busy", "threads.of-chat", "threads.chat-of", "threads.chat-switch", "threads.chat-stop", "threads.continue-here"]);
  const sample = (/** @type {string} */ k, /** @type {any} */ p) => (k === "thread" || k === "session" ? thread : k === "ask" ? ask.id : k === "watch" ? String(watch.watch || watch.id || "w") : p.enum ? p.enum[0] : p.type === "integer" ? 1 : p.type === "boolean" ? true : p.type === "array" ? [] : "x");
  /** @type {string[]} */ const walked = [];
  for (const [name, def] of d.registry.tools) {
    if (!name.startsWith("threads.") || NOT_A_RUN.has(name)) continue;
    const schema = (def && def.input) || {};
    const props = schema.properties || {};
    const want = Object.keys(props).filter(k => ["thread", "session", "ask", "watch"].includes(k));
    if (!want.length) continue;
    const input = Object.fromEntries((schema.required || []).map((/** @type {string} */ k) => [k, sample(k, props[k] || {})]));
    for (const k of want) input[k] = sample(k, props[k] || {});
    const res = await d.registry.call(name, input, "cli", bob);
    // a tool a person's surface cannot call at all (module-only) answers no_such_tool: it is not a way in
    assert.ok(res.error && (["not_found", "no_such_tool"].includes(res.error.code) || (res.error.code === "denied" && /not available to/.test(res.error.message))), `${name} for a member outside the chat: ${JSON.stringify(res.error || res.data).slice(0, 140)}`);
    if (res.error.code === "not_found") walked.push(name);
  }
  assert.ok(walked.length >= 20, `walked ${walked.length} tools: ${walked.join(", ")}`);
});

test("a chat's history leaves one device and comes back on another: its logged frames, its runs (stopped) and their events; a chat that already has its frames there is left as it is", { timeout: 150_000 }, async t => {
  async function boot() {
    const root = tempHome(t);
    const transcripts = path.join(root, "transcripts");
    Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
    fs.mkdirSync(transcripts);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
    const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
    asOwner(d, root);
    t.after(() => d.stop());
    return { d, root };
  }
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const A = await boot();
  const owner = kernelCaller(A.d, A.root);
  const chat = (await owner("work.chat.create", { title: "Moving" })).data.chat;
  assert.ok((await owner("stream.send", { chat, text: "hello there" })).data);
  const logsA = A.d.registry.modules.get("stream").handle.logs;
  await until(async () => logsA.get(chat).read(0).some(f => f.type === "chat.text-done"), "the reply", 60_000);
  await until(async () => (await A.d.registry.call("threads.export-chat", { chat }, "module:work")).data.events.some(e => e.type === "thread.finished"), "the turn to finish");
  const st = (await A.d.registry.call("stream.export-chat", { chat }, "module:work")).data;
  const th = (await A.d.registry.call("threads.export-chat", { chat }, "module:work")).data;
  assert.ok(st.frames.length >= 3 && st.members.length >= 1 && th.runs.length === 1 && th.events.length >= 5, JSON.stringify([st.frames.length, st.members.length, th.runs.length, th.events.length]));
  // not callable by a person's surface
  assert.ok((await A.d.registry.call("stream.export-chat", { chat }, "cli")).error, "module only");
  // the other device
  const B = await boot();
  const into = await B.d.registry.call("stream.import-chat", { chat, frames: st.frames, members: st.members }, "module:work");
  assert.ok(into.data && into.data.frames === st.frames.length, JSON.stringify(into));
  const back = await B.d.registry.call("threads.import-chat", { chat, runs: th.runs, events: th.events }, "module:work");
  assert.deepEqual([back.data.runs, back.data.events], [1, th.events.length]);
  const logsB = B.d.registry.modules.get("stream").handle.logs;
  const framesB = logsB.get(chat).read(0);
  assert.ok(framesB.some(f => f.type === "chat.user-message" && f.data.text === "hello there") && framesB.some(f => f.type === "chat.text-done"), "the conversation is there");
  const runB = (await B.d.registry.call("threads.get", { thread: th.runs[0].id, limit: 200 }, "module:work")).data;
  assert.equal(runB.thread.status, "stopped");
  assert.equal(runB.thread.chat, chat);
  assert.ok(runB.events.some(e => e.type === "thread.text"), "the run's events came with it");
  // again: left as it is
  const twice = await B.d.registry.call("stream.import-chat", { chat, frames: st.frames, members: st.members, fresh: true }, "module:work");
  assert.equal(twice.data.frames, 0);
  assert.equal((await B.d.registry.call("threads.import-chat", { chat, runs: th.runs, events: th.events }, "module:work")).data.runs, 0);
  // the tool the other end calls: it reads the chunks and the manifest the move carried in the chat's own folder, as the person, checks each, and puts it back in order; it carries on where it stopped
  const C = await boot();
  const cOwner = C.d.kernel.id.owner;
  const cChain = C.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: cOwner, path: "direct", session: "s1" });
  await C.d.kernel.gateway.grants.chats.create(cChain, { id: chat });
  const cCaller = kernelCaller(C.d, C.root);
  const rec = await until(async () => (await cCaller("work.chat.list", {})).data.chats.find(r => r.chat === chat), "the chat's record on the other device");
  const folder = `${rec.drive}/chat/${chat}`;
  const { writeHistory, chunkPath } = await import("../work/chat-upgrade.js");
  const wrote = await writeHistory({ drive: C.d.kernel.gateway.drive, chain: cChain }, folder, chat, { frames: st.frames, members: st.members, runs: th.runs, events: th.events }, 1500);
  assert.ok(wrote.chunks >= 4, `a small limit makes many chunks (${wrote.chunks})`);
  // a chunk that does not match its hash stops the import before anything after it is put back
  const bad = new TextEncoder().encode(JSON.stringify({ v: 1, chat, n: wrote.chunks, frames: [] }));
  const good = await C.d.kernel.gateway.drive.get(cChain, chunkPath(folder, wrote.chunks));
  await C.d.kernel.gateway.drive.put(cChain, chunkPath(folder, wrote.chunks), bad);
  const stopped = await cCaller("work.chat.history-import", { chat });
  assert.equal(stopped.error && stopped.error.code, "verify_failed", JSON.stringify(stopped));
  // put the real chunk back: it carries on from the chunk that failed, and the chunks before it are not put twice
  await C.d.kernel.gateway.drive.put(cChain, chunkPath(folder, wrote.chunks), good.bytes || good.data || good);
  const imported = await cCaller("work.chat.history-import", { chat });
  assert.ok(imported.data, JSON.stringify(imported.error));
  assert.equal(imported.data.chunks, 1, "only the chunk that failed was left to put back");
  const logsC = C.d.registry.modules.get("stream").handle.logs;
  assert.equal(logsC.get(chat).read(0).length, st.frames.length, "every frame is there, none twice");
  assert.ok(logsC.get(chat).read(0).some(f => f.type === "chat.text-done"));
  assert.equal((await C.d.registry.call("threads.get", { thread: th.runs[0].id, limit: 1000 }, "module:work")).data.events.length, th.events.length, "every event is there, none twice");
  assert.equal((await cCaller("work.chat.history-import", { chat })).data.chunks, 0, "nothing is put back twice");
  assert.equal((await cCaller("work.chat.history-import", { chat: "chat_nonesuch" })).error.code, "not_found");
});

test("moving chats to another Space and putting a history back are the person's own act: an assistant's or a model's session is refused, the person's own device or session is not", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s1" });
  const chat = (await d.kernel.gateway.grants.chats.create(chain, {})).id;
  const asAssistant = { token: (await d.kernel.surfaces.open(chain, { agent: "assistant" })).token };
  const asPerson = { token: (await d.kernel.surfaces.open(chain, {})).token };
  const asModel = { token: (await d.kernel.surfaces.open(chain, { chat, agent: "model:claude/opus#1", slot_open: true })).token };
  for (const [tool, input] of [["work.chat.upgrade-plan", { to: "spc_nonesuch0000" }], ["work.chat.upgrade-move", { to: "spc_nonesuch0000" }], ["work.chat.history-import", { chat }]]) {
    const agent = await d.registry.call(tool, input, "cli", asAssistant);
    assert.equal(agent.error && agent.error.code, "denied", `${tool} by an assistant session: ${JSON.stringify(agent.error || agent.data).slice(0, 120)}`);
    const model = await d.registry.call(tool, input, "cli", asModel);
    assert.equal(model.error && model.error.code, "denied", `${tool} by a model slot: ${JSON.stringify(model.error || model.data).slice(0, 120)}`);
    // a module that is not relaying a person has no person to act for
    const mod = await d.registry.call(tool, input, "module:work");
    assert.ok(mod.error && !mod.data, `${tool} by a module with no relayed person: ${JSON.stringify(mod.error || mod.data).slice(0, 120)}`);
    const person = await d.registry.call(tool, input, "cli", asPerson);
    assert.notEqual(person.error && person.error.code, "denied", `${tool} by the person's own session is let through to its own checks: ${JSON.stringify(person.error).slice(0, 120)}`);
  }
});
