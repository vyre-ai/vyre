// @ts-check
// A running session on the stream (ADR 0052): a real vyred with the fake claude, a session started,
// a message steered into it, the socket killed mid-reply, and a resume from the cursor. The frames a
// client that was cut off holds must equal the frames of a client that never was, folded to the
// same transcript. Typed terminal commands and withdrawn queued messages ride in the same log.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import * as config from "../config/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { boot, until, FAKE } from "../sessions/testing/boot.js";
import { connect, wsDuplex } from "./client.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The box's stream route on a local port, the way the daemon's upgrade handler serves it. */
async function serve(t, w) {
  /** @type {Set<import("node:net").Socket>} */ const sockets = new Set();
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    const m = /^\/v1\/streams\/([a-z-]+)\/([a-z-]+)$/.exec(url.pathname);
    const u = m && w.d.registry.upgrades.get(`${m[1]}/${m[2]}`);
    if (!u) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    u.handler(req, socket, head, { caller: "cli", url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  t.after(() => { for (const k of sockets) k.destroy(); s.closeAllConnections(); s.close(); });
  return { port, kill: () => { for (const k of sockets) k.destroy(); }, count: () => sockets.size };
}

/** The chat a run is in (with the kernel on every run is in one, and the chat id is the way in to its stream); a daemon with no kernel has none, and the thread id stands. */
const chatOf = async (/** @type {any} */ w, /** @type {string} */ id) => { const t = (await w.tool("threads.get", { thread: id, limit: 1 })).data; return (t && t.thread && t.thread.chat) || id; };

/** A resumable client over the box: a fresh ticket per attempt, from its own cursor. */
function client(t, w, port, session) {
  /** @type {any[]} */ const frames = [];
  const c = connect({
    open: async ({ from }) => {
      const o = (await w.tool("stream.open", { chat: session, from })).data;
      return wsDuplex(`ws://127.0.0.1:${port}${o.path}`);
    },
    onFrame: f => frames.push(f),
    backoff: { base: 5, cap: 40 },
  });
  t.after(() => c.close());
  return { c, frames };
}

/** What a screen would show, folded from frames (no ids, no times). */
function fold(frames) {
  const text = new Map(), tools = new Map(), messages = new Map();
  const asks = [], commands = [];
  let status = null;
  for (const f of frames) {
    const d = f.data;
    switch (f.type) {
      case "chat.text-delta": if (!d.reasoning) text.set(d.message, (text.get(d.message) || "") + d.text); break;
      case "chat.tool-started": tools.set(d.tool_id, { tool: d.tool }); break;
      case "chat.tool-finished": tools.set(d.tool_id, { ...tools.get(d.tool_id), ok: d.ok, block: d.result.block }); break;
      case "chat.user-message": messages.set(d.message, { text: d.text || messages.get(d.message)?.text || "", state: d.state }); break;
      case "chat.ask": asks.push(d.ask_id); break;
      case "chat.term-command": commands.push(d.command); break;
      case "chat.status": status = d.state; break;
      default: break;
    }
  }
  return { text: [...text], tools: [...tools], messages: [...messages], asks, commands, status };
}


/** A vyred over a temp home with the fake claude, restartable, with the work folder allowed to the files guard (term opens there). */
async function own(t) {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false }, files: { roots: [work] }, term: { shell: "/bin/sh" } }));
  daemon = await start({ root, presence: present, log: () => {} });
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  const finished = id => until(async () => (await tool("threads.get", { thread: id, limit: 500 })).data.events.some(e => e.type === "thread.finished"), "the turn to finish");
  return { root, work, tool, finished, get d() { return daemon; }, restart: async () => { await daemon.stop(); daemon = await start({ root, presence: present, log: () => {} }); } };
}

test("live: a running session streams, a steer is queued then picked up, and a socket killed mid-reply resumes to the same transcript", async t => {
  const w = await boot(t);
  const { port, kill, count } = await serve(t, w);
  const id = (await w.tool("threads.start", { cwd: w.work, prompt: "demo", surface: "deck" })).data.id;
  const edit = await until(async () => (await w.tool("threads.asks", { thread: id })).data.find(a => a.tool === "Edit"), "the Edit ask");

  // The cut-off client attaches to the running session from the start of its log.
  const cut = client(t, w, port, await chatOf(w, id));
  await until(() => cut.frames.some(f => f.type === "chat.ask"), "the ask frame", 8000);
  assert.deepEqual(cut.frames.map(f => f.cur), cut.frames.map((_, i) => i + 1), "gapless from 1 while live");

  // Steer while the turn is blocked: a queued frame, then the socket dies before it is picked up.
  const steer = (await w.tool("threads.send", { thread: id, text: "use the rye price too", surface: "deck" })).data;
  assert.equal(steer.steered, true);
  await until(() => cut.frames.some(f => f.type === "chat.user-message" && f.data.state === "queued" && f.data.message === steer.uuid), "the queued frame");
  const before = cut.c.last;
  await until(() => count() >= 1, "a socket");
  kill();

  // While it is down: the person types in the terminal, the asks are answered, the reply streams.
  w.d.events.emit("term", "term.command", { term: "t1", session: id, command: "ls -la" }, { thread: id });
  await w.tool("threads.answer", { ask: edit.id, decision: "allow", surface: "deck" });
  const bash = await until(async () => (await w.tool("threads.asks", { thread: id })).data.find(a => a.tool === "Bash"), "the Bash ask");
  await w.tool("threads.answer", { ask: bash.id, decision: "allow", surface: "deck" });
  await w.finished(id);
  await until(async () => (await w.tool("stream.open", { chat: await chatOf(w, id) })).data.head === cut.c.last && cut.c.last > before, "the cut-off client to catch up", 8000);

  // A client that was never cut off reads the same log from the start.
  const whole = client(t, w, port, await chatOf(w, id));
  const head = (await w.tool("stream.open", { chat: await chatOf(w, id) })).data.head;
  await until(() => whole.c.last === head, "the uninterrupted client", 8000);
  assert.equal(cut.c.last, head);
  // A replay may merge a run of deltas into one frame (span), so the frames can differ in count; the
  // cursors they cover are 1..head with no gap and no repeat, and the folded transcript is equal.
  for (const frames of [cut.frames, whole.frames]) {
    let next = 1;
    for (const f of frames) { assert.equal(f.cur - (f.span || 1) + 1, next, "no gap, no repeat across the kill"); next = f.cur + 1; }
    assert.equal(next, head + 1);
  }

  const a = fold(cut.frames), b = fold(whole.frames);
  assert.deepEqual(a, b);
  assert.deepEqual(a.messages.find(([k]) => k === steer.uuid)?.[1], { text: "use the rye price too", state: "picked-up" });
  const states = cut.frames.filter(f => f.type === "chat.user-message" && f.data.message === steer.uuid).map(f => f.data.state);
  assert.deepEqual(states, ["queued", "picked-up"]);
  assert.deepEqual(a.commands, ["ls -la"], "what was typed in the terminal is in the session");
  assert.deepEqual(a.tools.map(([, v]) => v.tool).filter(Boolean).slice(0, 3), ["Read", "Edit", "Bash"]);
  assert.ok(a.tools.every(([, v]) => v.ok !== undefined), "every tool finished");
  assert.ok(a.text.some(([, v]) => /echo|rye/.test(v)) || a.text.length > 0, "the reply arrived");
  assert.equal(a.status, "waiting");
  console.log(`# live: ${head} frames, killed at cursor ${before}, resumed to ${cut.c.last}, equal to the uninterrupted client`);
});

test("live: a queued message taken back is a cancelled frame, and a stop says stopping on the stream", async t => {
  const w = await boot(t);
  const { port } = await serve(t, w);
  const id = (await w.tool("threads.start", { cwd: w.work, prompt: "demo", surface: "deck" })).data.id;
  await until(async () => (await w.tool("threads.asks", { thread: id })).data.find(a => a.tool === "Edit"), "the Edit ask");
  const live = client(t, w, port, await chatOf(w, id));
  const queued = (await w.tool("threads.send", { thread: id, text: "check the hours", surface: "deck", mode: "queue" })).data;
  assert.equal(queued.queued, true);
  await until(() => live.frames.some(f => f.type === "chat.user-message" && f.data.state === "queued"), "queued frame", 8000);
  await w.tool("threads.unqueue", { thread: id });
  await until(() => live.frames.some(f => f.type === "chat.user-message" && f.data.state === "cancelled"), "cancelled frame", 8000);
  const gone = live.frames.filter(f => f.type === "chat.user-message" && f.data.message === queued.uuid).map(f => f.data.state);
  assert.deepEqual(gone, ["queued", "cancelled"]);
  await w.tool("threads.stop", { thread: id });
  await until(() => live.frames.some(f => f.type === "chat.status" && f.data.stopping === true), "stopping status", 8000);
  await sleep(20);
  assert.equal(fold(live.frames).status, "stopped");
});

test("live: a session that began before the stream (an empty log) is seeded from its stored events when a screen opens it", async t => {
  const w = await own(t);
  const id = (await w.tool("threads.start", { cwd: w.work, prompt: "hello there", surface: "deck" })).data.id;
  await w.finished(id);
  await w.d.stop();
  // A vyred from before the stream existed: the thread and its events are there, the frames are not.
  const db = new DatabaseSync(config.paths(w.root).db);
  try { db.exec("DELETE FROM stream_frames"); } finally { db.close(); }
  await w.restart();
  const o = (await w.tool("stream.open", { chat: await chatOf(w, id), from: 0 })).data;
  assert.ok(o.head > 0, "the log was seeded");
  const { port } = await serve(t, w);
  const seen = client(t, w, port, await chatOf(w, id));
  await until(() => seen.c.last === o.head, "the seeded frames", 8000);
  const f = fold(seen.frames);
  assert.deepEqual(f.messages.map(([, v]) => v.text), ["hello there"]);
  assert.ok(f.text.some(([, v]) => /hello there/.test(v)), "its reply is there");
  assert.deepEqual(seen.frames.map(x => x.cur), seen.frames.map((_, i) => i + 1));
});

test("live: term.open for a session opens in the session's folder and a typed line reaches the session's stream", { skip: process.platform !== "linux" && "the pty runs on the box", todo: "term.open reads the thread as the caller (ctx.call as), which carries no person; it needs the person relay (RELAY_ALLOWED term to threads.get, windows' work/spaces) once trunk has it" }, async t => {
  const w = await own(t);
  const { port } = await serve(t, w);
  const id = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data.id;
  await w.finished(id);
  const live = client(t, w, port, await chatOf(w, id));
  const r = await w.tool("term.open", { session: id, surface: "deck:abc123" });
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(fs.realpathSync(r.data.cwd), fs.realpathSync(w.work));
  const ws = new WebSocket(`ws://127.0.0.1:${port}${r.data.path}`);
  t.after(async () => { try { ws.close(); } catch {} await w.tool("term.close", { term: r.data.term }); });
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("term socket")); });
  await sleep(300);
  ws.send(JSON.stringify({ t: "in", d: "echo " }));
  await sleep(200);
  ws.send(JSON.stringify({ t: "in", d: "typed-in-the-pane\r" }));
  await until(() => live.frames.some(f => f.type === "chat.term-command" && f.data.command === "echo typed-in-the-pane"), "the term-command frame", 8000);
});
