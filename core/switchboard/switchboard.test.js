// @ts-check
// The switchboard and agents, end to end: vyred in a temp home, a fake `claude` that speaks
// stream-json (./testing/fake-claude.js), two SSE clients watching, and every tool called the
// way a surface calls it. The real Claude Code run is recorded in docs/work/switchboard.md.

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
import { tempHome, writeModule, present } from "../../test/helpers.js";
import { translate, describe } from "./translate.js";
import { argsFor } from "./runner.js";
import { Leases, TTL } from "./lease.js";
import { opensSession } from "./adopt.js";
import { open } from "../store/index.js";
import { MIGRATIONS, answerSummary, projectRules } from "./index.js";
import { Sessions, claudeCommand } from "./sessions.js";
import { migrate } from "../store/index.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);

// ------------------------------------------------------------ pure parts

test("translate: real stream-json lines become small thread events", () => {
  assert.deepEqual(translate({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-4-5" }), { events: [], session: "s1", model: "claude-haiku-4-5" });
  assert.equal(translate({ type: "system", subtype: "hook_response", output: "the user's own hook output" }).events.length, 0, "hook output never reaches an event");
  assert.equal(translate({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }).message, "m1");
  assert.equal(translate({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } }, parent_tool_use_id: null }).delta, "hel");
  assert.equal(translate({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, parent_tool_use_id: "toolu_9" }).delta, undefined, "a subagent's text is not the thread's");
  const tool = translate({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/w/a.txt", content: "x".repeat(50000) } }] } });
  assert.deepEqual(tool.events[0], { type: "thread.tool", payload: { id: "t1", tool: "Write", phase: "started", summary: "Write /w/a.txt", destination: "/w/a.txt" } });
  const ask = translate({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls -la" }, tool_use_id: "t2" } });
  assert.equal(ask.ask.summary, "ls -la");
  assert.equal(ask.ask.request_id, "r1");
  const fin = translate({ type: "result", is_error: false, result: "done", total_cost_usd: 0.01, stop_reason: "end_turn" });
  assert.equal(fin.events[0].type, "thread.finished");
  assert.equal(fin.events[0].payload.cost_usd, 0.01);
  assert.equal(translate({ type: "rate_limit_event", rate_limit_info: { status: "allowed", overageStatus: "rejected" } }).limited, undefined, "overage being off is not the limit");
  assert.equal(translate({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }).limited, true);
});

test("describe: a sending tool names where it goes", () => {
  assert.equal(describe("mcp__mail__send_message", { to: "dana@harlowlegal.com", body: "hi" }).destination, "dana@harlowlegal.com");
  assert.ok(describe("Bash", { command: "x".repeat(900) }).summary.length <= 200);
});

test("argsFor: the flags a headless session needs, new and resumed", () => {
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

test("lease: one holder, take-over says who had it, quiet holders expire", t => {
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

test("adopt: only a claude given the session with --resume or --session-id has it open", () => {
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

test("lease: a terminal whose process exited holds nothing, so the next terminal can type", t => {
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
async function boot(t, { vault, ungranted = [], probe } = {}) {
  const root = tempHome(t);
  const log = path.join(root, "claude.log");
  const env = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  process.env.VYRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_LOG = log;
  t.after(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // Transcripts in the temp home, so adopting never looks at the user's own sessions; the file
  // keystore, so no test goes near the login keychain.
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [transcripts],
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
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const work = fs.mkdtempSync(path.join(root, "work-"));
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  for (const [name, value] of Object.entries(vault || {})) {
    const put = await tool("vault.put", { name, kind: name === "api-key" ? "api-key" : "secret", fields: { value } });
    assert.ok(put.data, `vault.put ${name}: ${put.error && put.error.message}`);
    if (ungranted.includes(name)) continue;
    assert.equal((await tool("vault.grant", { name, module: "agents" })).data.grant.status, "active");
  }
  return { root, d, work, launches, tool, transcripts };
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

test("switchboard: a thread streams to two clients, asks, is answered, and changes hands", async t => {
  const { root, work, tool, launches } = await boot(t);
  const a = sse(root), b = sse(root);
  t.after(() => { a.close(); b.close(); });

  const started = await tool("threads.start", { cwd: work, name: "Harlow copy", prompt: "hello there, this is a longer prompt", surface: "deck:1" });
  assert.equal(started.error, undefined, JSON.stringify(started.error));
  const id = started.data.id;
  assert.match(id, /^[0-9a-f-]{36}$/, "the thread id is the Claude Code session id");
  assert.equal(started.data.holder, "deck:1", "the surface that starts a thread has its keyboard");
  await until(() => of(a.got, id, "thread.finished").length && of(b.got, id, "thread.finished").length, "both clients to see the turn end");

  for (const c of [a, b]) {
    const done = of(c.got, id, "thread.text").find(e => e.payload.done);
    assert.equal(done.payload.text, "echo: hello there, this is a longer prompt");
    const deltas = of(c.got, id, "thread.text").filter(e => e.payload.delta);
    assert.equal(deltas.map(e => e.payload.delta).join(""), done.payload.text, "the deltas add up to the text");
    assert.ok(deltas.length < Math.ceil(done.payload.text.length / 6), "partial text is throttled, not one event per chunk");
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
  assert.equal((await tool("threads.get", { thread: id })).data.thread.status, "waiting");

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

  const ans = await tool("threads.answer", { ask: raised.payload.ask, decision: "allow", surface: "capsule" });
  assert.deepEqual(ans.data, { ask: raised.payload.ask, answered: true, decision: "allow" });
  await until(() => of(a.got, id, "ask.answered")[0], "ask.answered");
  assert.equal(of(a.got, id, "ask.answered")[0].payload.by, "capsule");
  assert.equal(of(a.got, id, "ask.answered")[0].payload.tool, "Write", "what was allowed, as a learning signal");
  assert.equal(of(a.got, id, "ask.answered")[0].payload.summary, raised.payload.summary);
  await until(() => fs.existsSync(target), "the file the answer allowed");
  assert.deepEqual((await tool("threads.asks", { thread: id })).data, []);
  assert.equal((await tool("threads.answer", { ask: raised.payload.ask, decision: "deny" })).data.answered, false, "an answered ask stays answered");

  // The lease: the other surface is read-only until it takes the keyboard.
  const refused = (await tool("threads.send", { thread: id, text: "from the phone", surface: "phone" })).data;
  assert.deepEqual(refused.sent, false);
  assert.equal(refused.holder, "deck:1");
  const moved = (await tool("threads.lease", { thread: id, surface: "phone" })).data;
  assert.equal(moved.previous, "deck:1");
  await until(() => of(a.got, id, "lease.changed").some(e => e.payload.holder === "phone" && e.payload.previous === "deck:1"), "lease.changed");
  assert.equal((await tool("threads.send", { thread: id, text: "typed on the deck", surface: "deck:1" })).data.holder, "phone");
  assert.equal((await tool("threads.send", { thread: id, text: "from the phone", surface: "phone" })).data.sent, true);
  await until(() => of(a.got, id, "thread.sent").some(e => e.payload.surface === "phone"), "thread.sent");

  // Stop, and a send brings it back with --resume under the same id.
  await until(() => of(a.got, id, "thread.finished").length >= 3, "the phone's turn");
  assert.equal((await tool("threads.stop", { thread: id })).data.stopped, true);
  await until(() => of(a.got, id, "thread.stopped")[0], "thread.stopped");
  assert.equal((await tool("threads.get", { thread: id })).data.thread.status, "stopped");
  assert.equal((await tool("threads.send", { thread: id, text: "still there?", surface: "phone" })).data.sent, true);
  await until(() => of(a.got, id, "thread.text").some(e => e.payload.text === "echo: still there?"), "the resumed reply");
  const last = launches().at(-1);
  assert.deepEqual(last.argv.slice(last.argv.indexOf("--resume"), last.argv.indexOf("--resume") + 2), ["--resume", id]);
});

test("switchboard: a finished turn's partial text is pruned after the grace; the done text stays", async t => {
  const was = process.env.VYRE_TEXT_PRUNE_MS;
  process.env.VYRE_TEXT_PRUNE_MS = "200";
  t.after(() => { if (was === undefined) delete process.env.VYRE_TEXT_PRUNE_MS; else process.env.VYRE_TEXT_PRUNE_MS = was; });
  const { root, work, tool } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "hello there, this is a longer prompt" })).data.id;
  await until(() => of(s.got, id, "thread.finished")[0], "the turn to end");
  const texts = async () => (await tool("threads.get", { thread: id, limit: 1000 })).data.events.filter(e => e.type === "thread.text");
  assert.ok((await texts()).some(e => e.payload.delta), "the deltas are there during the grace");
  await until(async () => !(await texts()).some(e => e.payload.delta), "the deltas to go");
  const done = (await texts()).filter(e => e.payload.done);
  assert.deepEqual(done.map(e => e.payload.text), ["echo: hello there, this is a longer prompt"]);
  const got = (await tool("threads.get", { thread: id })).data;
  assert.equal(got.thread.turns, 1);
  assert.ok(got.events.some(e => e.type === "thread.finished") && got.events.some(e => e.type === "thread.started"));
});

test("switchboard: a stopped thread's open question is closed, not left waiting", async t => {
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

test("switchboard: a terminal resume of a live headless thread is warned about, never blocked", async t => {
  const { root, work, tool } = await boot(t, { probe: true });
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, surface: "deck:1" })).data.id;
  assert.equal((await tool("threads.claimed", { session: id })).error.code, "no_such_tool", "internal: modules only");
  // Past "starting", so the status cannot move between the two reads.
  const status = await until(async () => { const st = (await tool("threads.get", { thread: id })).data.thread.status; return st !== "starting" && st; }, "the thread to start");
  assert.deepEqual((await tool("probe.claimed", { session: id })).data, { headless: true, holder: "deck:1", status });
  assert.equal((await tool("probe.claimed", { session: "not-a-thread" })).data.headless, false);

  // Our own child's SessionStart (headless true) is not a second writer.
  const own = (await tool("harness.brief", { cwd: work, session: id, headless: true }, "harness")).data;
  assert.doesNotMatch(own.text, /running headless/);
  assert.equal(of(s.got, id, "thread.contended").length, 0);

  // A terminal `claude --resume <id>`: the brief warns and the switchboard says so to every surface.
  const term = (await tool("harness.brief", { cwd: work, session: id, headless: false }, "harness")).data;
  assert.match(term.text, /^Warning from Vyre: this conversation is also running headless under Vyre right now \(holder: deck:1\)/);
  assert.ok(term.text.includes(`vyre threads stop ${id.slice(0, 8)}`));
  const ev = await until(() => of(s.got, id, "thread.contended")[0], "thread.contended");
  assert.deepEqual(ev.payload, { thread: id, session: id, holder: "deck:1" });

  await tool("threads.stop", { thread: id });
  await until(() => of(s.got, id, "thread.stopped")[0], "thread.stopped");
  assert.equal((await tool("probe.claimed", { session: id })).data.headless, false, "a stopped thread is nobody's writer");
  assert.doesNotMatch((await tool("harness.brief", { cwd: work, session: id, headless: false }, "harness")).data.text, /running headless/);
  assert.equal(of(s.got, id, "thread.contended").length, 1);
});

test("switchboard: vyred restarting marks its threads stopped", async t => {
  const { root, work, tool, d } = await boot(t);
  const id = (await tool("threads.start", { cwd: work })).data.id;
  await d.stop();
  const again = await start({ root, presence: present, log: () => {} });
  t.after(() => again.stop());
  const r = await call("threads.get", { thread: id }, { root });
  assert.equal(r.data.thread.status, "stopped");
});

test("agents: the assistant and an agent on its own credentials, with the fallback and budget", async t => {
  const { root, tool, launches } = await boot(t, { vault: { "setup-token": "fake-setup-value", "api-key": "fake-api-value" } });
  const s = sse(root);
  t.after(() => s.close());

  assert.equal((await tool("agents.create", { name: "juno", kind: "assistant" })).data.projects, "*");
  assert.match((await tool("agents.create", { name: "juno2", kind: "assistant" })).error.message, /already an assistant/);
  await tool("agents.create", { name: "scout", projects: [], auth: { vault: "setup-token", fallback: "api-key", budget_usd: 1 }, instructions: "Research only." });

  const list = (await tool("agents.list", {})).data;
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
  // From inside scout's thread, its key under a name that is not an agent: a visible 403, not "the user".
  for (const as of ["local", "cli", "deck"]) {
    const forged = (await tool("agents.ask", { agent: "scout", text: `forge ${as} threads.list` })).data.text;
    assert.match(forged, /^403 .*carries an agent's key, so it must name that agent/, as);
  }

  assert.equal((await tool("agents.threads", { agent: "scout" })).data.length, 1);
  const stopped = (await tool("agents.stop", { agent: "scout" })).data;
  assert.deepEqual(stopped.stopped, [who.thread]);
  await until(() => of(s.got, who.thread, "thread.stopped")[0], "scout stopping");

  // Typing into an agent's stopped thread resumes it with the agent's own credentials.
  assert.equal((await tool("threads.send", { thread: who.thread, text: "whoami", surface: "deck:1" })).data.sent, true);
  await until(() => launches().at(-1).argv.includes("--resume") && launches().at(-1).agent === "scout", "the agent's resume");
});

test("agents: an agent whose item is not granted to agents is refused, naming the grant to make", async t => {
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

test("agents: a subscription agent whose fallback key is not in the vault still starts, without the fallback", async t => {
  const { tool, launches } = await boot(t, { vault: { "setup-token": "fake-setup-value" } });
  await tool("agents.create", { name: "juno", kind: "assistant", auth: { vault: "setup-token", fallback: "api-key" } });
  const r = await tool("agents.ask", { agent: "juno", text: "whoami" });
  assert.equal(r.data?.text, "auth=subscription", JSON.stringify(r.error));
  assert.equal(launches().at(-1).auth, "subscription");
});

test("agents: an API-key agent stops at its budget", async t => {
  const { tool } = await boot(t, { vault: { "api-key": "fake-api-value" } });
  await tool("agents.create", { name: "ledger", projects: [], auth: { fallback: "api-key", budget_usd: 0.2 } });
  const r = (await tool("agents.ask", { agent: "ledger", text: "whoami" })).data;
  assert.equal(r.text, "auth=api-key");
  await tool("agents.stop", { agent: "ledger" });
  await until(async () => (await tool("agents.list", {})).data[0].status === "stopped", "ledger stopping");
  const again = await tool("agents.ask", { agent: "ledger", text: "whoami" });
  assert.match(again.error.message, /spent its \$0.2 budget/);
});

test("switchboard: the presence summary of an answer says what is allowed, where, and in which thread", () => {
  const asks = { a1: { thread: "0f3c9a2e-1111", tool: "Write", summary: "write notes.md", destination: "/work/notes.md" } };
  const sb = /** @type {any} */ ({ asks: { get: id => asks[id] || null }, record: () => ({ name: "Intake" }) });
  assert.equal(answerSummary(sb, { ask: "a1", decision: "allow" }), "Allow Write to /work/notes.md: write notes.md (thread Intake)");
  assert.equal(answerSummary({ ...sb, record: () => null }, { ask: "a1", decision: "deny" }), "Deny Write to /work/notes.md: write notes.md (thread 0f3c9a2e)");
  assert.equal(answerSummary(sb, { ask: "zz", decision: "deny" }), "deny permission question zz");
});

test("sessions: a session binds to a running claude once, its key is checked, and a gone process vouches for nothing", t => {
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

test("adopt: a terminal session nobody has open is resumed headless with the lease; one that is open is refused to a model and queued for a person", async t => {
  const { tool, work, launches, transcripts, root } = await boot(t);
  const quiet = terminalSession(transcripts, work);
  const sent = (await tool("threads.send", { thread: quiet.id, text: "add a phone field", surface: "capsule" })).data;
  assert.equal(sent.sent, true, JSON.stringify(sent));
  const rec = (await tool("threads.get", { thread: quiet.id })).data.thread;
  assert.deepEqual([rec.cwd, rec.name, rec.holder], [work, "Intake form", "capsule"]);
  const launch = await until(() => launches().at(-1), "the launch");
  assert.ok(launch.argv.includes("--resume") && launch.argv.includes(quiet.id), "resumed, not started anew");
  await until(async () => (await tool("threads.get", { thread: quiet.id })).data.events.some(e => e.type === "thread.text" && e.payload.text === "echo: add a phone field"), "the reply");
  assert.equal((await tool("threads.send", { thread: quiet.id, text: "and a note", surface: "deck" })).data.holder, "capsule", "the lease holds");

  // Written a moment ago: someone is working in it.
  const busy = terminalSession(transcripts, work, { ageMs: 1000 });
  const r1 = (await tool("threads.send", { thread: busy.id, text: "hi", surface: "capsule" }, "mcp")).data;
  assert.equal(r1.sent, false);
  assert.equal(r1.open_elsewhere, true);
  assert.match(r1.note, /written \ds ago.*Only one keyboard/);
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

test("queued for a terminal session: the Stop hook hands it over, Claude answers in that session, and the reply comes back as the thread's", async t => {
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

test("agents.history: each question with its answer and thread, newest last, pageable, and only for the assistant or a person", async t => {
  const { tool } = await boot(t);
  await tool("agents.create", { name: "juno", kind: "assistant" });
  await tool("agents.create", { name: "scout", projects: [], computer: true });
  // agents.list says whether each may have a computer; core/computers decides on it.
  assert.deepEqual((await tool("agents.list", {})).data.map(a => [a.name, a.computer]), [["juno", false], ["scout", true]]);
  for (const [agent, text] of [["juno", "one"], ["scout", "two"], ["juno", "three"]]) {
    assert.equal((await tool("agents.ask", { agent, text, surface: "deck" })).data.text, `echo: ${text}`);
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

test("lean and one-shot threads: no plugin, tools or settings, kept on resume; a job stops after its answer", async t => {
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
  const stopped = await until(async () => (await tool("threads.get", { thread: job.id })).data.events.find(e => e.type === "thread.stopped"), "the job to stop");
  assert.equal(stopped.payload.reason, "done");
  const events = (await tool("threads.get", { thread: job.id })).data.events;
  assert.equal(events.find(e => e.type === "thread.text" && e.payload.done).payload.text, "echo: distil this");
  const jobArgv = launches().at(-1).argv;
  assert.ok(!jobArgv.includes("--plugin-dir") && jobArgv.includes("--strict-mcp-config") && jobArgv[jobArgv.indexOf("--model") + 1] === "haiku");
});

test("threads.watch: said once when the thread finishes or asks, always when it stops, and not for other agents", async t => {
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

test("usage and budget: turns, tokens and cost per agent; a warning at 80% and a stop at 100% on the API key", async t => {
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

test("usage on the subscription: turns and time, no dollars, and the rate-limit report said in the thread", async t => {
  const { root, tool } = await boot(t);
  const s = sse(root);
  t.after(() => s.close());
  await tool("agents.create", { name: "juno", kind: "assistant" });
  const r = (await tool("agents.ask", { agent: "juno", text: "nearlimit" })).data;
  const limit = await until(() => of(s.got, r.thread, "thread.limit")[0], "thread.limit");
  assert.deepEqual(limit.payload, { thread: r.thread, status: "allowed_warning", kind: "five_hour", resets_at: 1790000000, utilization: 0.85 });
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

test("rate limit: a warning under 80% is kept on the thread and not said in it", async t => {
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

test("learned skills: the account's and the project's folders load as plugins; lean threads and jobs get only what they name", async t => {
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
  await tool("agents.create", { name: "scout", projects: ["harlow"] });
  await tool("agents.ask", { agent: "scout", text: "hi" });
  assert.deepEqual(dirsOf((await until(() => launches()[4], "scout's launch")).argv).slice(1), [account, harlow, scoutDir]);
});

test("agents: the assistant's brief says how to watch and drive threads for the user; an agent's does not", async () => {
  const { preamble } = await import("../agents/index.js");
  const brief = preamble({ name: "juno", kind: "assistant", projects: "*" });
  assert.match(brief, /threads_watch with \{thread, notify: "capsule", note: "<a short label>"\}/);
  assert.match(brief, /call threads_send, then set that watch/);
  assert.match(brief, /Do not poll threads_get/);
  assert.doesNotMatch(preamble({ name: "scout", kind: "agent", projects: ["harlow"] }), /threads_watch/);
});

test("agents.delete: a person removes a stopped agent and its spend; never the assistant, a running one, or by a model", async t => {
  const { tool } = await boot(t);
  await tool("agents.create", { name: "juno", kind: "assistant" });
  await tool("agents.create", { name: "probe", projects: [] });
  await tool("agents.ask", { agent: "probe", text: "hi" });
  assert.match((await tool("agents.delete", { agent: "probe" })).error.message, /has 1 running thread; stop it first: vyre agents stop probe/);
  assert.equal((await tool("agents.delete", { agent: "probe" }, "mcp")).error.code, "denied", "a model never deletes an agent");
  assert.match((await tool("agents.delete", { agent: "juno" })).error.message, /is the assistant/);
  await tool("agents.stop", { agent: "probe" });
  assert.deepEqual((await tool("agents.delete", { agent: "probe" }, "deck")).data, { agent: "probe", deleted: true });
  assert.deepEqual((await tool("agents.list", {})).data.map(a => a.name), ["juno"]);
  assert.match((await tool("agents.delete", { agent: "probe" })).error.message, /no agent probe/);
  assert.ok((await tool("agents.create", { name: "probe", projects: [] })).data, "the name is free again");
});

// ------------------------------------------------------------ questions and richer permission asks (ADR 0024)

test("translate: an AskUserQuestion is a question, redacted and capped; any other tool is a permission with its detail", () => {
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

test("switchboard: the presence summary of a question names the answers; always and decline say so", () => {
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

test("switchboard: a question is raised small, read whole, answered (single and multi-select) and said back", async t => {
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
  const said = await until(() => of(s.got, id, "thread.text").find(e => e.payload.done), "the fake to say the answers");
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

test("switchboard: a question can be declined", async t => {
  const { root, work, tool } = await boot(t);
  const got = responses(t, root);
  const s = sse(root);
  t.after(() => s.close());
  const id = (await tool("threads.start", { cwd: work, prompt: "ask" })).data.id;
  const raised = await until(() => of(s.got, id, "ask.raised")[0], "ask.raised");
  assert.equal((await tool("threads.answer", { ask: raised.payload.ask, decision: "deny", message: "Not now." })).data.answered, true);
  const said = await until(() => of(s.got, id, "thread.text").find(e => e.payload.done), "the reply");
  assert.equal(said.payload.text, "You declined the question: Not now.");
  assert.equal(got()[0].behavior, "deny");
  assert.equal(of(s.got, id, "ask.answered")[0].payload.answers, undefined);
});

test("demo: Edit and Bash asks carry their detail, always hands back the suggestions, and the transcript is Claude Code's shape", async t => {
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
  for (const x of blocks.filter(x => x.type === "assistant")) { assert.equal(x.l.message.model, "fake-model"); assert.ok(x.l.message.usage.output_tokens > 0); }
  const todo = blocks.find(x => x.b.name === "TodoWrite").b.input.todos;
  assert.deepEqual(todo.map(t => t.status), ["completed", "in_progress", "pending"]);
  const bashResult = blocks.filter(x => x.b.type === "tool_result")[2];
  assert.match(bashResult.b.content, /# pass 2/);
  assert.equal(bashResult.l.toolUseResult.stdout, bashResult.b.content);
});

test("fake claude: the echo and ask turns are written to the transcript too", async t => {
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

test("agents.update: names its agent by name or agent, as the Deck's Give a computer does", async t => {
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

test("sessions: claude is known by its command line, since node 24 names its main thread MainThread", () => {
  for (const args of ["claude", "/usr/local/bin/claude --resume abc", "/opt/homebrew/bin/node /usr/local/bin/claude", "node /Users/alex/.npm/bin/claude -p hi"]) assert.equal(claudeCommand(args), true, args);
  for (const args of ["MainThread", "node /usr/local/bin/vyre", "/usr/bin/python3 claude.py", "bash -c claude", ""]) assert.equal(claudeCommand(args), false, args);
});

test("queue: a person's words are queued for a terminal-busy session, the owner's phone over the tailnet included; a model's are refused", async () => {
  const { queuesFor, fromLink } = await import("./index.js");
  for (const c of ["deck", "capsule", "cli", "local", "tailnet:alex@example.com", "link:box"]) assert.equal(queuesFor(c), true, c);
  assert.deepEqual(["link:box", "deck", "mcp:link:box"].map(fromLink), [true, false, false], "the link is a caller kind of its own");
  for (const c of ["mcp", "mcp:agent:kit", "harness", "hook", "tailnet:agent:kit", "cli agent:kit", "tailnet:"]) assert.equal(queuesFor(c), false, c);
});

test("projectRules: Claude Code's addRules suggestions keep their rules; a mode becomes a rule for the whole tool", () => {
  assert.deepEqual(projectRules("Bash", [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" }]),
    [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }]);
  assert.deepEqual(projectRules("Edit", [{ type: "setMode", mode: "acceptEdits", destination: "session" }]),
    [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "localSettings" }]);
  const sb = /** @type {any} */ ({ asks: { get: () => ({ thread: "t1", kind: "permission", tool: "Bash", summary: "npm test", destination: null }) },
    record: () => ({ name: "Menu", project: "harlow" }), scopes: new Map([["t1", { slug: "harlow", name: "Harlow Legal", cwd: "/w" }]]) });
  assert.equal(answerSummary(sb, { ask: "p1", decision: "always", scope: "project" }), "Always allow Bash in Harlow Legal: npm test (thread Menu)");
});

test("always in <project>: offered for a thread in its project's folder, sent as a localSettings rule; refused elsewhere", async t => {
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
