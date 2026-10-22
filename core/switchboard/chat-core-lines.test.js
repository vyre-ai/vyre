// @ts-check
// Checklist lines 1, 4, 5 and 6 together: one vyred, the real Switchboard, sessions, stream and recall.
// One test, in order, so the fakes on PATH are not clobbered by another test in this file.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, until } from "../sessions/testing/boot.js";
import { applyFakeSessionProvider } from "../sessions/testing/fake-agent-harness.js";
import { RECALL_LIVE_CONFIG, hookRecallTestEmbedder, recallFts5Available, indexCorpusTranscripts } from "../sessions/testing/recall-live.js";
import { createGroup } from "../../apps/app/src/chat/group.js";
import { serverFor } from "../../apps/app/src/real/server-route.js";
import { messageIndex } from "../../apps/app/src/chat/message-index.js";

const SHOWING = "spc_bbbbbbbbbbbb";

test("chat core: a send sits on your side at once, two paired servers follow the Space showing, Claude Codex and Grok stream, a switch keeps the earlier turns, a limit moves to the next signed-in account, and search finds a chat this app has not opened", { timeout: 240_000 }, async (t) => {
  assert.equal(createGroup("person:per_quince").isMine("o:1"), true, "a message being sent is on the sender's side before the server echoes it");
  assert.deepEqual(serverFor({
    tool: "work.agent.thread.new", input: { agent: "kit", id: "chat_unlisted" }, showing: SHOWING,
    spaceServers: { [SHOWING]: "srv-maple", spc_cccccccccccc: "srv-cedar" }, paired: ["srv-maple", "srv-cedar"], chatServers: {}, itemSpaces: {},
  }), { box: "srv-maple", space: SHOWING }, "an id never listed, with two servers paired, goes to the server of the Space showing");
  assert.deepEqual(serverFor({
    input: { chat: "chat_unlisted" }, showing: SHOWING,
    spaceServers: { [SHOWING]: "srv-maple" }, paired: ["srv-maple", "srv-cedar"], chatServers: {},
  }), { box: "srv-maple" }, "a chat not in the map uses the Space showing");

  assert.equal(recallFts5Available(), true, "recall needs FTS5");
  const prevDirect = process.env.VYRE_LEGACY_DIRECT_MODEL;
  process.env.VYRE_LEGACY_DIRECT_MODEL = "1";
  t.after(() => { if (prevDirect === undefined) delete process.env.VYRE_LEGACY_DIRECT_MODEL; else process.env.VYRE_LEGACY_DIRECT_MODEL = prevDirect; });
  hookRecallTestEmbedder(t);
  const w = await boot(t, { sessions: { auth: "setup-token" }, vault: { "claude-setup-token": "fake-setup-value" }, recall: RECALL_LIVE_CONFIG });
  applyFakeSessionProvider(t, w.root, "codex");
  const realCall = w.d.registry.call.bind(w.d.registry);
  w.d.registry.call = async (tool, input, caller, meta) => (tool === "memory.prompt" ? { data: { text: "", blocks: [] } } : realCall(tool, input, caller, meta));
  assert.equal(w.d.registry.tools.has("stream.search"), true);
  assert.equal(w.d.registry.tools.has("sessions.accounts.next"), true);
  const db = w.d.registry.deps.db;

  // Someone else's signed-in account is not the next one.
  const stranger = await w.tool("sessions.accounts.add", { provider: "codex", label: "Other Codex", kind: "login" });
  assert.equal(stranger.error, undefined, JSON.stringify(stranger.error));
  db.prepare("UPDATE sessions_accounts SET person = ?, signed_in_at = ? WHERE id = ?").run("per_stranger", Date.now(), stranger.data.id);
  const stuck = await w.tool("threads.start", { cwd: w.work, prompt: "limit", surface: "deck" });
  assert.equal(stuck.error, undefined, JSON.stringify(stuck.error));
  await w.finished(stuck.data.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await w.tool("threads.get", { thread: stuck.data.id })).data.thread.provider, "claude", "no signed-in account of the asker's own, so the turn stays");

  const mine = await w.tool("sessions.accounts.add", { provider: "codex", label: "Home Codex", kind: "login" });
  assert.equal(mine.error, undefined, JSON.stringify(mine.error));
  db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), mine.data.id);
  const limited = await w.tool("threads.start", { cwd: w.work, prompt: "limit", surface: "deck" });
  assert.equal(limited.error, undefined, JSON.stringify(limited.error));
  await until(async () => (await w.tool("threads.get", { thread: limited.data.id })).data.thread.provider === "codex", "the move to Codex", 40_000);
  await w.finished(limited.data.id, 2);
  const limitedRec = (await w.tool("threads.get", { thread: limited.data.id, limit: 500 })).data;
  assert.equal(limitedRec.thread.account, mine.data.id, "the turn moved to the asker's own Codex, not the other person's");
  const notices = limitedRec.events.filter((e) => e.type === "thread.text" && e.payload && e.payload.notice && /at its limit/.test(String(e.payload.text)));
  assert.deepEqual(notices.map((e) => e.payload.text), ["Claude is at its limit, so Codex answered."]);

  const grok = await w.tool("sessions.accounts.add", { provider: "grok", label: "Home Grok", kind: "login" });
  assert.equal(grok.error, undefined, JSON.stringify(grok.error));
  db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), grok.data.id);
  /** @type {[string, number][]} */ const speeds = [];
  for (const provider of ["claude", "codex", "grok"]) {
    const t0 = Date.now();
    const started = await w.tool("threads.start", { cwd: w.work, ...(provider === "claude" ? {} : { provider }), prompt: `hello from ${provider}`, surface: "deck" });
    assert.equal(started.error, undefined, `${provider} ${JSON.stringify(started.error)}`);
    await until(async () => (await w.events(started.data.id)).some((e) => e.type === "thread.text" && typeof e.payload.delta === "string" && e.payload.delta), `${provider} first words`, 20_000);
    speeds.push([provider, Date.now() - t0]);
  }
  assert.ok(speeds.every(([, ms]) => ms < 20_000), `first words, start included: ${JSON.stringify(speeds)}`);

  const sw = await w.tool("threads.start", { cwd: w.work, prompt: "plan the quincecake menu", surface: "deck" });
  assert.equal(sw.error, undefined, JSON.stringify(sw.error));
  await w.finished(sw.data.id);
  const moved = await w.tool("threads.switch", { thread: sw.data.id, provider: "grok", text: "now the glaze" });
  assert.equal(moved.error, undefined, JSON.stringify(moved.error));
  assert.equal(moved.data.thread, sw.data.id);
  await w.finished(sw.data.id, 2);
  const said = await w.said(sw.data.id);
  assert.match(said.at(-1), /^echo: \[Vyre continuation:/);
  assert.match(said.at(-1), /quincecake/, "the new model was handed the earlier turn");
  assert.match(said.at(-1), /now the glaze/);
  const swRec = (await w.tool("threads.get", { thread: sw.data.id })).data;
  assert.equal(swRec.thread.provider, "grok");
  assert.ok(swRec.events.some((e) => e.type === "thread.provider" && e.payload.from === "claude" && e.payload.to === "grok"));
  assert.ok(swRec.events.some((e) => e.type === "thread.text" && e.payload.notice && /^Switched to Grok\./.test(e.payload.text)));

  messageIndex.clear();
  assert.equal(messageIndex.size(), 0, "this app session has not opened a chat");
  await indexCorpusTranscripts(w.d);
  const recall = await until(async () => {
    const r = await w.tool("recall.search", { q: "quincecake", limit: 20 });
    return !r.error && JSON.stringify(r.data).includes("quincecake") ? r.data : null;
  }, "recall finding quincecake", 30_000);
  const found = await until(async () => {
    const r = await w.tool("stream.search", { q: "quincecake", limit: 20 });
    return !r.error && r.data && Array.isArray(r.data.hits) && r.data.hits.some((h) => String(h.snippet).toLowerCase().includes("quincecake")) ? r.data.hits : null;
  }, "stream.search finding quincecake", 20_000);
  const { findSource } = await import("../../apps/app/screens/find/source.ts");
  const { sectionsPlain, emptyBase } = await import("../../apps/app/screens/find/model.ts");
  /** @type {any} */ let viaFind = null;
  findSource((tool, input) => w.tool(tool, input), "deck").search("quincecake", {
    recall() {}, files() {}, memory() {}, mentions() {}, drive() {},
    chatMessages(r) { viaFind = r; },
  });
  await until(() => viaFind && Array.isArray(viaFind.data) && viaFind.data.some((h) => String(h.snippet).toLowerCase().includes("quincecake")), "Find asking stream.search", 20_000);
  const secs = sectionsPlain(emptyBase(), "quincecake", "all", { messages: viaFind.data, recall });
  assert.ok(secs.some((s) => s.key === "messages" && s.rows.some((row) => String(row.snippet || "").toLowerCase().includes("quincecake"))), JSON.stringify(secs.map((s) => s.key)));
  assert.ok(secs.some((s) => s.key === "chats" && s.rows.some((row) => String(row.session) === sw.data.id || String(row.snippet || "").toLowerCase().includes("quincecake"))));

  const enc = JSON.stringify({ type: "chat.text-delta", cur: 900001, session: sw.data.id, data: { message: "m-enc", text: "hiddenmarmalade", enc: { alg: "a", kid: "k", ct: "hiddenmarmalade" } } });
  db.prepare("INSERT INTO stream_frames (session, cur, first, json) VALUES (?,?,?,?)").run(sw.data.id, 900001, 900001, enc);
  const hidden = JSON.stringify({ type: "chat.text-delta", cur: 1, session: "not-a-chat", data: { message: "m-secret", text: "secretbramble" } });
  db.prepare("INSERT INTO stream_frames (session, cur, first, json) VALUES (?,?,?,?)").run("not-a-chat", 1, 1, hidden);
  for (const q of ["hiddenmarmalade", "secretbramble"]) {
    const r = await w.tool("stream.search", { q, limit: 20 });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.deepEqual(r.data.hits, [], q);
  }
  assert.ok(found.some((h) => String(h.snippet).toLowerCase().includes("quincecake")));
});
