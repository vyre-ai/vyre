// @ts-check
// The switchboard and agents, end to end: vyred in a temp home, a fake `claude` that speaks
// stream-json (./testing/fake-claude.js), two SSE clients watching, and every tool called the
// way a surface calls it. The real Claude Code run is recorded in team/archive/work-journals/switchboard.md.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import * as config from "../config/index.js";
import { tempHome, writeModule, present, kernelCaller, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { translate, describe } from "./translate.js";
import { argsFor } from "./runner.js";
import { Leases, TTL, ownSurface } from "./lease.js";
import { opensSession } from "./adopt.js";
import { open } from "../store/index.js";
import { MIGRATIONS, answerSummary, projectRules } from "./index.js";
import { Sessions, claudeCommand } from "./sessions.js";
import { migrate } from "../store/index.js";
process.env.VYRE_SESSION_SANDBOX_OFF = "1"; // a session in a temp home needs the development opt-out; with the kernel on it is otherwise confined by bwrap (the sandbox has its own tests)

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);

// 55 cases ran 367 s, past the 300 s per-file limit. They are dealt out to two files: this one, and
// switchboard-b.test.js, which sets VYRE_SWITCHBOARD_SHARD=1 and imports this module.
const SHARDS = 2;
const SHARD = Number(process.env.VYRE_SWITCHBOARD_SHARD ?? 0);
let dealt = 0;
const shardTest = (...a) => (dealt++ % SHARDS === SHARD ? test(...a) : undefined);

// ------------------------------------------------------------ pure parts

shardTest("translate: real stream-json lines become small thread events", () => {
  assert.deepEqual(translate({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-4-5" }), { events: [], session: "s1", model: "claude-haiku-4-5" });
  assert.equal(translate({ type: "system", subtype: "hook_response", output: "the user's own hook output" }).events.length, 0, "hook output never reaches an event");
  assert.equal(translate({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }).message, "m1");
  assert.equal(translate({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } }, parent_tool_use_id: null }).delta, "hel");
  assert.equal(translate({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "hel" } }, parent_tool_use_id: null }).block, 2, "a delta keeps its content block index");
  assert.equal(translate({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, parent_tool_use_id: "toolu_9" }).delta, undefined, "a subagent's text is not the thread's");
  const tool = translate({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/w/a.txt", content: "x".repeat(50000) } }] } });
  // call and status (ADR 0030): the row is keyed by call, id kept equal during the migration.
  assert.deepEqual(tool.events[0], { type: "thread.tool", payload: { id: "t1", call: "t1", tool: "Write", name: "Write", phase: "started", status: "running", block: 0,
    summary: "Write /w/a.txt", destination: "/w/a.txt", kind: "write", path: "/w/a.txt" } });
  // Kinds a card draws: Claude's tool names, an ACP provider's own kind when it said one, MCP by prefix, the rest "other".
  const kindOf = (name, input, hint) => translate({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "k", name, input, vyre_kind: hint }] } }).events[0].payload;
  assert.equal(kindOf("Bash", { command: "ls -la" }).command, "ls -la");
  assert.deepEqual(["Read", "MultiEdit", "Grep", "WebFetch", "WebSearch", "Task", "mcp__vyre__memory_ask", "Whatever"].map(n => kindOf(n, {}).kind), ["read", "edit", "search", "fetch", "fetch", "task", "mcp", "other"]);
  assert.equal(kindOf("Write", { path: "/w/gone.txt" }, "edit").kind, "edit", "ACP delete and move are edits");
  assert.equal(kindOf("Grep", { pattern: "menu", path: "/w" }).query, "menu");
  const plan = translate({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "p", name: "TodoWrite", input: { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "completed" }, { content: "c", status: "pending" }] } }] } });
  assert.deepEqual(plan.events[1].payload.items, [{ text: "a", status: "running" }, { text: "b", status: "done" }, { text: "c", status: "pending" }]);
  assert.deepEqual(translate({ type: "system", subtype: "vyre_plan", entries: [{ content: "x", status: "completed" }] }).events[0].payload.items, [{ text: "x", status: "done" }]);
  const ask = translate({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls -la" }, tool_use_id: "t2" } });
  assert.equal(ask.ask.summary, "ls -la");
  assert.equal(ask.ask.request_id, "r1");
  const fin = translate({ type: "result", is_error: false, result: "done", total_cost_usd: 0.01, stop_reason: "end_turn" });
  assert.equal(fin.events[0].type, "thread.finished");
  assert.equal(fin.events[0].payload.cost_usd, 0.01);
  assert.equal(translate({ type: "rate_limit_event", rate_limit_info: { status: "allowed", overageStatus: "rejected" } }).limited, undefined, "overage being off is not the limit");
  assert.equal(translate({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }).limited, true);
});

/**
 * translate as the Switchboard runs it: a whole line's text blocks keyed across the lines of one
 * message. Either translate(m, seen) counts them itself (work/chat), or it names the line's own
 * blocks (`blocks`) and the Switchboard adds the lines before (work/sessions, onMessage's ord).
 */
const keyed = () => {
  const seen = new Map(), ord = new Map();
  return (/** @type {any} */ m) => {
    const t = /** @type {any} */ (translate)(m, seen);
    if (typeof t.blocks === "number" && m && m.message && m.message.id) {
      const id = String(m.message.id), base = ord.get(id) || 0;
      for (const e of t.events) if (typeof e.payload.block === "number") e.payload.block += base;
      ord.set(id, base + t.blocks);
    }
    return t;
  };
};

shardTest("translate: text keys (message, block) count content blocks across the lines of one message, as the transcript does", () => {
  const fix = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "transcripts", "fixtures");
  const tr = keyed();
  let message = "";
  // Text keys are compared with text keys, reasoning with reasoning: a box that streams thinking
  // adds reasoning keys (thread.thinking, or thread.text kind "reasoning" on sessions 034c71e5),
  // never text ones.
  const done = [], partial = [], rdone = [], rpartial = [];
  for (const line of fs.readFileSync(path.join(fix, "split.stream.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const t = tr(JSON.parse(line));
    if (t.message !== undefined) message = t.message;
    if (t.delta) partial.push(`${message}#${t.block}`);
    if (t.reasoning) rpartial.push(`${message}#${t.block}`);
    for (const e of t.events) {
      if (e.type === "thread.thinking" || (e.type === "thread.text" && e.payload.kind === "reasoning")) rdone.push(`${e.payload.message}#${e.payload.block}`);
      else if (e.type === "thread.text") done.push(`${e.payload.message}#${e.payload.block}`);
    }
  }
  // msg_03A is thinking, text, tool_use, text (one line each); msg_03B is one text.
  const want = ["msg_03A#1", "msg_03A#3", "msg_03B#0"];
  assert.deepEqual(done, want);
  assert.deepEqual([...new Set(partial)], want);
  // Thinking, where the box streams it: msg_03A's block 0, its deltas and its whole, never a text key.
  if (rdone.length || rpartial.length) {
    assert.deepEqual(rdone, ["msg_03A#0"]);
    assert.deepEqual([...new Set(rpartial)], ["msg_03A#0"]);
  }
  for (const k of [...rdone, ...rpartial]) assert.ok(!want.includes(k), `reasoning ${k} shares a text key`);
  // The same keys the transcript read gives for the matching transcript (fixtures/split.jsonl).
  const tx = fs.readFileSync(path.join(fix, "split.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const counts = new Map(), keys = [];
  for (const o of tx) {
    if (o.type !== "assistant") continue;
    const n = counts.get(o.message.id) || 0;
    o.message.content.forEach((p, i) => { if (p.type === "text") keys.push(`${o.message.id}#${n + i}`); });
    counts.set(o.message.id, n + o.message.content.length);
  }
  assert.deepEqual(keys, want);
  // Without a shared count a line counts on its own, as before.
  assert.equal(translate({ type: "assistant", message: { id: "m9", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }).events[1].payload.block, 1);
});

shardTest("describe: a sending tool names where it goes", () => {
  assert.equal(describe("mcp__mail__send_message", { to: "dana@harlowlegal.com", body: "hi" }).destination, "dana@harlowlegal.com");
  assert.ok(describe("Bash", { command: "x".repeat(900) }).summary.length <= 200);
});

shardTest("argsFor: every session loads only Vyre's own MCP server, never the account's claude.ai connectors or any other server", () => {
  const cfg = a => JSON.parse(a[a.indexOf("--mcp-config") + 1]);
  const withPlugin = argsFor({ id: "u1", plugin: "/p" });
  assert.ok(withPlugin.includes("--strict-mcp-config"), "strict: nothing but --mcp-config is loaded (connectors, user and project servers, other plugins' servers)");
  assert.deepEqual(cfg(withPlugin), { mcpServers: { vyre: { command: "node", args: ["/p/mcp/run.js"] } } });
  for (const o of [{ id: "u2" }, { id: "u3", tools: "none" }, { id: "u4", plugin: null, resume: true }, { id: "u5", plugin: "/p", plugins: ["/learned"], settings: false }]) {
    const a = argsFor(o);
    assert.ok(a.includes("--strict-mcp-config"), JSON.stringify(o));
    assert.deepEqual(Object.keys(cfg(a).mcpServers), o.plugin ? ["vyre"] : [], JSON.stringify(o));
  }
});

shardTest("argsFor: the flags a headless session needs, new and resumed", () => {
  const a = argsFor({ id: "u1", plugin: "/p", model: "haiku", name: "Site copy" });
  for (const f of ["-p", "--input-format", "--output-format", "--include-partial-messages", "--verbose", "--permission-prompt-tool"]) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(a.indexOf("--session-id"), a.indexOf("--session-id") + 2), ["--session-id", "u1"]);
  assert.ok(a.includes("--plugin-dir") && a.includes("-n"));
  const r = argsFor({ id: "u1", resume: true, name: "Site copy", budgetUsd: 4.5 });
  assert.ok(r.includes("--resume") && !r.includes("--session-id") && !r.includes("-n"), "a resumed thread keeps its name");
  assert.deepEqual(r.slice(-2), ["--max-budget-usd", "4.50"]);
  const lean = argsFor({ id: "u1", tools: "none", settings: false });
  assert.ok(!lean.includes("--plugin-dir"));
  assert.deepEqual(lean.slice(lean.indexOf("--tools"), lean.indexOf("--tools") + 3), ["--tools", "", "--strict-mcp-config"]);
  assert.deepEqual(lean.slice(lean.indexOf("--setting-sources"), lean.indexOf("--setting-sources") + 2), ["--setting-sources", ""]);
});

shardTest("lease: one holder, take-over says who had it, quiet holders expire", t => {
  const root = tempHome(t);
  const db = open(path.join(root, "l.db"));
  migrate(db, "threads", MIGRATIONS);
  let now = 1_000_000;
  const L = new Leases(db, () => now);
  assert.deepEqual(L.typing("t", "deck"), { ok: true, took: { holder: "deck", previous: null, changed: true } });
  assert.deepEqual(L.typing("t", "cli"), { ok: false, holder: "deck" });
  assert.deepEqual(L.take("t", "deck"), { holder: "deck", previous: "deck", changed: false }, "re-taking your own lease is not a conflict");
  assert.equal(L.take("t", "cli").previous, "deck");
  now += TTL + 1;
  const r = L.take("t", "deck");
  assert.equal(r.previous, null);
  assert.equal(r.took.from, "cli", "taking a lapsed lease is recorded as a take-over");
  assert.deepEqual(L.release("t", "cli"), { released: false, holder: "deck" });
  assert.deepEqual(L.release("t", "deck"), { released: true, holder: null });
  db.close();
});

shardTest("adopt: only a claude given the session with --resume or --session-id has it open", () => {
  // A `vyre threads watch <id>` under a folder named claude-* was taken for a second writer, and
  // every resume after a stop was refused while it ran. Found by scripts/stress-drive.
  const id = "61801033-b22a-48c3-ba36-a9da797ca777";
  assert.equal(opensSession(`claude --resume ${id}`, id), true);
  assert.equal(opensSession(`node /opt/homebrew/bin/claude -p --resume ${id} --verbose`, id), true);
  assert.equal(opensSession(`claude --session-id=${id}`, id), true);
  assert.equal(opensSession(`claude -r ${id}`, id), true);
  assert.equal(opensSession(`node /tmp/claude-501/vyre/bin/vyre threads watch ${id}`, id), false, "a watch only reads");
  assert.equal(opensSession(`tail -f /Users/alex/.claude/projects/x/${id}.jsonl`, id), false, "nor does a reader of the transcript");
  assert.equal(opensSession(`claude --resume ${id}0`, id), false, "another id that starts with this one");
});

shardTest("lease: a terminal whose process exited holds nothing, so the next terminal can type", t => {
  // `vyre threads start` took the lease as cli:<pid> and exited; every later `vyre threads send`
  // (a new pid) was refused for the whole TTL. Found by scripts/stress-drive.
  const root = tempHome(t);
  const db = open(path.join(root, "l.db"));
  migrate(db, "threads", MIGRATIONS);
  const gone = new Set([4242]);
  const L = new Leases(db, () => 1_000_000, pid => !gone.has(pid));
  L.take("t", "cli:4242");
  assert.equal(L.holder("t"), null, "a dead cli pid is not a holder");
  const r = L.typing("t", "cli:5151");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.took && r.took.took && r.took.took.from, "cli:4242", "recorded as a take-over from the exited terminal");
  assert.deepEqual(L.typing("t", "cli:6161"), { ok: false, holder: "cli:5151" }, "a live terminal still holds it");
  L.take("t", "deck");
  assert.equal(L.holder("t")?.surface, "deck", "surfaces that are not cli:<pid> are untouched");
  db.close();
});

// ------------------------------------------------------------ end to end

/** An SSE client on vyred's socket, collecting every event. */
function sse(root, query = "type=*") {
  const got = [];
  let raw = "";
  const req = http.request({ socketPath: config.paths(root).socket, path: `/v1/events/stream?${query}` }, res => {
    res.setEncoding("utf8");
    res.on("data", c => {
      raw += c;
      let i;
      while ((i = raw.indexOf("\n\n")) >= 0) {
        const frame = raw.slice(0, i); raw = raw.slice(i + 2);
        const data = frame.split("\n").find(l => l.startsWith("data: "));
        if (data) got.push(JSON.parse(data.slice(6)));
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return { got, close: () => req.destroy() };
}

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise(r => setTimeout(r, 20));
  }
}

/**
 * A vyred in a temp home. `vault` is items to put in the real vault (name to a fake value), each
 * granted to module agents the way a person does it from the CLI, except those in `ungranted`.
 */
async function boot(t, { vault, ungranted = [], probe, modules = [] } = {}) {
  // A session in a temp home takes the development sandbox opt-out: with the kernel on it is confined by bwrap, which hides the fake claude's files and the home's socket.
  { const was = process.env.VYRE_SESSION_SANDBOX_OFF; process.env.VYRE_SESSION_SANDBOX_OFF = "1"; t.after(() => { if (was === undefined) delete process.env.VYRE_SESSION_SANDBOX_OFF; else process.env.VYRE_SESSION_SANDBOX_OFF = was; }); }
  // tempHome's own cleanup always runs first (after-hooks run in the order they were added), so
  // it needs a way to stop this in-process vyred before it removes the directory - otherwise a
  // real ENOTEMPTY race (found under the full suite at concurrency 4, 2026-09-28, in the sibling
  // sessions.test.js which has the same shape): the directory is removed while the daemon, or a
  // live child it started, is still writing into it. `daemon` is reassigned below, including by
  // the restart test's second start() - `stop()` always targets whichever is current.
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  const log = path.join(root, "claude.log");
  // This file speaks the CLI runner's own protocol to the fake (control_request/control_response
  // JSON lines) and has no driver-loop or skip logic, unlike core/sessions/sessions.test.js.
  // sessionsConfig() defaults to the SDK driver now (ADR 0030) and reads VYRE_SESSIONS_SDK_DIR
  // straight from the environment for its dir, so a shell that still has that var set from an
  // earlier SDK-driver test run silently flips every thread here onto the SDK driver too - the
  // fake never implements whatever the SDK expects, and every ask-handling test here fails in a
  // way that looks like flakiness but is really "the wrong driver was picked" (found 2026-09-28,
  // reproduced deterministically both with and without testbox under load). Pinned to "cli" so
  // this file's outcome never depends on what else is configured in the ambient shell.
  const env = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER };
  process.env.VYRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.VYRE_SESSIONS_DRIVER = "cli";
  t.after(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // Transcripts in the temp home, so adopting never looks at the user's own sessions; the file
  // keystore, so no test goes near the login keychain.
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", network: { owner: "owner@example" }, transcripts: [transcripts],
    ...(vault ? { vault: { keystore: "file" },
      // A Gate sender, so an agent's gate.request shows which thread vyred verified. Nothing is sent.
      gate: { senders: { mail: { type: "gmail", vault: "no-such-item", from: "alex@example.com" } } } } : {}) }));
  if (probe) {
    // Internal tools answer only modules: a module that asks threads.claimed for the test.
    writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.claimed"] } }, `
      export default { async start(ctx) {
        ctx.tool("probe.claimed", { input: { type: "object" }, run: async ({ session }) => (await ctx.call("threads.claimed", { session })).data });
        return { async stop() {} };
      } };`);
  }
  for (const m of modules) writeModule(path.join(root, "modules"), m.name, m.manifest, m.source);
  // The probe stands in for one of Vyre's own modules asking an internal tool, so with it the
  // home's modules load as first party (ADR 0047: an added module reaches only declared reach).
  const d = await start({ root, presence: present, log: () => {}, ...(probe ? { firstPartyRoots: [path.join(root, "modules")] } : {}) });
  asOwner(d, root); // calls from cli/deck arrive as the owner's device, as on the real socket (chat gate)
  daemon = d;
  // The work folder is outside the home: the security floor treats everything in VYRE_HOME as
  // Vyre's own state, as it does on a real machine. realpath: on the Mac the temp dir sits under
  // /var, which vyred and fake claude see as /private/var.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  for (const [name, value] of Object.entries(vault || {})) {
    const put = await tool("vault.put", { name, kind: name === "api-key" ? "api-key" : "secret", fields: { value } });
    assert.ok(put.data, `vault.put ${name}: ${put.error && put.error.message}`);
    if (ungranted.includes(name)) continue;
    assert.equal((await tool("vault.grant", { name, module: "agents" })).data.grant.status, "active");
  }
  // A test that replaces d (the restart test starts `again` in its place) calls this so
  // tempHome's stop() - which always runs first at teardown - targets the current one, not the
  // one it already stopped by hand.
  return { root, d, work, launches, tool, transcripts, setDaemon: nd => { daemon = nd; } };
}

/** A terminal session's transcript, as Claude Code leaves one: in a project folder, cwd on its lines. */
function terminalSession(transcripts, cwd, { ageMs = 120_000, id = crypto.randomUUID() } = {}) {
  const dir = path.join(transcripts, "-" + cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, [
    { type: "user", cwd, sessionId: id, message: { role: "user", content: "start the intake form" } },
    { type: "custom-title", customTitle: "Intake form", sessionId: id },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return { id, file };
}

const of = (events, thread, type) => events.filter(e => e.thread === thread && e.type === type);

shardTest("switchboard: a thread streams to two clients, asks, is answered, and changes hands", async t => {
  const w = await boot(t);
  const { root, work, tool, launches, d } = w;
  const a = sse(root), b = sse(root);
  t.after(() => { a.close(); b.close(); });

  const started = await tool("threads.start", { cwd: work, name: "Harlow copy", prompt: "hello there, this is a longer prompt", surface: "deck:1" });
  assert.equal(started.error, undefined, JSON.stringify(started.error));
  const id = started.data.id;
  assert.match(id, /^[0-9a-f-]{36}$/, "the thread id is the Claude Code session id");
  assert.equal(started.data.thread, id, ".thread is kept as an alias of the canonical .id for one release");
  assert.equal(started.data.holder, "deck:1", "the surface that starts a thread has its keyboard");
  await until(() => of(a.got, id, "thread.finished").length && of(b.got, id, "thread.finished").length, "both clients to see the turn end");

  for (const c of [a, b]) {
    const done = of(c.got, id, "thread.text").find(e => e.payload.done && e.payload.kind !== "reasoning");
    assert.equal(done.payload.text, "echo: hello there, this is a longer prompt");
    const deltas = of(c.got, id, "thread.text").filter(e => e.payload.delta && e.payload.kind !== "reasoning");
    assert.equal(deltas.map(e => e.payload.delta).join(""), done.payload.text, "the deltas add up to the text");
    assert.ok(deltas.length < Math.ceil(done.payload.text.length / 6), "partial text is throttled, not one event per chunk");
    assert.ok(deltas.every(e => e.payload.message === done.payload.message && e.payload.block === done.payload.block && done.payload.block === 0),
      "partial and whole text share one key (message, block)");
    assert.ok(of(c.got, id, "thread.started")[0].payload.headless);
  }
  assert.deepEqual(a.got.map(e => e.id), b.got.map(e => e.id), "both clients see the same thread");
  assert.ok(launches()[0].argv.includes("--session-id"));

  // A permission question, raised to every surface and kept as state.
  const target = path.join(work, "notes.txt");
  assert.deepEqual((await tool("threads.send", { thread: id, text: `write ${target}`, surface: "deck:1" })).data, { sent: true, thread: id });
  const raised = await until(() => of(b.got, id, "ask.raised")[0], "ask.raised");
  assert.equal(raised.payload.tool, "Write");
  assert.equal(raised.payload.destination, target);
  assert.equal(raised.payload.holder, "deck:1", "the ask says where the user is");
  assert.match(raised.payload.ask, /^[0-9a-f]{18}$/, "the ask id is a capability, not a counter");
  const open = (await tool("threads.asks", {})).data;
  assert.equal(open.length, 1);
  assert.equal(open[0].request_id, undefined, "Claude Code's request id stays inside vyred");
  assert.deepEqual(open[0].presence, { required: false, covered: false, since: null }, "answering takes no proof; a surface renders from this");
  const got = (await tool("threads.get", { thread: id })).data;
  assert.equal(got.thread.status, "waiting");
  assert.deepEqual(got.asks[0].presence, { required: false, covered: false, since: null });

  // A model never approves a permission: the loader refuses both MCP caller forms and hides the
  // tool. (An agent named without its thread's key is refused before that, listing included.)
  for (const who of ["mcp", "mcp:agent:juno"]) {
    const byModel = await tool("threads.answer", { ask: raised.payload.ask, decision: "allow" }, who);
    assert.equal(byModel.error.code, "denied", who);
  }
  const listed = (await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })).data.map(x => x.name);
  assert.ok(!listed.includes("threads.answer") && listed.includes("threads.get"), "mcp does not see threads.answer");
  assert.equal((await request("GET", "/v1/tools", undefined, { root, caller: "mcp:agent:juno" })).error.code, "denied");
  for (const who of ["deck", "capsule", "local"]) {
    assert.ok((await request("GET", "/v1/tools", undefined, { root, caller: who })).data.some(x => x.name === "threads.answer"), `${who} can answer`);
  }
  assert.equal(fs.existsSync(target), false);
  // A call vyred traced to this very thread never answers its own ask, even as a person's surface.
  const own = await w.d.registry.call("threads.answer", { ask: raised.payload.ask, decision: "allow" }, "cli", { thread: id });
  assert.equal(own.error?.code, "denied", JSON.stringify(own));
  assert.equal(fs.existsSync(target), false);

  const ans = await tool("threads.answer", { ask: raised.payload.ask, decision: "allow", surface: "capsule" });
  assert.deepEqual(ans.data, { ask: raised.payload.ask, answered: true, decision: "allow" });
  await until(() => of(a.got, id, "ask.answered")[0], "ask.answered");
  assert.equal(of(a.got, id, "ask.answered")[0].payload.by, "capsule");
  assert.equal(of(a.got, id, "ask.answered")[0].payload.tool, "Write", "what was allowed, as a learning signal");
  assert.equal(of(a.got, id, "ask.answered")[0].payload.summary, raised.payload.summary);
  await until(() => fs.existsSync(target), "the file the answer allowed");
  assert.deepEqual((await tool("threads.asks", { thread: id })).data, []);
  assert.equal((await tool("threads.answer", { ask: raised.payload.ask, decision: "deny" })).data.answered, false, "an answered ask stays answered");
  assert.deepEqual((await tool("threads.answer", { ask: raised.payload.ask, decision: "allow" })).data,
    { ask: raised.payload.ask, answered: true, decision: "allow", already: true }, "the same answer again is the earlier outcome (ADR 0029 R2)");

  // The lease: the other surface is read-only until it takes the keyboard.
  // A person's own surfaces (and their tailnet login) are one participant: none locks another out.
  assert.equal((await tool("threads.send", { thread: id, text: "from the phone, same person", surface: "phone" })).data.sent, true);
  // The owner over the tailnet (the verified label whose login is the recorded owner) is the person's Deck, not a participant of its own.
  // With the kernel on the owner's device is the facts the listener proves (a paired app row), not the label.
  d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES ('aaaaaaaaaaaaaaaa', 'phone', 'p', 1, 'app', 0, NULL)").run();
  const ownerFacts = { kind: "device", device_key_id: "aaaaaaaaaaaaaaaa", person: d.kernel.id.owner, path: "wink", session: "ps1" };
  const asOwner = (name, input) => d.registry.call(name, input, "tailnet:owner@example", { person: true, kernelFacts: ownerFacts, peer: { login: "owner@example", node: "phone", stableId: "aaaaaaaaaaaaaaaa" } });
  assert.equal((await asOwner("threads.send", { thread: id, text: "over the tailnet", surface: "whatever" })).data.sent, true);
  assert.equal((await asOwner("threads.lease", { thread: id })).data.holder, "phone");
  // Two different people: taking the keyboard really moves it, and the taker types at once; the owner is read-only until they take it back.
  const asBob = (name, input) => d.registry.call(name, input, "tailnet:bob@example", { person: true });
  assert.equal((await asBob("threads.send", { thread: id, text: "bob without the keyboard" })).data.sent, false, "another login contests the owner's keyboard");
  const took = (await asBob("threads.lease", { thread: id })).data;
  assert.deepEqual([took.holder, took.previous], ["tailnet:bob@example", "phone"], "the keyboard moved to the other person");
  assert.equal((await asBob("threads.send", { thread: id, text: "bob types at once" })).data.sent, true);
  const locked = (await asOwner("threads.send", { thread: id, text: "owner while bob has it" })).data;
  assert.deepEqual([locked.sent, locked.holder], [false, "tailnet:bob@example"]);
  assert.equal((await asOwner("threads.lease", { thread: id })).data.holder, "phone", "the owner takes it back");
  assert.equal((await asOwner("threads.send", { thread: id, text: "owner again" })).data.sent, true);
  await until(() => of(a.got, id, "thread.finished").length >= 3, "the turns before the lease checks go on");
  // A module (or any non-person caller) naming the holder's surface does not join it: a live terminal's name and the link's name each still contest.
  const asModule = (name, input) => d.registry.call(name, input, "module:planner");
  for (const held of [`cli:${process.pid}`, "box:x", "agent:kit"]) {
    assert.equal((await tool("threads.lease", { thread: id, surface: held })).data.holder, held, `the holder is ${held}`);
    const jr = await asModule("threads.send", { thread: id, text: `module naming ${held}`, surface: held }); const joined = jr.data || assert.fail(JSON.stringify(jr));
    assert.deepEqual([joined.sent, joined.holder], [false, held], `a module naming ${held} is refused while it holds the keyboard`);
  }
  assert.equal((await asOwner("threads.lease", { thread: id })).data.holder, "phone", "the owner takes it back");
  // A surface name in a call is not an identity: a person's socket caller saying "tailnet:owner@example" is just another label, which contests.
  assert.equal((await tool("threads.send", { thread: id, text: "claimed", surface: "tailnet:owner@example" })).data.sent, false);
  assert.equal((await tool("threads.send", { thread: id, text: "back on the deck", surface: "deck:1" })).data.sent, true);
  const refused = (await tool("threads.send", { thread: id, text: "from the phone", surface: "box:phone" })).data;
  assert.deepEqual(refused.sent, false);
  assert.equal(refused.holder, "deck:1");
  const moved = (await tool("threads.lease", { thread: id, surface: "box:phone" })).data;
  assert.equal(moved.previous, "deck:1");
  await until(() => of(a.got, id, "lease.changed").some(e => e.payload.holder === "box:phone" && e.payload.previous === "deck:1"), "lease.changed");
  assert.equal((await tool("threads.send", { thread: id, text: "typed on the deck", surface: "deck:1" })).data.holder, "box:phone");
  assert.equal((await tool("threads.send", { thread: id, text: "from the phone", surface: "box:phone" })).data.sent, true);
  await until(() => of(a.got, id, "thread.sent").some(e => e.payload.surface === "box:phone"), "thread.sent");

  // Stop, and a send brings it back with --resume under the same id.
  await until(() => of(a.got, id, "thread.finished").length >= 3, "the phone's turn");
  assert.equal((await tool("threads.stop", { thread: id })).data.stopped, true);
  await until(() => of(a.got, id, "thread.stopped")[0], "thread.stopped");
  assert.equal((await tool("threads.get", { thread: id })).data.thread.status, "stopped");
  assert.equal((await tool("threads.send", { thread: id, text: "still there?", surface: "box:phone" })).data.sent, true);
  await until(() => of(a.got, id, "thread.text").some(e => e.payload.text === "echo: still there?"), "the resumed reply");
  const last = launches().at(-1);
  assert.deepEqual(last.argv.slice(last.argv.indexOf("--resume"), last.argv.indexOf("--resume") + 2), ["--resume", id]);
});

shardTest("switchboard: a finished turn's partial text is pruned after the grace; the done text stays", async t => {
  const was = process.env.VYRE_TEXT_PRUNE_MS;
  process.env.VYRE_TEXT_PRUNE_MS = "1500"; // long enough that reading the deltas inside the grace is not a race with the log
  t.after(() => { if (was === undefined) delete process.env.VYRE_TEXT_PRUNE_MS; else process.env.VYRE_TEXT_PRUNE_MS = was; });
  const { root, work, tool } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "hello there, this is a longer prompt" })).data.id;
  await until(() => of(s.got, id, "thread.finished")[0], "the turn to end");
  const texts = async () => (await tool("threads.get", { thread: id, limit: 1000 })).data.events.filter(e => e.type === "thread.text");
  assert.ok((await texts()).some(e => e.payload.delta), "the deltas are there during the grace");
  await until(async () => !(await texts()).some(e => e.payload.delta), "the deltas to go");
  const done = (await texts()).filter(e => e.payload.done && e.payload.kind !== "reasoning");
  assert.deepEqual(done.map(e => e.payload.text), ["echo: hello there, this is a longer prompt"]);
  const got = (await tool("threads.get", { thread: id })).data;
  assert.equal(got.thread.turns, 1);
  assert.ok(got.events.some(e => e.type === "thread.finished") && got.events.some(e => e.type === "thread.started"));
});

shardTest("switchboard: a stopped thread's open question is closed, not left waiting", async t => {
  const { root, work, tool } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: `write ${path.join(work, "x.txt")}` })).data.id;
  const raised = await until(() => of(s.got, id, "ask.raised")[0], "ask.raised");
  await tool("threads.stop", { thread: id });
  await until(() => of(s.got, id, "ask.answered")[0], "the ask closing");
  assert.equal(of(s.got, id, "ask.answered")[0].payload.decision, "cancelled");
  assert.equal((await tool("threads.answer", { ask: raised.payload.ask, decision: "allow" })).data.answered, false);
});

shardTest("switchboard: a terminal resume of a live headless thread is warned about, never blocked", async t => {
  const { root, work, tool, d } = await boot(t);
  // threads.claimed is internal; a temp-home module is an added one under contract v1, so ask as vyred's own label.
  const claimed = session => d.registry.call("threads.claimed", { session }, "module:vyred");
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, surface: "deck:1" })).data.id;
  assert.equal((await tool("threads.claimed", { session: id })).error.code, "no_such_tool", "internal: modules only");
  // Past "starting", so the status cannot move between the two reads.
  const status = await until(async () => { const st = (await tool("threads.get", { thread: id })).data.thread.status; return st !== "starting" && st; }, "the thread to start");
  assert.deepEqual((await claimed(id)).data, { headless: true, holder: "deck:1", status });
  assert.equal((await claimed("not-a-thread")).data.headless, false);

  // Our own child's SessionStart (headless true) is not a second writer.
  const own = (await tool("harness.brief", { cwd: work, session: id, headless: true }, "harness")).data;
  assert.doesNotMatch(own.text, /running headless/);
  assert.equal(of(s.got, id, "thread.contended").length, 0);

  // A terminal `claude --resume <id>`: the brief warns and the switchboard says so to every surface.
  const term = (await tool("harness.brief", { cwd: work, session: id, headless: false }, "harness")).data;
  assert.match(term.text, /^(Time: [^\n]*\n\n)?Warning from Vyre: this conversation is also running headless under Vyre right now \(holder: deck:1\)/);
  assert.ok(term.text.includes(`vyre threads stop ${id.slice(0, 8)}`));
  const ev = await until(() => of(s.got, id, "thread.contended")[0], "thread.contended");
  assert.deepEqual(ev.payload, { thread: id, session: id, holder: "deck:1" });

  await tool("threads.stop", { thread: id });
  await until(() => of(s.got, id, "thread.stopped")[0], "thread.stopped");
  assert.equal((await claimed(id)).data.headless, false, "a stopped thread is nobody's writer");
  assert.doesNotMatch((await tool("harness.brief", { cwd: work, session: id, headless: false }, "harness")).data.text, /running headless/);
  assert.equal(of(s.got, id, "thread.contended").length, 1);
});

shardTest("switchboard: vyred restarting marks its threads stopped", async t => {
  const { root, work, tool, d, setDaemon } = await boot(t);
  const id = (await tool("threads.start", { cwd: work })).data.id;
  await d.stop();
  const again = await start({ root, presence: present, log: () => {} });
  asOwner(again, root); // calls from cli/deck arrive as the owner's device, as on the real socket (chat gate)
  setDaemon(again); // tempHome's teardown must stop THIS one now, not the d it already stopped
  const r = await call("threads.get", { thread: id }, { root });
  assert.equal(r.data.thread.status, "stopped");
  // ADR 0029 R7: the stop said why, so a surface shows "the box restarted", not a spinner.
  const stopped = again.events.since(0, { type: "thread.stopped", limit: 10 }).filter(e => e.thread === id);
  assert.deepEqual(stopped.map(e => e.payload.reason), ["restart"]);
  // Canonically it is "paused", not "stopped" or "failed": nothing is wrong, threads.send
  // resumes it - a person must never read a restart as a crash. Read both live (the event, so a
  // surface watching it in real time sees this without waiting for its next poll) and at rest.
  assert.equal(r.data.thread.canonical_status, "paused");
  const status = again.events.since(0, { type: "thread.status", limit: 10 }).filter(e => e.thread === id);
  assert.equal(status.at(-1).payload.status, "paused", "the restart's own thread.status, after whatever the original run said");
  // Resume reliability (task 1, measured on testbox): time to first token after a restart is
  // Vyre's own spawn/resume overhead against the fake claude, typically 200-300ms; 5s is a
  // generous ceiling that only trips on a real regression, not testbox load noise.
  const before0 = again.events.since(0, { type: "thread.text", limit: 100 }).filter(e => e.thread === id).length;
  const before = Date.now();
  await call("threads.send", { thread: id, text: "back after the restart" }, { root });
  await until(() => again.events.since(0, { type: "thread.text", limit: 100 }).filter(e => e.thread === id).length > before0, "the first token after a restart");
  assert.ok(Date.now() - before < 5000, `resuming after a restart took ${Date.now() - before}ms`);
});

shardTest("agents: the assistant and an agent on its own credentials, with the fallback and budget", async t => {
  const { root, tool, launches } = await boot(t, { vault: { "setup-token": "fake-setup-value", "api-key": "fake-api-value" } });
  const s = sse(root);
  t.after(() => s.close());

  assert.equal((await tool("agents.create", { name: "juno", kind: "assistant" })).data.projects, "*");
  assert.match((await tool("agents.create", { name: "juno2", kind: "assistant" })).error.message, /already an assistant/);
  await tool("agents.create", { name: "scout", projects: [], auth: { vault: "setup-token", fallback: "api-key", budget_usd: 1 }, instructions: "Research only." });

  const list = (await tool("agents.list", {})).data.filter(a => !a.builtin);
  assert.deepEqual(list.map(a => [a.name, a.kind, a.doing]), [["juno", "assistant", "not started"], ["scout", "agent", "not started"]]);
  assert.ok(list.every(a => "instructions" in a), "the Deck's agent page reads the job from the list");

  const who = (await tool("agents.ask", { agent: "scout", text: "whoami", surface: "capsule" })).data;
  assert.equal(who.text, "auth=subscription");
  assert.equal(launches().at(-1).auth, "subscription");
  assert.equal(launches().at(-1).agent, "scout");
  assert.ok(launches().at(-1).argv.includes("--append-system-prompt"));
  assert.equal((await tool("threads.get", { thread: who.thread })).data.thread.holder, null, "agents.ask gives the keyboard back");

  // The subscription runs out: the same thread carries on under the API key, and says so.
  const lim = (await tool("agents.ask", { agent: "scout", text: "limit", surface: "capsule" })).data;
  assert.equal(lim.thread, who.thread);
  await until(() => of(s.got, who.thread, "thread.text").some(e => e.payload.notice), "the fallback notice");
  await until(() => of(s.got, who.thread, "thread.text").some(e => e.payload.text === "echo: limit"), "the retried turn");
  assert.equal(launches().at(-1).auth, "api-key");
  assert.ok(launches().at(-1).argv.includes("--max-budget-usd"));

  const paid = (await tool("agents.ask", { agent: "scout", text: "whoami" })).data;
  assert.equal(paid.text, "auth=api-key");
  const ev = (await tool("threads.get", { thread: who.thread, limit: 1000 })).data.events;
  assert.ok(!JSON.stringify(ev).includes("fake-setup-value") && !JSON.stringify(ev).includes("fake-api-value"), "no credential reaches an event");

  // Only the assistant may drive sessions from inside its thread. Each call below is made from
  // inside the agent's own thread, as its MCP server makes it, with the key the thread was given.
  const inside = async (agent, call) => JSON.parse((await tool("agents.ask", { agent, text: `vyre ${call}` })).data.text);
  assert.match((await inside("scout", "threads.list {}")).error.message, /only the assistant/);
  assert.match((await inside("scout", 'agents.ask {"agent":"juno","text":"hi"}')).error.message, /only the assistant/);
  const hi = (await tool("agents.ask", { agent: "juno", text: "hi" })).data;
  assert.equal(hi.text, "echo: hi");
  assert.equal(launches().at(-1).auth, "ambient", "no auth configured means the machine's own login");
  assert.equal(launches().at(-1).projects, "*");
  assert.ok(Array.isArray((await inside("juno", "threads.list {}")).data));
  // A tool learns the thread vyred verified: juno's draft is filed under juno's own thread, and
  // naming scout's thread instead is refused.
  const junoThread = (await tool("agents.list", {})).data.find(a => a.name === "juno").thread;
  const draft = { kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "s", body: "b" } };
  assert.equal((await inside("juno", `gate.request ${JSON.stringify(draft)}`)).data.state, "held");
  const filed = (await tool("gate.held", {})).data.at(-1);
  assert.deepEqual([filed.thread, filed.agent], [junoThread, "juno"]);
  assert.match((await inside("juno", `gate.request ${JSON.stringify({ ...draft, thread: who.thread })}`)).error.message, /cannot file under/);
  assert.equal((await inside("juno", 'threads.answer {"ask":"a1","decision":"allow"}')).error.code, "denied", "not even the assistant answers a permission");
  // Naming an agent without its thread's key is refused outright, before any tool runs: nothing
  // outside juno's thread can pass for the assistant, and scout's key does not make it juno.
  assert.equal((await tool("threads.list", {}, "mcp:agent:juno")).error.code, "denied");
  assert.equal((await tool("memory.graph", {}, "mcp agent:juno")).error.code, "denied");
  assert.equal((await tool("harness.rules", { tool_name: "Read" }, "harness:agent:juno")).error.code, "denied");
  const was = process.env.VYRE_AGENT_KEY;
  process.env.VYRE_AGENT_KEY = "a-guess";
  try { assert.match((await tool("threads.list", {}, "mcp:agent:juno")).error.message, /no thread of that agent is running with this key/); }
  finally { if (was === undefined) delete process.env.VYRE_AGENT_KEY; else process.env.VYRE_AGENT_KEY = was; }
  assert.ok(!JSON.stringify(launches()).includes("VYRE_AGENT_KEY"));
  // (Forging a person's label from inside an agent's thread is the kernel's to refuse: a session's calls arrive on its own socket with the facts the daemon measured, and test/person-label-hygiene, the model-label and
  // kernel-turn tests hold that; the old "403 carries an agent's key" message was the label rule's.)

  assert.equal((await tool("agents.threads", { agent: "scout" })).data.length, 1);
  const stopped = (await tool("agents.stop", { agent: "scout" })).data;
  assert.deepEqual(stopped.stopped, [who.thread]);
  await until(() => of(s.got, who.thread, "thread.stopped")[0], "scout stopping");

  // Typing into an agent's stopped thread resumes it with the agent's own credentials.
  assert.equal((await tool("threads.send", { thread: who.thread, text: "whoami", surface: "deck:1" })).data.sent, true);
  await until(() => launches().at(-1).argv.includes("--resume") && launches().at(-1).agent === "scout", "the agent's resume");
});

shardTest("agents: an agent whose item is not granted to agents is refused, naming the grant to make", async t => {
  const { tool, launches } = await boot(t, { vault: { "setup-token": "fake-setup-value" }, ungranted: ["setup-token"] });
  await tool("agents.create", { name: "scout", projects: [], auth: { vault: "setup-token" } });
  const r = await tool("agents.ask", { agent: "scout", text: "whoami" });
  assert.equal(r.error.message, "scout cannot start: setup-token is not granted to agents · vyre vault grant setup-token agents");
  assert.equal(launches().length, 0, "nothing was launched without its credentials");
  // An agent asking for the grant from inside Claude only makes it pending; a person approves it.
  assert.equal((await tool("vault.grant", { name: "setup-token", module: "agents" }, "mcp")).data.grant.status, "pending");
  assert.match((await tool("agents.ask", { agent: "scout", text: "whoami" })).error.message, /not granted to agents/);
  assert.equal((await tool("vault.grant", { name: "setup-token", module: "agents" })).data.grant.status, "active");
  assert.equal((await tool("agents.ask", { agent: "scout", text: "whoami" })).data.text, "auth=subscription");
});

shardTest("agents: a subscription agent whose fallback key is not in the vault still starts, without the fallback", async t => {
  const { tool, launches } = await boot(t, { vault: { "setup-token": "fake-setup-value" } });
  await tool("agents.create", { name: "juno", kind: "assistant", auth: { vault: "setup-token", fallback: "api-key" } });
  const r = await tool("agents.ask", { agent: "juno", text: "whoami" });
  assert.equal(r.data?.text, "auth=subscription", JSON.stringify(r.error));
  assert.equal(launches().at(-1).auth, "subscription");
});

shardTest("agents: an API-key agent stops at its budget", async t => {
  const { tool } = await boot(t, { vault: { "api-key": "fake-api-value" } });
  await tool("agents.create", { name: "ledger", projects: [], auth: { fallback: "api-key", budget_usd: 0.2 } });
  const r = (await tool("agents.ask", { agent: "ledger", text: "whoami" })).data;
  assert.equal(r.text, "auth=api-key");
  await tool("agents.stop", { agent: "ledger" });
  await until(async () => (await tool("agents.list", {})).data.filter(a => !a.builtin)[0].status === "stopped", "ledger stopping");
  const again = await tool("agents.ask", { agent: "ledger", text: "whoami" });
  assert.match(again.error.message, /spent its \$0.2 budget/);
});

shardTest("switchboard: the presence summary of an answer says what is allowed, where, and in which thread", () => {
  const asks = { a1: { thread: "0f3c9a2e-1111", tool: "Write", summary: "write notes.md", destination: "/work/notes.md" } };
  const sb = /** @type {any} */ ({ asks: { get: id => asks[id] || null }, record: () => ({ name: "Intake" }) });
  assert.equal(answerSummary(sb, { ask: "a1", decision: "allow" }), "Allow Write to /work/notes.md: write notes.md (thread Intake)");
  assert.equal(answerSummary({ ...sb, record: () => null }, { ask: "a1", decision: "deny" }), "Deny Write to /work/notes.md: write notes.md (thread 0f3c9a2e)");
  assert.equal(answerSummary(sb, { ask: "zz", decision: "deny" }), "deny permission question zz");
});

shardTest("sessions: a session binds to a running claude once, its key is checked, and a gone process vouches for nothing", t => {
  const db = open(path.join(tempHome(t), "s.db"));
  migrate(db, "threads", MIGRATIONS);
  const up = new Set([100, 200, 300]);
  const sessions = new Sessions(db, { children: () => [300], isClaude: pid => pid === 100 || pid === 200, alive: pid => up.has(pid) });
  const id = "5f0c2a61-7d7e-4c43-9a57-0b6f3d0e9a11";
  assert.throws(() => sessions.bind(id, 999), /not a running claude/);
  assert.throws(() => sessions.bind("s1", 100), /not a session id/);
  const a = sessions.bind(id, 100);
  assert.equal(sessions.vouch(id, a.key), id);
  assert.equal(sessions.vouch(id, "a-guess"), null);
  assert.throws(() => sessions.bind(id, 200), /bound to another running process/, "another claude cannot take a live session");
  const again = sessions.bind(id, 100);
  assert.equal(sessions.vouch(id, a.key), null, "binding again replaces the key");
  assert.equal(sessions.vouch(id, again.key), id);
  assert.ok(sessions.bind("0b1d9c7e-0000-4000-8000-000000000000", 300).key, "a headless child of this Switchboard binds too");
  up.delete(100);
  assert.equal(sessions.vouch(id, again.key), null, "the process is gone");
  assert.ok(sessions.bind(id, 200).key, "a resumed session binds from its new process");
});

shardTest("adopt: a terminal session nobody has open is resumed headless with the lease; one that is open is refused to a model and queued for a person", async t => {
  const { tool, work, launches, transcripts, root } = await boot(t);
  const quiet = terminalSession(transcripts, work);
  const sent = (await tool("threads.send", { thread: quiet.id, text: "add a phone field", surface: "capsule" })).data;
  assert.equal(sent.sent, true, JSON.stringify(sent));
  const rec = (await tool("threads.get", { thread: quiet.id })).data.thread;
  assert.deepEqual([rec.cwd, rec.name, rec.holder], [work, "Intake form", "capsule"]);
  const launch = await until(() => launches().at(-1), "the launch");
  assert.ok(launch.argv.includes("--resume") && launch.argv.includes(quiet.id), "resumed, not started anew");
  await until(async () => (await tool("threads.get", { thread: quiet.id })).data.events.some(e => e.type === "thread.text" && e.payload.text === "echo: add a phone field"), "the reply");
  assert.equal((await tool("threads.send", { thread: quiet.id, text: "and a note", surface: "box:deck" })).data.holder, "capsule", "the lease holds");

  // Written a moment ago: someone is working in it.
  const busy = terminalSession(transcripts, work, { ageMs: 1000 });
  const r1 = (await tool("threads.send", { thread: busy.id, text: "hi", surface: "capsule" }, "mcp")).data;
  assert.equal(r1.sent, false);
  assert.equal(r1.open_elsewhere, true);
  assert.match(r1.note, /written \ds ago.*Only one keyboard/);
  // A one-turn ask on another provider is refused for it too, before anything is said.
  const ask = await tool("threads.send", { thread: busy.id, text: "hi", surface: "capsule", mentions: [{ kind: "account", id: "codex" }] }, "capsule");
  assert.equal(ask.error.code, "open_elsewhere", JSON.stringify(ask));
  assert.match(ask.error.message, /open somewhere else.*Nothing was sent, and the turn did not move to another provider\./);
  const q1 = (await tool("threads.send", { thread: busy.id, text: "hi", surface: "capsule" }, "capsule")).data;
  assert.deepEqual([q1.sent, q1.queued, q1.name, q1.note], [false, true, "Intake form", "Intake form is busy in your terminal. I'll hand it your message when this turn ends."]);

  // Open but idle in a terminal: a running claude names it (`claude --resume <id>`).
  const idle = terminalSession(transcripts, work);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "claude"));
  const { spawn } = await import("node:child_process");
  const term = spawn(path.join(bin, "claude"), ["-e", "setTimeout(() => {}, 60000)", "--", "--resume", idle.id], { stdio: "ignore" });
  t.after(() => term.kill());
  await new Promise(r => setTimeout(r, 200));
  const r2 = (await tool("threads.send", { thread: idle.id, text: "hi", surface: "capsule" }, "mcp")).data;
  assert.equal(r2.sent, false);
  assert.match(r2.note, new RegExp(`claude process ${term.pid} has it open`));
  assert.equal(launches().filter(l => l.argv.includes(idle.id) || l.argv.includes(busy.id)).length, 0, "nothing was started for either");

  // Bound by its SessionStart hook to a claude still running: open, even with no --resume.
  const bound = terminalSession(transcripts, work);
  const plain = spawn(path.join(bin, "claude"), ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => plain.kill());
  await new Promise(r => setTimeout(r, 200));
  assert.ok((await tool("threads.bind", { session: bound.id, pid: plain.pid }, "harness")).data.key);
  assert.match((await tool("threads.send", { thread: bound.id, text: "hi", surface: "capsule" }, "mcp")).data.note, new RegExp(`open in claude process ${plain.pid}`));

  assert.match((await tool("threads.send", { thread: crypto.randomUUID(), text: "hi" })).error.message, /no thread/);
});

shardTest("queued for a terminal session: the Stop hook hands it over, Claude answers in that session, and the reply comes back as the thread's", async t => {
  const { root, work, tool, launches, transcripts } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  // A fake session "busy in a terminal": its transcript was written a second ago. Nothing here
  // is a real Claude Code session; the hooks are called the way hook.js calls them.
  const busy = terminalSession(transcripts, work, { ageMs: 1000 });
  const q = (await tool("threads.send", { thread: busy.id, text: "which branch are you on?", surface: "capsule" }, "capsule")).data;
  assert.equal(q.queued, true);
  const queued = await until(() => of(s.got, busy.id, "thread.queued")[0], "thread.queued");
  assert.deepEqual([queued.payload.text, queued.payload.surface], ["which branch are you on?", "capsule"]);

  // The session's current turn ends: Stop sends it back to Claude with the message.
  const stop1 = (await tool("harness.stop", { session: busy.id, text: "Tests pass.", stop_hook_active: false }, "harness")).data;
  assert.deepEqual(stop1, { decision: "block", reason: "Message from the user via the Capsule: which branch are you on?" });
  const sent = await until(() => of(s.got, busy.id, "thread.sent")[0], "thread.sent at hand-over");
  assert.deepEqual([sent.payload.text, sent.payload.via, sent.payload.surface], ["which branch are you on?", "stop", "capsule"]);
  assert.equal(of(s.got, busy.id, "thread.text").length, 0, "the turn before is not the reply");

  // Claude answers it; the next Stop carries that answer and lets the session rest.
  const stop2 = (await tool("harness.stop", { session: busy.id, text: "On main.", stop_hook_active: true }, "harness")).data;
  assert.deepEqual(stop2, { ok: true });
  const reply = await until(() => of(s.got, busy.id, "thread.text")[0], "the reply");
  assert.deepEqual([reply.payload.text, reply.payload.done], ["On main.", true]);
  await until(() => of(s.got, busy.id, "thread.finished")[0], "thread.finished");
  assert.deepEqual((await tool("harness.stop", { session: busy.id, text: "later" }, "harness")).data, { ok: true }, "nothing more to hand over or reply to");
  assert.equal(of(s.got, busy.id, "thread.text").length, 1);

  // Idle in the terminal: the next prompt the user types there carries it.
  await tool("threads.send", { thread: busy.id, text: "also bump the version", surface: "capsule" }, "capsule");
  const enrich = (await tool("harness.enrich", { session: busy.id, prompt: "run the tests", cwd: work }, "harness")).data;
  assert.match(enrich.text, /^Message from the user via the Capsule: also bump the version\n\nThis was sent while the session was idle/);
  assert.deepEqual((await tool("harness.stop", { session: busy.id, text: "Bumped and tested." }, "harness")).data, { ok: true });
  await until(() => of(s.got, busy.id, "thread.text").some(e => e.payload.text === "Bumped and tested."), "the second reply");
  assert.equal(launches().filter(l => l.argv.includes(busy.id)).length, 0, "no process was started for it");
});

shardTest("threads.unqueue: a person takes back words not yet handed over; handed-over words stay; a model cannot", async t => {
  const { work, tool, transcripts } = await boot(t);
  const busy = terminalSession(transcripts, work, { ageMs: 1000 });
  const a = (await tool("threads.send", { thread: busy.id, text: "first", surface: "capsule" }, "capsule")).data;
  const b = (await tool("threads.send", { thread: busy.id, text: "second", surface: "capsule" }, "capsule")).data;
  assert.ok(Number.isInteger(a.queued_id) && b.queued_id > a.queued_id, JSON.stringify(b));
  assert.match((await tool("threads.unqueue", { thread: busy.id, queued: a.queued_id }, "mcp")).error.message, /only a person's surface|not available to mcp callers/);
  assert.deepEqual((await tool("threads.unqueue", { thread: busy.id, queued: a.queued_id }, "capsule")).data, { unqueued: [a.queued_id] });
  // Only "second" is handed over at the Stop.
  const stop = (await tool("harness.stop", { session: busy.id, text: "Done.", stop_hook_active: false }, "harness")).data;
  assert.equal(stop.reason, "Message from the user via the Capsule: second");
  const late = (await tool("threads.unqueue", { thread: busy.id, queued: b.queued_id }, "capsule")).data;
  assert.deepEqual(late.unqueued, []);
  assert.match(late.note, /already handed over/);
  // All of a thread's at once.
  await tool("threads.send", { thread: busy.id, text: "third", surface: "deck" }, "deck");
  await tool("threads.send", { thread: busy.id, text: "fourth", surface: "deck" }, "deck");
  assert.equal((await tool("threads.unqueue", { thread: busy.id }, "deck")).data.unqueued.length, 2);
  assert.match((await tool("threads.unqueue", { thread: busy.id }, "deck")).data.note, /Nothing is waiting/);
});

shardTest("threads.list: live is true for a session bound to a running claude that is not ours, and false once it exits", async t => {
  const { work, tool, transcripts, root } = await boot(t);
  const term = terminalSession(transcripts, work);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "claude"));
  const { spawn } = await import("node:child_process");
  const proc = spawn(path.join(bin, "claude"), ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => proc.kill());
  await new Promise(r => setTimeout(r, 200));
  assert.ok((await tool("threads.bind", { session: term.id, pid: proc.pid }, "harness")).data.key);
  // Queued for a person, which adopts its record, so threads.list has a row for it.
  assert.equal((await tool("threads.send", { thread: term.id, text: "hi", surface: "capsule" }, "capsule")).data.queued, true);
  const row = () => tool("threads.list", {}, "capsule").then(r => r.data.find(x => x.id === term.id));
  assert.equal((await row()).live, true);
  assert.deepEqual((await tool("threads.live", {}, "capsule")).error ? "internal" : "open", "internal", "threads.live is for modules only");
  proc.kill();
  await until(async () => (await row()).live === false, "live false after the terminal exits");
});

shardTest("agents.history: each question with its answer and thread, newest last, pageable, and only for the assistant or a person", async t => {
  const { tool } = await boot(t);
  await tool("agents.create", { name: "juno", kind: "assistant" });
  await tool("agents.create", { name: "scout", projects: [], computer: true });
  // agents.list says whether each may have a computer; core/computers decides on it.
  assert.deepEqual((await tool("agents.list", {})).data.filter(a => !a.builtin).map(a => [a.name, a.computer]), [["juno", false], ["scout", true]]);
  for (const [agent, text] of [["juno", "one"], ["scout", "two"], ["juno", "three"]]) {
    assert.equal((await tool("agents.ask", { agent, text, surface: "deck" }, "deck")).data.text, `echo: ${text}`);
  }
  const juno = (await tool("agents.history", { agent: "juno" })).data;
  assert.deepEqual(juno.map(x => [x.agent, x.text, x.answer, x.surface]), [["juno", "one", "echo: one", "deck"], ["juno", "three", "echo: three", "deck"]]);
  assert.ok(juno.every(x => x.thread && x.at && x.id), "each has its thread, time and id");
  const all = (await tool("agents.history", { limit: 2 })).data;
  assert.deepEqual(all.map(x => x.text), ["two", "three"], "the latest two, across agents");
  assert.deepEqual((await tool("agents.history", { before: all[0].id })).data.map(x => x.text), ["one"], "the page before");
  const inside = async (agent, call) => JSON.parse((await tool("agents.ask", { agent, text: `vyre ${call}` })).data.text);
  assert.match((await inside("scout", "agents.history {}")).error.message, /only the assistant/);
  assert.match((await tool("agents.history", { agent: "nobody" })).error.message, /no agent nobody/);
});

shardTest("lean and one-shot threads: no plugin, tools or settings, kept on resume; a job stops after its answer", async t => {
  const { d, tool, work, launches } = await boot(t);
  const lean = (await tool("threads.start", { cwd: work, prompt: "what is 2+2", lean: true, surface: "capsule" })).data;
  await until(async () => (await tool("threads.get", { thread: lean.id })).data.events.some(e => e.type === "thread.finished"), "the answer");
  const argv = (await until(() => launches().at(-1), "the launch")).argv;
  assert.ok(!argv.includes("--plugin-dir") && argv.includes("--strict-mcp-config") && argv[argv.indexOf("--tools") + 1] === "" && argv[argv.indexOf("--setting-sources") + 1] === "");
  await tool("threads.stop", { thread: lean.id });
  assert.equal((await tool("threads.send", { thread: lean.id, text: "and 3+3", surface: "capsule" })).data.sent, true);
  const again = (await until(() => launches().length === 2 && launches()[1], "the resume")).argv;
  assert.ok(again.includes("--resume") && !again.includes("--plugin-dir") && again.includes("--strict-mcp-config"), "a lean thread stays lean");

  // A job: Learning's shape. Internal, so only a module may launch one.
  assert.equal((await tool("threads.launch", { cwd: work, prompt: "x" })).error.code, "no_such_tool");
  const job = (await d.registry.call("threads.launch", { cwd: work, prompt: "distil this", plugin: false, tools: "none", once: true, model: "haiku" }, "module:learn")).data;
  assert.equal(job.thread, job.id, ".thread is kept as an alias of the canonical .id for one release");
  const stopped = await until(async () => (await tool("threads.get", { thread: job.id })).data.events.find(e => e.type === "thread.stopped"), "the job to stop");
  assert.equal(stopped.payload.reason, "done");
  const events = (await tool("threads.get", { thread: job.id })).data.events;
  assert.equal(events.find(e => e.type === "thread.text" && e.payload.done && e.payload.kind !== "reasoning").payload.text, "echo: distil this");
  const jobArgv = launches().at(-1).argv;
  assert.ok(!jobArgv.includes("--plugin-dir") && jobArgv.includes("--strict-mcp-config") && jobArgv[jobArgv.indexOf("--model") + 1] === "haiku");
});

shardTest("ADR 0041 (github, worked with sessions): a new thread in a GitHub project starts in its own worktree; github.session.cleanup runs once it is truly finished, never merely stopped", async t => {
  const worktree = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-worktree-")));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  // The real core/github is loaded on a box now, and a module name loads once, so the stand-in
  // answers through github's own registered tools instead of a second "github" module.
  const { d, tool, work } = await boot(t);
  const ghCalls = [];
  const stub = (name, run) => { const entry = d.registry.tools.get(name); assert.ok(entry, `core/github registers ${name}`); entry.run = run; };
  // Only "harlow-legal" is a GitHub project - "northwind" (below) is not, proving the no-repo
  // case changes nothing (the ordinary project-home cwd, no cleanup call at all).
  stub("github.project.of", async i => { ghCalls.push(["project.of", i]); return i.project === "harlow-legal" ? { account: "acme", full_name: "acme/harlow", default_branch: "main" } : null; });
  stub("github.session.worktree", async i => { ghCalls.push(["worktree", i]); return { path: worktree }; });
  stub("github.session.cleanup", async i => { ghCalls.push(["cleanup", i]); return { ok: true }; });
  const nwHome = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-nw-")));
  t.after(() => fs.rmSync(nwHome, { recursive: true, force: true }));
  assert.ok(!(await tool("projects.create", { name: "Harlow Legal", home: work })).error);
  assert.ok(!(await tool("projects.create", { name: "Northwind Bakery", home: nwHome })).error);

  // Start: a brand-new thread in the GitHub project gets the worktree's path as its cwd, not the
  // project's own home folder - where() asked github.project.of, then github.session.worktree,
  // with this thread's own id (the one and only thing github needs to key a worktree to it).
  const job = (await d.registry.call("threads.launch", { project: "harlow-legal", prompt: "x", plugin: false, tools: "none", once: true, model: "haiku" }, "module:learn")).data;
  const rec = (await tool("threads.get", { thread: job.id })).data.thread;
  assert.equal(rec.cwd, worktree, "the session's own cwd is the worktree github made, not Harlow's home");
  const calls = ghCalls;
  assert.deepEqual(calls[0], ["project.of", { project: "harlow-legal" }]);
  assert.deepEqual(calls[1], ["worktree", { project: "harlow-legal", session: job.id }]);

  // End: once the GitHub job is truly finished (never merely stopped - a job's own natural
  // completion, "done", is the one status a worktree is never needed again for), cleanup runs
  // with exactly this thread's own project and id. Proven FIRST, before the negative checks
  // below, so a false "never cleaned up" pass can never be a timing accident.
  await until(async () => ghCalls.some(c => c[0] === "cleanup"), "github.session.cleanup to run");
  const cleanup = ghCalls.find(c => c[0] === "cleanup");
  assert.deepEqual(cleanup[1], { project: "harlow-legal", session: job.id });

  // An ORDINARY session in the SAME GitHub project, stopped by a person: canonical "stopped", not
  // "finished" (threadStatus: only done/exited reasons read as finished) - resumable
  // (threads.send brings it back on the SAME cwd; launch()'s resume branch never calls where()
  // again), so cleaning its worktree up here would break that. Isolated from the job above by
  // checking no cleanup call names THIS session, not "no cleanup call at all".
  const ordinary = (await tool("threads.start", { project: "harlow-legal", prompt: "hello", surface: "deck" })).data;
  await until(async () => (await tool("threads.get", { thread: ordinary.id })).data.events.some(e => e.type === "thread.finished"), "the ordinary thread's first turn");
  await tool("threads.stop", { thread: ordinary.id });
  await new Promise(r => setTimeout(r, 300)); // give a (wrongly-firing) cleanup listener time to show up
  assert.ok(!ghCalls.some(c => c[0] === "cleanup" && c[1].session === ordinary.id), "stopped, not finished: never cleaned up");

  // A plain (non-GitHub) project's own thread is untouched too: its cwd is that project's own
  // home, and github.session.cleanup is never even asked for it once it finishes and stops.
  const plain = (await tool("threads.start", { project: "northwind-bakery", prompt: "hello", surface: "deck" })).data;
  assert.equal((await tool("threads.get", { thread: plain.id })).data.thread.cwd, nwHome);
  await until(async () => (await tool("threads.get", { thread: plain.id })).data.events.some(e => e.type === "thread.finished"), "the plain thread's answer");
  await tool("threads.stop", { thread: plain.id });
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!ghCalls.some(c => c[1] && c[1].session === plain.id), "no GitHub call at all for a non-GitHub project's thread");
});

shardTest("threads.watch: said once when the thread finishes or asks, always when it stops, and not for other agents", async t => {
  const { root, tool, work } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  const { id } = (await tool("threads.start", { cwd: work, prompt: "hello", surface: "deck" })).data;
  await until(async () => (await tool("threads.get", { thread: id })).data.events.some(e => e.type === "thread.finished"), "the first turn");

  const w = (await tool("threads.watch", { thread: id, until: "finished", notify: "capsule", note: "tell me when the intake is done" }, "capsule")).data;
  assert.match(w.watch, /^w[0-9a-f]{12}$/);
  await tool("threads.send", { thread: id, text: "build the intake", surface: "deck" });
  const fired = await until(() => of(s.got, id, "thread.watched")[0], "thread.watched");
  assert.deepEqual([fired.payload.watch, fired.payload.reason, fired.payload.notify, fired.payload.note, fired.payload.summary],
    [w.watch, "finished", "capsule", "tell me when the intake is done", "echo: build the intake"]);
  await tool("threads.send", { thread: id, text: "again", surface: "deck" });
  await until(() => of(s.got, id, "thread.finished").length >= 3, "the next turn");
  assert.equal(of(s.got, id, "thread.watched").length, 1, "once, then it clears itself");

  // Asks: fires on the question, with its summary.
  const asks = (await tool("threads.watch", { thread: id, until: "asks" })).data;
  await tool("threads.send", { thread: id, text: `write ${path.join(work, "n.txt")}`, surface: "deck" });
  const asked = await until(() => of(s.got, id, "thread.watched").find(e => e.payload.watch === asks.watch), "the ask watch");
  assert.equal(asked.payload.reason, "asked");
  assert.match(asked.payload.summary, /n\.txt/);

  // Unwatch, and a stopped thread ends every watch.
  const gone = (await tool("threads.watch", { thread: id })).data;
  assert.deepEqual((await tool("threads.unwatch", { watch: gone.watch })).data, { removed: true });
  const last = (await tool("threads.watch", { thread: id, until: "finished" })).data;
  await tool("threads.stop", { thread: id });
  const end = await until(() => of(s.got, id, "thread.watched").find(e => e.payload.watch === last.watch), "the stop");
  assert.equal(end.payload.reason, "stopped");
  assert.ok(!of(s.got, id, "thread.watched").some(e => e.payload.watch === gone.watch));
  assert.equal((await tool("threads.watch", { thread: id })).data.fired, true, "a stopped thread fires at once");
});

shardTest("usage and budget: turns, tokens and cost per agent; a warning at 80% and a stop at 100% on the API key", async t => {
  const { root, tool } = await boot(t, { vault: { "api-key": "fake-api-value" } });
  const s = sse(root);
  t.after(() => s.close());
  await tool("agents.create", { name: "scout", projects: [], auth: { fallback: "api-key", budget_usd: 1 } });
  const ask = async text => (await tool("agents.ask", { agent: "scout", text })).data;
  const first = await ask("spend 0.5");
  const thread = first.thread;
  const notices = () => of(s.got, thread, "thread.text").filter(e => e.payload.notice).map(e => e.payload.text);
  assert.deepEqual(notices(), [], "half the budget: nothing to say");
  await ask("spend 0.35");
  await until(() => notices().length === 1, "the 80% warning");
  assert.equal(notices()[0], "scout has spent $0.85 of its $1.00 API-key budget (85%).");
  await ask("spend 0.2");
  const stopped = await until(() => of(s.got, thread, "thread.stopped")[0], "the stop");
  assert.equal(stopped.payload.reason, "budget");
  assert.match(notices()[1], /^scout has spent \$1\.05 of its \$1\.00 API-key budget, so this thread has stopped\. To go on, raise it: vyre agents update scout --budget <dollars>$/);
  assert.match((await tool("agents.ask", { agent: "scout", text: "more" })).error.message, /spent its \$1 budget/);

  const [u] = (await tool("agents.usage", { agent: "scout" })).data;
  assert.equal(u.turns, 3);
  assert.equal(u.threads, 1);
  assert.equal(Number(u.api_cost_usd.toFixed(2)), 1.05);
  assert.equal(Number(u.spent_usd.toFixed(2)), 1.05);
  assert.equal(u.left_usd, 0);
  assert.deepEqual(u.tokens, { input: 30, output: "spent 0.5".length + "spent 0.35".length + "spent 0.2".length, cache_read: 300, cache_write: 150 });
  assert.equal(u.auth, "api-key");
  assert.equal(u.by_auth["api-key"].turns, 3);
  assert.equal((await tool("agents.usage", { agent: "scout", since: Date.now() + 60_000 })).data[0].turns, 0, "nothing since the future");
});

shardTest("usage on the subscription: turns and time, no dollars, and the rate-limit report said in the thread", async t => {
  const { root, tool } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  await tool("agents.create", { name: "juno", kind: "assistant" });
  const r = (await tool("agents.ask", { agent: "juno", text: "nearlimit" })).data;
  const limit = await until(() => of(s.got, r.thread, "thread.limit")[0], "thread.limit");
  const { turn, ...rest } = limit.payload;
  assert.equal(turn, `${r.thread}:1`, "every event of a turn says which turn (ADR 0030)");
  assert.deepEqual(rest, { thread: r.thread, status: "allowed_warning", kind: "five_hour", resets_at: 1790000000, utilization: 0.85 });
  const said = await until(() => of(s.got, r.thread, "thread.text").find(e => e.payload.notice), "the notice");
  assert.match(said.payload.text, /^Claude's five-hour usage limit is at 85%; it resets at \d\d:\d\d UTC\.$/);
  const all = (await tool("agents.usage", {})).data;
  const juno = all.find(x => x.agent === "juno");
  assert.equal(juno.turns, 1);
  assert.equal(juno.api_cost_usd, 0);
  assert.equal(juno.auth, "ambient");
  assert.equal(juno.limit.status, "allowed_warning");
  assert.ok(juno.duration_ms >= 5);
});

shardTest("rate limit: a warning under 80% is kept on the thread and not said in it", async t => {
  const { root, tool } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  await tool("agents.create", { name: "juno", kind: "assistant" });
  const r = (await tool("agents.ask", { agent: "juno", text: "lowlimit" })).data;
  const limit = await until(() => of(s.got, r.thread, "thread.limit")[0], "thread.limit");
  assert.equal(limit.payload.utilization, 0.27);
  await until(() => of(s.got, r.thread, "thread.finished")[0], "the turn");
  assert.deepEqual(of(s.got, r.thread, "thread.text").filter(e => e.payload.notice), [], "27% is not worth a line in the reply");
  assert.equal((await tool("agents.usage", {})).data.find(x => x.agent === "juno").limit.utilization, 0.27, "still recorded");
});

shardTest("learned skills: the account's and the project's folders load as plugins; lean threads and jobs get only what they name", async t => {
  const { d, root, tool, work, launches } = await boot(t);
  assert.ok(!(await tool("projects.create", { name: "Harlow", home: work })).error);
  const plugin = dir => { fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true }); fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: path.basename(dir) })); return dir; };
  const account = plugin(path.join(root, "learned", "account"));
  const harlow = plugin(path.join(root, "learned", "projects", "harlow"));
  fs.mkdirSync(path.join(root, "learned", "projects", "other"), { recursive: true });   // incomplete: never loaded
  const dirsOf = argv => argv.flatMap((a, i) => (a === "--plugin-dir" ? [argv[i + 1]] : []));

  await tool("threads.start", { project: "harlow", prompt: "hi", surface: "deck" });
  const full = dirsOf((await until(() => launches()[0], "a launch")).argv);
  assert.equal(full.length, 3);
  assert.deepEqual(full.slice(1), [account, harlow], "the Harness first, then the account's, then the project's");

  await tool("threads.start", { cwd: fs.mkdtempSync(path.join(root, "elsewhere-")), prompt: "hi", surface: "deck" });
  assert.deepEqual(dirsOf((await until(() => launches()[1], "a second launch")).argv).slice(1), [account], "outside the project: the account's only");

  await tool("threads.start", { project: "harlow", prompt: "2+2", lean: true, surface: "capsule" });
  assert.deepEqual(dirsOf((await until(() => launches()[2], "the lean launch")).argv), []);

  const own = plugin(path.join(root, "job-skills"));
  await d.registry.call("threads.launch", { cwd: work, prompt: "distil", plugin: false, tools: "none", once: true, plugins: [own] }, "module:learn");
  assert.deepEqual(dirsOf((await until(() => launches()[3], "the job")).argv), [own]);

  // An agent's own folder loads into its threads only.
  const scoutDir = plugin(path.join(root, "learned", "agents", "scout"));
  await kernelCaller(d, root)("agents.create", { name: "scout", projects: ["harlow"] });
  await tool("agents.ask", { agent: "scout", text: "hi" });
  assert.deepEqual(dirsOf((await until(() => launches()[4], "scout's launch")).argv).slice(1), [account, harlow, scoutDir]);
});

shardTest("agents: the assistant's brief says how to watch and drive threads for the user; an agent's does not", async () => {
  const { preamble } = await import("../agents/index.js");
  const brief = preamble({ name: "juno", kind: "assistant", projects: "*" });
  assert.match(brief, /threads_watch with \{thread, notify: "capsule", note: "<a short label>"\}/);
  assert.match(brief, /call threads_send, then set that watch/);
  assert.match(brief, /Do not poll threads_get/);
  assert.doesNotMatch(preamble({ name: "scout", kind: "agent", projects: ["harlow"] }), /threads_watch/);
});

shardTest("agents.delete: a person removes a stopped agent and its spend; never the assistant, a running one, or by a model", async t => {
  const { tool, d, root } = await boot(t);
  await tool("agents.create", { name: "juno", kind: "assistant" });
  await tool("agents.create", { name: "probe", projects: [] });
  await tool("agents.ask", { agent: "probe", text: "hi" });
  assert.match((await tool("agents.delete", { agent: "probe" })).error.message, /has 1 running thread; stop it first: vyre agents stop probe/);
  assert.equal((await tool("agents.delete", { agent: "probe" }, "mcp")).error.code, "denied", "a model never deletes an agent");
  assert.match((await tool("agents.delete", { agent: "juno" })).error.message, /is the assistant/);
  await tool("agents.stop", { agent: "probe" });
  // deleting takes back what the agent was given, a person's own act: a call that carries no person is refused and nothing is deleted
  assert.equal((await tool("agents.delete", { agent: "probe" }, "deck")).error?.code, "denied", "no person on the call");
  assert.deepEqual((await kernelCaller(d, root, "deck")("agents.delete", { agent: "probe" })).data, { agent: "probe", deleted: true });
  assert.deepEqual((await tool("agents.list", {})).data.filter(a => !a.builtin).map(a => a.name), ["juno"]);
  assert.match((await tool("agents.delete", { agent: "probe" })).error.message, /no agent probe/);
  assert.ok((await tool("agents.create", { name: "probe", projects: [] })).data, "the name is free again");
});

// ------------------------------------------------------------ questions and richer permission asks (ADR 0024)

shardTest("translate: an AskUserQuestion is a question, redacted and capped; any other tool is a permission with its detail", () => {
  const token = "ghp_" + "A1b2".repeat(9);
  const q = translate({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "t1",
    input: { questions: [
      { question: `Use the key ${token} for the Harlow Legal deploy?`, header: "Deploy", multiSelect: false,
        options: [{ label: "Yes", description: "d".repeat(3000), preview: "p".repeat(9000) }, ...Array.from({ length: 12 }, (_, i) => ({ label: `o${i}`, description: "" }))] },
      ...Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, header: "h", multiSelect: true, options: [] })),
    ] } } }).ask;
  assert.equal(q.kind, "question");
  assert.equal(q.questions.length, 4, "at most 4 questions");
  assert.equal(q.questions[0].options.length, 8, "at most 8 options");
  assert.ok(!q.questions[0].question.includes(token) && /GitHub token redacted/.test(q.questions[0].question), q.questions[0].question);
  assert.ok(!q.summary.includes(token), "nor in the summary");
  assert.equal(q.questions[0].options[0].description.length, 1000);
  assert.equal(q.questions[0].options[0].preview.length, 8000);
  assert.equal("preview" in q.questions[0].options[1], false, "no preview, no key");
  assert.equal(q.input.questions[0].question.includes(token), true, "the input Claude Code gets back is untouched (memory only)");

  const edit = translate({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Edit", tool_use_id: "t2",
    input: { file_path: "/w/menu.md", old_string: "a", new_string: `token=${token}` }, permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } }).ask;
  assert.equal(edit.kind, "permission");
  assert.equal(edit.detail.file, "/w/menu.md");
  assert.equal(edit.detail.old, "a");
  assert.ok(!edit.detail.new.includes(token));
  assert.deepEqual(edit.suggestions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  const bash = translate({ type: "control_request", request_id: "r3", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "x".repeat(9000), description: "Run it" } } }).ask;
  assert.equal(bash.detail.command.length, 8000);
  assert.equal(bash.detail.description, "Run it");
  assert.equal(bash.suggestions, null);
  const other = translate({ type: "control_request", request_id: "r4", request: { subtype: "can_use_tool", tool_name: "mcp__mail__send", input: { to: "kit@northwind.example", body: "hi" } } }).ask;
  assert.deepEqual(other.detail, { input: { to: "kit@northwind.example", body: "hi" } });
});

shardTest("switchboard: the presence summary of a question names the answers; always and decline say so", () => {
  const asks = {
    q1: { thread: "0f3c9a2e-1111", kind: "question", tool: "AskUserQuestion", summary: "Which palette?", destination: null,
      questions: [{ question: "Which palette?", header: "Palette" }, { question: "Which sections?", header: "Sections" }] },
    p1: { thread: "0f3c9a2e-1111", kind: "permission", tool: "Bash", summary: "npm test", destination: null },
  };
  const sb = /** @type {any} */ ({ asks: { get: id => asks[id] || null }, record: () => ({ name: "Menu" }) });
  assert.equal(answerSummary(sb, { ask: "q1", decision: "allow", answers: { "Which palette?": "Warm crust", "Which sections?": "Breads, Specials" } }),
    "Answer Palette: Warm crust; Answer Sections: Breads, Specials (thread Menu)");
  assert.equal(answerSummary(sb, { ask: "q1", decision: "deny" }), "Decline the question: Which palette? (thread Menu)");
  assert.equal(answerSummary(sb, { ask: "p1", decision: "always" }), "Always allow Bash: npm test (thread Menu)");
});

/** Each answer to a can_use_tool request the fake received, in order. */
function responses(t, root) {
  const file = path.join(root, "responses.log");
  const was = process.env.FAKE_CLAUDE_RESPONSES;
  process.env.FAKE_CLAUDE_RESPONSES = file;
  t.after(() => { if (was === undefined) delete process.env.FAKE_CLAUDE_RESPONSES; else process.env.FAKE_CLAUDE_RESPONSES = was; });
  return () => { try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
}

shardTest("switchboard: a question is raised small, read whole, answered (single and multi-select) and said back", async t => {
  const { root, work, tool } = await boot(t);
  const got = responses(t, root);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "ask", surface: "deck" })).data.id;
  const raised = await until(() => of(s.got, id, "ask.raised")[0], "ask.raised");
  assert.equal(raised.payload.kind, "question");
  assert.equal(raised.payload.tool, "AskUserQuestion");
  assert.equal(raised.payload.questions.length, 2);
  assert.equal(raised.payload.questions[0].options[0].label, "Warm crust");
  assert.ok(raised.payload.questions.every(q => q.options.every(o => !("preview" in o))), "previews stay out of the event");
  assert.equal(raised.payload.detail, undefined);

  const [ask] = (await tool("threads.asks", { thread: id })).data;
  assert.equal(ask.kind, "question");
  assert.equal(ask.always, false);
  assert.equal(ask.always_project, null);
  const call = of(s.got, id, "thread.tool").find(e => e.payload.tool === "AskUserQuestion");
  assert.deepEqual(ask.anchor, { tool_use_id: call.payload.id, event: raised.id }, "the ask points at its tool call and its ask.raised event");
  assert.equal(ask.agent, null);
  assert.equal(ask.thread_name, null);
  assert.deepEqual((await tool("threads.asks", { kind: "question" })).data.map(a => a.id), [ask.id]);
  assert.deepEqual((await tool("threads.asks", { kind: "permission" })).data, []);
  assert.equal((await tool("threads.get", { thread: id })).data.asks[0].request_id, undefined, "request_id stays inside vyred");
  assert.match(ask.questions[0].options[0].preview, /Northwind Bakery/, "the card reads previews from threads.asks");
  assert.equal(ask.questions[1].multiSelect, true);
  assert.deepEqual((await tool("threads.get", { thread: id })).data.asks[0].questions, ask.questions);

  const always = await tool("threads.answer", { ask: ask.id, decision: "always", surface: "deck" });
  assert.match(always.error.message, /always is for permissions/);
  assert.match((await tool("threads.answer", { ask: ask.id, decision: "allow", surface: "deck" })).error.message, /answers/);
  const bogus = await tool("threads.answer", { ask: ask.id, decision: "allow", answers: { "What time is it?": "noon" }, surface: "deck" });
  assert.match(bogus.error.message, /no question/);

  const answers = { [ask.questions[0].question]: "Warm crust", [ask.questions[1].question]: "Breads, Specials" };
  assert.deepEqual((await tool("threads.answer", { ask: ask.id, decision: "allow", answers, surface: "deck" })).data, { ask: ask.id, answered: true, decision: "allow" });
  const said = await until(() => of(s.got, id, "thread.text").find(e => e.payload.done && e.payload.kind !== "reasoning"), "the fake to say the answers");
  assert.equal(said.payload.text, `answers: ${JSON.stringify(answers)}`);
  const [r] = got();
  assert.equal(r.behavior, "allow");
  assert.deepEqual(r.updatedInput.answers, answers);
  assert.equal(r.updatedInput.questions.length, 2, "the questions go back with the answers");
  assert.equal(r.updatedPermissions, undefined);
  const answered = of(s.got, id, "ask.answered")[0];
  assert.deepEqual(answered.payload.answers, answers);
  assert.equal(answered.payload.decision, "allow");
});

shardTest("switchboard: a question can be declined", async t => {
  const { root, work, tool } = await boot(t);
  const got = responses(t, root);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "ask" })).data.id;
  const raised = await until(() => of(s.got, id, "ask.raised")[0], "ask.raised");
  assert.equal((await tool("threads.answer", { ask: raised.payload.ask, decision: "deny", message: "Not now." })).data.answered, true);
  const said = await until(() => of(s.got, id, "thread.text").find(e => e.payload.done && e.payload.kind !== "reasoning"), "the reply");
  assert.equal(said.payload.text, "You declined the question: Not now.");
  assert.equal(got()[0].behavior, "deny");
  assert.equal(of(s.got, id, "ask.answered")[0].payload.answers, undefined);
});

shardTest("plan: the fake's ExitPlanMode ask carries the plan in its detail; allow starts building, deny keeps planning with the note", async t => {
  const { root, work, tool } = await boot(t);
  const got = responses(t, root);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "plan", surface: "deck" })).data.id;
  const a = await until(async () => (await tool("threads.asks", { thread: id })).data[0], "the plan ask");
  assert.equal(a.tool, "ExitPlanMode");
  assert.match(a.detail.input.plan, /^# Update the Northwind Bakery price list/);
  assert.equal((await tool("threads.answer", { ask: a.id, decision: "deny", message: "Change the plan: tests first" })).data.answered, true);
  const said = await until(() => of(s.got, id, "thread.text").find(e => e.payload.done && e.payload.kind !== "reasoning"), "the reply");
  assert.equal(said.payload.text, "I'll keep planning: Change the plan: tests first");
  assert.equal(got()[0].behavior, "deny");
  const id2 = (await tool("threads.start", { cwd: work, prompt: "plan", surface: "deck" })).data.id;
  const b = await until(async () => (await tool("threads.asks", { thread: id2 })).data[0], "the second plan ask");
  await tool("threads.answer", { ask: b.id, decision: "allow" });
  const said2 = await until(() => of(s.got, id2, "thread.text").find(e => e.payload.done && e.payload.kind !== "reasoning"), "the reply");
  assert.equal(said2.payload.text, "Starting on the plan: the price list first.");
});

shardTest("items: a thread is its tool kinds, its plan and its words, oldest first, from stored events, with a since cursor and the caps it started with", async t => {
  const { work, tool, root } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "demo", surface: "deck" })).data.id;
  for (const name of ["Edit", "Bash"]) {
    const a = await until(async () => (await tool("threads.asks", { thread: id })).data.find(x => x.tool === name), `the ${name} ask`);
    await tool("threads.answer", { ask: a.id, decision: "allow", surface: "deck" });
  }
  await until(() => of(s.got, id, "thread.text").find(e => e.payload.done), "the reply");
  const plan = of(s.got, id, "thread.plan");
  assert.equal(plan.length, 1, "TodoWrite is one plan event with the whole list");
  assert.ok(plan[0].payload.items.every(x => typeof x.text === "string" && ["pending", "running", "done"].includes(x.status)), JSON.stringify(plan[0].payload));
  const started = of(s.got, id, "thread.tool").filter(e => e.payload.phase === "started");
  assert.deepEqual(started.map(e => e.payload.kind), ["read", "edit", "run", "other"]);
  assert.equal(started[2].payload.command, "npm test");
  assert.equal(started[1].payload.path, path.join(work, "menu.md"));
  assert.ok(started.every(e => e.payload.provider === "claude"));

  const all = (await tool("threads.items", { thread: id })).data;
  assert.equal(all.next, null);
  assert.deepEqual([all.items[0].kind, all.items.at(-1).kind], ["person", "assistant"]);
  assert.ok(all.items.some(x => x.kind === "plan"));
  assert.equal(all.items[0].text, "demo");
  const tools = all.items.filter(x => x.kind === "tool");
  assert.deepEqual(tools.map(x => x.tool.kind), ["read", "edit", "run", "other"]);
  assert.ok(tools.every(x => x.tool.status === "completed" || x.tool.status === "running" || x.tool.status === "failed"));
  assert.ok(all.items.every((x, n) => n === 0 || x.id > all.items[n - 1].id), "oldest first");
  const page = (await tool("threads.items", { thread: id, limit: 2 })).data;
  assert.equal(page.items.length, 2);
  assert.equal(page.next, page.items[1].id);
  const rest = (await tool("threads.items", { thread: id, since: page.next })).data;
  assert.deepEqual([...page.items, ...rest.items].map(x => x.id), all.items.map(x => x.id));
  assert.ok((await tool("threads.get", { thread: id })).data.thread.caps.resume, "the thread keeps what its provider could do when it started");
});

shardTest("demo: Edit and Bash asks carry their detail, always hands back the suggestions, and the transcript is Claude Code's shape", async t => {
  const { root, work, tool } = await boot(t);
  const got = responses(t, root);
  const tx = path.join(root, "fake-projects");
  const was = process.env.FAKE_CLAUDE_TRANSCRIPTS;
  process.env.FAKE_CLAUDE_TRANSCRIPTS = tx;
  t.after(() => { if (was === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPTS; else process.env.FAKE_CLAUDE_TRANSCRIPTS = was; });
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "demo", surface: "deck" })).data.id;

  const edit = await until(async () => (await tool("threads.asks", { thread: id })).data[0], "the Edit ask");
  assert.equal(edit.kind, "permission");
  assert.equal(edit.tool, "Edit");
  assert.equal(edit.always, true, "Claude Code offered a suggestion");
  assert.equal(edit.detail.file, path.join(work, "menu.md"));
  assert.match(edit.detail.old, /Summer berry tart/);
  assert.match(edit.detail.new, /Pumpkin loaf/);
  const raisedEdit = of(s.got, id, "ask.raised")[0];
  assert.equal(raisedEdit.payload.kind, "permission");
  assert.equal(raisedEdit.payload.detail, undefined, "the detail stays out of the event");
  assert.equal((await tool("threads.answer", { ask: edit.id, decision: "always", surface: "deck" })).data.decision, "always");

  const bash = await until(async () => (await tool("threads.asks", { thread: id })).data.find(a => a.tool === "Bash"), "the Bash ask");
  assert.deepEqual(bash.detail, { command: "npm test", description: "Run the menu tests" });
  assert.equal(bash.always, true);
  await tool("threads.answer", { ask: bash.id, decision: "allow", surface: "deck" });
  const reply = await until(() => of(s.got, id, "thread.text").find(e => e.payload.done), "the reply");
  assert.match(of(s.got, id, "thread.thinking")[0].payload.text, /^alex wants the autumn specials/, "thinking is its own event, before the reply");
  assert.match(reply.payload.text, /^## Autumn specials/);
  assert.match(reply.payload.text, /```sh\nnpm test/);

  const [re, rb] = got();
  assert.deepEqual(re.updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }], "always sends Claude Code's suggestions");
  assert.equal(re.updatedInput.old_string.includes("Summer berry tart"), true);
  assert.equal(rb.behavior, "allow");
  assert.equal(rb.updatedPermissions, undefined, "a plain allow does not");
  const tools = of(s.got, id, "thread.tool").filter(e => e.payload.phase === "started").map(e => e.payload.tool);
  assert.deepEqual(tools, ["Read", "Edit", "Bash", "TodoWrite"]);

  const file = path.join(tx, work.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines[0].message, { role: "user", content: "demo" });
  assert.equal(lines[0].parentUuid, null);
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].parentUuid, lines[i - 1].uuid, "each line follows the one before");
  for (const l of lines) { assert.equal(l.sessionId, id); assert.equal(l.cwd, work); assert.ok(!Number.isNaN(Date.parse(l.timestamp))); }
  const blocks = lines.flatMap(l => l.message.content instanceof Array ? l.message.content.map(b => ({ type: l.type, b, l })) : []);
  assert.deepEqual(blocks.map(x => x.b.type), ["thinking", "tool_use", "tool_result", "tool_use", "tool_result", "tool_use", "tool_result", "tool_use", "tool_result", "text"]);
  for (const x of blocks.filter(x => x.type === "assistant")) { assert.equal(x.l.message.model, "opus", "a chat session runs on the work model (sessions.models)"); assert.ok(x.l.message.usage.output_tokens > 0); }
  const todo = blocks.find(x => x.b.name === "TodoWrite").b.input.todos;
  assert.deepEqual(todo.map(t => t.status), ["completed", "in_progress", "pending"]);
  const bashResult = blocks.filter(x => x.b.type === "tool_result")[2];
  assert.match(bashResult.b.content, /# pass 2/);
  assert.equal(bashResult.l.toolUseResult.stdout, bashResult.b.content);
});

shardTest("fake claude: the echo and ask turns are written to the transcript too", async t => {
  const { root, work, tool } = await boot(t);
  const tx = path.join(root, "fake-projects");
  const was = process.env.FAKE_CLAUDE_TRANSCRIPTS;
  process.env.FAKE_CLAUDE_TRANSCRIPTS = tx;
  t.after(() => { if (was === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPTS; else process.env.FAKE_CLAUDE_TRANSCRIPTS = was; });
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "hello kit" })).data.id;
  await until(() => of(s.got, id, "thread.finished")[0], "the echo");
  await tool("threads.send", { thread: id, text: "ask" });
  const raised = await until(() => of(s.got, id, "ask.raised")[0], "ask.raised");
  await tool("threads.answer", { ask: raised.payload.ask, decision: "allow", answers: { "Which palette should the Northwind Bakery menu use?": "Plain" } });
  await until(() => of(s.got, id, "thread.finished").length >= 2, "the ask turn");
  const lines = fs.readFileSync(path.join(tx, work.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.type), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.equal(lines[1].message.content[0].text, "echo: hello kit");
  assert.equal(lines[3].message.content[0].name, "AskUserQuestion");
  assert.match(lines[4].message.content[0].content, /User has answered your questions: "Which palette should the Northwind Bakery menu use\?"="Plain"/);
});

shardTest("agents.update: names its agent by name or agent, as the Deck's Give a computer does", async t => {
  const { tool } = await boot(t);
  await tool("agents.create", { name: "kit", projects: [] });
  const r = await tool("agents.update", { agent: "kit", computer: true }, "deck");
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.equal(r.data.computer, true);
  assert.equal(r.data.name, "kit", "agent is not stored as a field");
  assert.equal((await tool("agents.update", { name: "kit", computer: false })).data.computer, false, "name still works");
  assert.match((await tool("agents.update", { name: "kit", agent: "juno", computer: true })).error.message, /different agents/);
  assert.match((await tool("agents.update", { computer: true })).error.message, /say which agent/);
  assert.equal((await tool("agents.list", {})).data.find(a => a.name === "kit").computer, false);
});

shardTest("agents.create: computer true, as the Deck's New agent and Create your assistant boxes send it, is kept", async t => {
  const { tool } = await boot(t);
  const r = await tool("agents.create", { name: "kit", kind: "agent", projects: [], computer: true }, "deck");
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.equal(r.data.computer, true);
  const juno = await tool("agents.create", { name: "juno", kind: "assistant", projects: "*", computer: true }, "deck");
  assert.equal(juno.error, undefined, juno.error && juno.error.message);
  await tool("agents.create", { name: "pax", kind: "agent", projects: [] }, "deck");
  const list = (await tool("agents.list", {})).data.filter(a => !a.builtin);
  assert.equal(list.find(a => a.name === "kit").computer, true);
  assert.equal(list.find(a => a.name === "juno").computer, true);
  assert.equal(list.find(a => a.name === "pax").computer, false, "unticked stays without one");
});

shardTest("sessions: claude is known by its command line, since node 24 names its main thread MainThread", () => {
  for (const args of ["claude", "/usr/local/bin/claude --resume abc", "/opt/homebrew/bin/node /usr/local/bin/claude", "node /Users/alex/.npm/bin/claude -p hi"]) assert.equal(claudeCommand(args), true, args);
  for (const args of ["MainThread", "node /usr/local/bin/vyre", "/usr/bin/python3 claude.py", "bash -c claude", ""]) assert.equal(claudeCommand(args), false, args);
});

shardTest("queue: a person's words are queued for a terminal-busy session, the owner's phone over the tailnet included; a model's are refused", async () => {
  const { queuesFor, fromLink } = await import("./index.js");
  for (const c of ["deck", "capsule", "cli", "local", "tailnet:alex@example.com", "link:box"]) assert.equal(queuesFor(c), true, c);
  assert.deepEqual(["link:box", "deck", "mcp:link:box"].map(fromLink), [true, false, false], "the link is a caller kind of its own");
  for (const c of ["mcp", "mcp:agent:kit", "harness", "hook", "tailnet:agent:kit", "cli agent:kit", "tailnet:"]) assert.equal(queuesFor(c), false, c);
});

shardTest("projectRules: Claude Code's addRules suggestions keep their rules; a mode becomes a rule for the whole tool", () => {
  assert.deepEqual(projectRules("Bash", [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" }]),
    [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }]);
  assert.deepEqual(projectRules("Edit", [{ type: "setMode", mode: "acceptEdits", destination: "session" }]),
    [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "localSettings" }]);
  const sb = /** @type {any} */ ({ asks: { get: () => ({ thread: "t1", kind: "permission", tool: "Bash", summary: "npm test", destination: null }) },
    record: () => ({ name: "Menu", project: "harlow" }), scopes: new Map([["t1", { slug: "harlow", name: "Harlow Legal", cwd: "/w" }]]) });
  assert.equal(answerSummary(sb, { ask: "p1", decision: "always", scope: "project" }), "Always allow Bash in Harlow Legal: npm test (thread Menu)");
});

shardTest("always in <project>: offered for a thread in its project's folder, sent as a localSettings rule; refused elsewhere", async t => {
  const { root, work, tool } = await boot(t);
  const got = responses(t, root);
  assert.ok(!(await tool("projects.create", { name: "Harlow Legal", home: work })).error);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { project: "harlow-legal", name: "Menu", prompt: "demo", surface: "deck" })).data.id;
  const edit = await until(async () => (await tool("threads.asks", { thread: id })).data.find(a => a.always_project), "always_project on the Edit ask");
  assert.equal(edit.always_project, "Harlow Legal");
  assert.equal(edit.thread_name, "Menu");
  assert.equal(of(s.got, id, "ask.raised")[0].payload.thread_name, "Menu");
  assert.equal((await tool("threads.answer", { ask: edit.id, decision: "always", scope: "project", surface: "deck" })).data.answered, true);
  const bash = await until(async () => (await tool("threads.asks", { thread: id })).data.find(a => a.tool === "Bash" && a.always_project), "the Bash ask");
  await tool("threads.answer", { ask: bash.id, decision: "always", scope: "project", surface: "deck" });
  await until(() => of(s.got, id, "thread.finished")[0], "the turn");
  const [re, rb] = got();
  assert.deepEqual(re.updatedPermissions, [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "localSettings" }]);
  assert.deepEqual(rb.updatedPermissions, [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }]);
  assert.equal(of(s.got, id, "ask.answered")[0].payload.scope, "project");

  // A thread outside every project: no project control, and asking for one is refused.
  const loose = fs.mkdtempSync(path.join(root, "loose-"));
  const other = (await tool("threads.start", { cwd: loose, prompt: "demo", surface: "deck" })).data.id;
  const ask = await until(async () => (await tool("threads.asks", { thread: other })).data[0], "the loose Edit ask");
  assert.equal(ask.always, true);
  assert.equal(ask.always_project, null);
  assert.match((await tool("threads.answer", { ask: ask.id, decision: "always", scope: "project", surface: "deck" })).error.message, /project/);
  assert.equal((await tool("threads.asks", { thread: other })).data.length, 1, "still open after the refusal");
});

shardTest("switchboard: a push ask and a Write ask carry the Changes row in threads.asks, never in ask.raised", async t => {
  const { root, work, tool } = await boot(t);
  const { execFileSync } = await import("node:child_process");
  const env = { ...process.env, GIT_AUTHOR_NAME: "alex", GIT_AUTHOR_EMAIL: "alex@example.com", GIT_COMMITTER_NAME: "alex", GIT_COMMITTER_EMAIL: "alex@example.com",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig") };
  const remote = path.join(root, "remote.git"), site = path.join(work, "site");
  const git = (...a) => execFileSync("git", a, { cwd: site, env, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env });
  fs.mkdirSync(site);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", remote);
  fs.writeFileSync(path.join(site, "menu.md"), "- Summer tart, 4.00\n");
  git("add", "."); git("commit", "-q", "-m", "menu"); git("push", "-q", "-u", "origin", "main");
  fs.writeFileSync(path.join(site, "menu.md"), "- Pumpkin loaf, 5.50\n- Apple cider donut, 3.25\n");
  fs.writeFileSync(path.join(site, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 0]));
  git("add", "."); git("commit", "-q", "-m", "autumn");

  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "bash git -C site push origin main" })).data.id;
  const raised = await until(() => of(s.got, id, "ask.raised")[0], "ask.raised");
  assert.equal("detail" in raised.payload, false, "the event stays small");
  const [ask] = (await tool("threads.asks", { thread: id })).data;
  assert.equal(ask.detail.command, "git -C site push origin main");
  assert.deepEqual(ask.detail.changes, [{ file: "logo.png", added: null, removed: null, binary: true }, { file: "menu.md", added: 2, removed: 1 }]);
  assert.deepEqual(ask.detail.totals, { files: 2, added: 2, removed: 1 });
  await tool("threads.answer", { ask: ask.id, decision: "deny", surface: "deck" });
  await until(async () => (await tool("threads.get", { thread: id })).data.thread.status === "idle", "the turn to end");

  const file = path.join(work, "notes.md");
  fs.writeFileSync(file, "one\ntwo\n");
  assert.equal((await tool("threads.send", { thread: id, text: `write ${file}`, surface: "cli" })).data.sent, true);
  await until(() => of(s.got, id, "ask.raised")[1], "the second ask.raised");
  const [w] = (await tool("threads.asks", { thread: id })).data;
  assert.deepEqual(w.detail.changes, [{ file, added: 1, removed: 2 }], "the fake writes \"hi\" over two lines");
  assert.deepEqual(w.detail.totals, { files: 1, added: 1, removed: 2 });
  await tool("threads.stop", { thread: id });
});

shardTest("steer and queue while an ask is open: both are kept, threads.get shows them, and each reaches Claude after the answer", async t => {
  const { root, work, tool } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "demo", surface: "deck" })).data.id;
  const edit = await until(async () => (await tool("threads.asks", { thread: id })).data.find(a => a.tool === "Edit"), "the Edit ask");
  assert.equal((await tool("threads.get", { thread: id })).data.thread.status, "waiting");

  const steer = (await tool("threads.send", { thread: id, text: "use the rye price too", surface: "deck" }, "deck")).data;
  assert.equal(steer.sent, true, JSON.stringify(steer));
  assert.equal(steer.steered, true, JSON.stringify(steer));
  const queued = (await tool("threads.send", { thread: id, text: "then check the hours", surface: "deck", mode: "queue" }, "deck")).data;
  assert.equal(queued.queued, true, JSON.stringify(queued));
  assert.ok(Number.isInteger(queued.queued_id), JSON.stringify(queued));

  // Reopened while the ask is still open: everything a surface reads to rebuild the rows.
  const got = (await tool("threads.get", { thread: id, since: 0 })).data;
  assert.equal(got.thread.status, "waiting");
  assert.equal(got.asks.length, 1);
  const sentSteer = got.events.find(e => e.type === "thread.sent" && e.payload.via === "steer");
  assert.ok(sentSteer, "thread.sent via steer is in threads.get");
  assert.equal(sentSteer.payload.uuid, steer.uuid);
  assert.equal(sentSteer.payload.text, "use the rye price too");
  assert.equal(got.events.some(e => e.type === "thread.steered"), false, "not taken in while the turn is blocked");
  const q = got.events.find(e => e.type === "thread.queued");
  assert.ok(q, "thread.queued is in threads.get");
  assert.deepEqual([q.payload.queued, q.payload.text], [queued.queued_id, "then check the hours"]);
  assert.deepEqual((await tool("threads.queue", { thread: id }, "deck")).data.queued.map(r => r.queued), [queued.queued_id]);

  // The answer: the steer is taken in at the turn's next step, the queued words are the next turn.
  await tool("threads.answer", { ask: edit.id, decision: "allow", surface: "deck" });
  const bash = await until(async () => (await tool("threads.asks", { thread: id })).data.find(a => a.tool === "Bash"), "the Bash ask");
  await tool("threads.answer", { ask: bash.id, decision: "allow", surface: "deck" });
  const steered = await until(() => of(s.got, id, "thread.steered")[0], "thread.steered");
  assert.equal(steered.payload.uuid, steer.uuid);
  const handed = await until(() => of(s.got, id, "thread.sent").find(e => e.payload.via === "turn"), "the queued words handed over");
  assert.equal(handed.payload.queued, queued.queued_id);
  await until(() => of(s.got, id, "thread.text").find(e => e.payload.done && /echo: then check the hours/.test(e.payload.text)), "the queued turn's reply");
  const took = of(s.got, id, "thread.text").find(e => e.payload.done && /took in: use the rye price too/.test(e.payload.text));
  assert.ok(took, "the steered words reached Claude in the running turn");
  assert.deepEqual((await tool("threads.queue", { thread: id }, "deck")).data.queued, []);
});

shardTest("describe: a Bash ask's summary is redacted, as it is shown on every device", () => {
  // Built at run time so the fake key does not trip the hygiene scan (test/hygiene.test.js).
  const fake = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join("-");
  const d = describe("Bash", { command: `curl -H "Authorization: Bearer ${fake}" https://example.com` });
  assert.doesNotMatch(d.summary, /abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(d.summary, /^curl -H "Authorization: Bearer \[/);
  assert.equal(describe("Bash", { command: "npm   test" }).summary, "npm test");
});

shardTest("spend cap, through the real daemon: at the cap the person's own agents.ask, threads.send and unnamed mcp session go through, the ask with a notice on the thread", async t => {
  const { root, tool, work } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  assert.equal((await tool("spend.raise", { provider: "all", to: 0.25 })).data.cap, 0.25);
  const started = await tool("threads.start", { cwd: work, prompt: "spend 0.5" });
  assert.ok(started.data, JSON.stringify(started.error));
  const id = started.data.id || started.data.thread;
  // The turn cost more than the cap: the ledger has seen it.
  const at = await until(async () => { const c = (await tool("spend.check", {})).data; return c && c.capped ? c : null; }, "the ledger reaching the cap");
  assert.equal(at.scope, "all");
  assert.match(at.line, /vyre spend raise all/);
  await tool("agents.create", { name: "scout", projects: [] });
  // The person typing an ask to an agent is the person choosing to spend: it goes through, and the thread is told about the cap.
  const asked = await tool("agents.ask", { agent: "scout", text: "hello", wait: false });
  assert.ok(asked.data && asked.data.sent, JSON.stringify(asked));
  const note = await until(() => of(s.got, asked.data.thread, "thread.text").find(e => e.payload.notice && /You asked, so this went through/.test(e.payload.text || "")), "the cap notice on the agent's thread");
  assert.match(note.payload.text, /vyre spend raise all/);
  // The person's own surfaces and their own Claude session are never held.
  for (const who of ["cli", "deck", "mcp"]) {
    const r = await tool("threads.send", { thread: id, text: `from ${who}` }, who);
    assert.notEqual(r.error && r.error.code, "spend_capped", `${who}: ${JSON.stringify(r.error)}`);
  }
});

shardTest("switchedLine: what carries over is said plainly, per kind of move", async () => {
  const { switchedLine, modelName, providerName } = await import("./index.js");
  const caps = { rewind: true, steering: true, questions: true, interrupt: true, transcripts: true };
  assert.equal(switchedLine({ from: "claude", to: "grok", had: true, fromCaps: caps, toCaps: caps }), "Switched to Grok. It has this session's memory and files.");
  assert.equal(switchedLine({ from: "claude", to: "codex", had: false }), "Switched to Codex. It has this session's memory and files. It starts from what was said so far, not from Claude's own working notes.");
  assert.match(switchedLine({ from: "claude", to: "grok", had: true, reason: "limit" }), /^Claude's limit was reached\. Switched to Grok\./);
  assert.match(switchedLine({ from: "claude", to: "grok", had: true, fromCaps: caps, toCaps: { streaming: true } }), /Grok cannot do these here: going back to an earlier turn, .*opening its transcript in a terminal\.$/);
  assert.equal(switchedLine({ from: "claude", to: "grok", had: false, reason: "once" }), "This turn runs on Grok. It has this session's memory and files. The session stays on Claude.");
  assert.equal(switchedLine({ from: "grok", to: "claude", had: true, reason: "back" }), "Back on Claude. It has this session's memory and files, and what Grok said this turn.");
  assert.equal(modelName("claude-opus-4-1[high]"), "claude-opus-4-1");
  assert.equal(providerName("openrouter"), "OpenRouter");
});

shardTest("ownSurface: only the person's own surface names, anchored; every other string is a contest", () => {
  for (const own of ["deck", "deck:1", "phone", "phone:ab", "capsule", "capsule:x", "glass", "lumen", "mac", "mac:studio", "web"]) assert.equal(ownSurface(own), true, own);
  for (const not of ["machine", "webhook:x", "deckx", "phones", "webby", "tailnet:other@x", "tailnet:owner@example", "tailnet:agent:a", "tailnet-guest:g@x", "device:x", "device:aaaaaaaaaaaaaaaa",
    "box:phone", "cli:123", "chat", "person", "you", "vyre", "", "mcp", "xdeck"]) assert.equal(ownSurface(not), false, not);
});

shardTest("surfaceFor: identity comes from the verified caller, never from the surface a call names", async () => {
  const { surfaceFor } = await import("./index.js");
  const owner = "Owner@Example";
  // The owner's own devices.
  assert.equal(surfaceFor({}, "tailnet:owner@example", owner), "deck", "the login equals the recorded owner (case aside)");
  assert.equal(surfaceFor({ surface: "capsule" }, "tailnet:owner@example", owner), "capsule");
  assert.equal(surfaceFor({ surface: "tailnet:other@x" }, "tailnet:owner@example", owner), "deck", "the owner cannot be turned into another label by input");
  assert.equal(surfaceFor({}, "device:abcdefghijklmnop", owner), "phone", "a verified paired device");
  assert.equal(surfaceFor({ surface: "glass" }, "device:abcdefghijklmnop", owner), "glass");
  // A person's own socket caller says which of their surfaces.
  assert.equal(surfaceFor({ surface: "deck:2" }, "deck", owner), "deck:2");
  assert.equal(surfaceFor({ surface: "cli:123" }, "cli", owner), "cli:123", "a terminal is its own, contested surface");
  assert.equal(surfaceFor({}, "cli", owner), "cli");
  // Not the owner: its own label, and never an own surface by claiming one.
  assert.equal(surfaceFor({}, "tailnet:other@x", owner), "tailnet:other@x", "another login is another person");
  assert.equal(surfaceFor({ surface: "deck" }, "tailnet:other@x", owner), "via:tailnet:other@x");
  assert.equal(surfaceFor({}, "tailnet:owner@example", ""), "tailnet:owner@example", "no recorded owner, so nobody is the owner");
  assert.equal(surfaceFor({}, "tailnet:agent:a", owner), "tailnet:agent:a");
  assert.equal(surfaceFor({ surface: "deck" }, "tailnet:agent:a", owner), "via:tailnet:agent:a");
  assert.equal(surfaceFor({}, "tailnet-guest:g@x", owner), "tailnet-guest:g@x");
  assert.equal(surfaceFor({ surface: "phone" }, "tailnet-guest:g@x", owner), "via:tailnet-guest:g@x");
  assert.equal(surfaceFor({ surface: "device:aaaaaaaaaaaaaaaa" }, "mcp", owner), "via:mcp", "a device claimed from input");
  for (const bad of ["deck", "deck:1", "phone", "capsule", "glass", "lumen", "mac", "web", "device:x", "tailnet:other@x", "tailnet:owner@example", "tailnet:agent:a"]) {
    for (const caller of ["mcp", "harness", "hook", "module:planner", "mcp:agent:kit"]) assert.equal(ownSurface(surfaceFor({ surface: bad }, caller, owner)), false, `${caller} naming ${bad}`);
  }
  for (const odd of ["machine", "webhook:x", "deckx", "tailnet:other@x", "tailnet:agent:a", "device:x"]) assert.equal(ownSurface(surfaceFor({ surface: odd }, "mcp", owner)), false, odd);
  // Any caller that is not the owner or a person's own socket gets its own label, or via:<label> for any other name: it never joins another holder.
  for (const caller of ["mcp", "harness", "module:planner", "mcp:agent:kit", "hook"]) {
    for (const name of [`cli:${process.pid}`, "box:x", "agent:kit", "mcp:agent:juno", "another-holder", "machine", "webhook:x"]) {
      const got = surfaceFor({ surface: name }, caller, owner);
      assert.equal(got, `via:${caller}`, `${caller} naming ${name}`);
      assert.notEqual(got, name);
    }
    assert.equal(surfaceFor({}, caller, owner), caller, "no name asked: its own label");
    assert.equal(surfaceFor({ surface: caller }, caller, owner), caller, "its own label asked: itself");
  }
  // Not by prefix: a login that merely starts like the owner's is another person.
  assert.equal(surfaceFor({}, "tailnet:owner@example.evil", owner), "tailnet:owner@example.evil");
  // The link's words are always the box's.
  assert.equal(surfaceFor({ surface: "deck" }, "link:abc", owner), "box:via:link:abc");
  assert.equal(surfaceFor({ surface: "box:deck" }, "link:box", owner), "box:deck", "the box's own surface, as core/link/mac.js marks it, stands");
  assert.equal(surfaceFor({ surface: "cli:123" }, "link:box", owner), "box:via:link:box", "a terminal's name is never the link's");
  // The computers module names the person's screen it already checked; no other module does.
  assert.equal(surfaceFor({ surface: "glass:laptop" }, "module:computers", owner), "glass:laptop");
  assert.equal(surfaceFor({ surface: "cli:123" }, "module:computers", owner), "via:module:computers");
  assert.equal(surfaceFor({ surface: "glass:laptop" }, "module:planner", owner), "via:module:planner");
});

shardTest("one model per turn (#41): the thread follows what the provider reports, says so once, and a switch labels old and new replies apart", async t => {
  const { root, work, tool } = await boot(t);
  // The account's default is not the alias the thread asked for: the provider says what it really runs.
  const had = process.env.FAKE_CLAUDE_REPORT_MODEL;
  process.env.FAKE_CLAUDE_REPORT_MODEL = "claude-opus-5-5";
  t.after(() => { if (had === undefined) delete process.env.FAKE_CLAUDE_REPORT_MODEL; else process.env.FAKE_CLAUDE_REPORT_MODEL = had; });
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, name: "model truth", prompt: "first", model: "sonnet", surface: "deck:1" })).data.id;
  await until(() => of(s.got, id, "thread.finished").length >= 1, "the first turn");
  const textOf = (n) => of(s.got, id, "thread.text").filter(e => e.payload.done && !e.payload.notice && e.payload.kind !== "reasoning")[n];

  const said = of(s.got, id, "model.switched");
  assert.equal(said.length, 1, "the changed answer is said once, so the header and the picker move with it");
  assert.equal(said[0].payload.model, "claude-opus-5-5");
  assert.equal((await tool("threads.get", { thread: id })).data.thread.model, "claude-opus-5-5", "the record agrees with the header, the picker and the reply");
  assert.equal(textOf(0).payload.model, "claude-opus-5-5", "the first reply is stamped with the model that answered it");

  // Switching mid-thread: the next reply carries the new model, the earlier one keeps its own.
  delete process.env.FAKE_CLAUDE_REPORT_MODEL;
  assert.equal((await tool("threads.model", { thread: id, model: "haiku" })).error, undefined);
  await until(() => of(s.got, id, "model.switched").length >= 2, "the switch event");
  assert.equal(of(s.got, id, "model.switched")[1].payload.model, "haiku");
  await tool("threads.send", { thread: id, text: "second", surface: "deck:1" });
  await until(() => of(s.got, id, "thread.finished").length >= 2, "the second turn");
  assert.equal(textOf(0).payload.model, "claude-opus-5-5", "the old reply is not relabelled");
  assert.match(textOf(1).payload.model, /haiku/, "the new reply says the new model");
  assert.equal(of(s.got, id, "model.switched").length, 2, "an answer that matches the switch says nothing more");
});
