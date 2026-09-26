// @ts-check
// The switchboard and agents, end to end: vyred in a temp home, a fake `claude` that speaks
// stream-json (./testing/fake-claude.js), two SSE clients watching, and every tool called the
// way a surface calls it. The real Claude Code run is recorded in docs/work/switchboard.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { translate, describe } from "./translate.js";
import { argsFor } from "./runner.js";
import { Leases, TTL } from "./lease.js";
import { open } from "../store/index.js";
import { MIGRATIONS } from "./index.js";
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
  // The file keystore, so no test goes near the login keychain.
  if (vault) fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  if (probe) {
    // Internal tools answer only modules: a module that asks threads.claimed for the test.
    writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.claimed"] } }, `
      export default { async start(ctx) {
        ctx.tool("probe.claimed", { input: { type: "object" }, run: async ({ session }) => (await ctx.call("threads.claimed", { session })).data });
        return { async stop() {} };
      } };`);
  }
  const d = await start({ root, log: () => {} });
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
  return { root, d, work, launches, tool };
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

  // A model never approves a permission: the loader refuses both MCP caller forms and hides the tool.
  for (const who of ["mcp", "mcp:agent:juno"]) {
    const byModel = await tool("threads.answer", { ask: raised.payload.ask, decision: "allow" }, who);
    assert.equal(byModel.error.code, "denied", who);
    const listed = (await request("GET", "/v1/tools", undefined, { root, caller: who })).data.map(x => x.name);
    assert.ok(!listed.includes("threads.answer") && listed.includes("threads.get"), `${who} does not see threads.answer`);
  }
  for (const who of ["deck", "capsule", "local"]) {
    assert.ok((await request("GET", "/v1/tools", undefined, { root, caller: who })).data.some(x => x.name === "threads.answer"), `${who} can answer`);
  }
  assert.equal(fs.existsSync(target), false);

  const ans = await tool("threads.answer", { ask: raised.payload.ask, decision: "allow", surface: "capsule" });
  assert.deepEqual(ans.data, { ask: raised.payload.ask, answered: true, decision: "allow" });
  await until(() => of(a.got, id, "ask.answered")[0], "ask.answered");
  assert.equal(of(a.got, id, "ask.answered")[0].payload.by, "capsule");
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
  assert.deepEqual((await tool("probe.claimed", { session: id })).data, { headless: true, holder: "deck:1", status: (await tool("threads.get", { thread: id })).data.thread.status });
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
  const again = await start({ root, log: () => {} });
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

  // Only the assistant may drive sessions from inside its thread.
  assert.match((await tool("threads.list", {}, "mcp:agent:scout")).error.message, /only the assistant/);
  assert.match((await tool("agents.ask", { agent: "juno", text: "hi" }, "mcp:agent:scout")).error.message, /only the assistant/);
  const hi = (await tool("agents.ask", { agent: "juno", text: "hi" })).data;
  assert.equal(hi.text, "echo: hi");
  assert.equal(launches().at(-1).auth, "ambient", "no auth configured means the machine's own login");
  assert.equal(launches().at(-1).projects, "*");
  assert.ok(Array.isArray((await tool("threads.list", {}, "mcp:agent:juno")).data));

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
