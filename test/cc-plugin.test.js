// @ts-check
// The Harness as `/plugin install vyre` puts it: a copy of harness/ alone, in a folder like Claude
// Code's plugin cache, away from the package's core/. With Vyre on PATH it hands over to that
// package; with no Vyre it says how to install it once and is otherwise silent.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call as daemonCall } from "../core/daemon/client.js";
import { weakens } from "../core/learn/checks.js";
import { findPackage, locate, START } from "../harness/lib/vyre.js";
import { tempHome, writeModule, present } from "./helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(REPO, "harness");

/** A copy of the plugin in a cache-like folder, and a bin folder that is all of PATH. */
function install(t, { withVyre = false } = {}) {
  const dir = tempHome(t);
  const cache = path.join(dir, "cache", "vyre", "vyre", "0.0.1");
  fs.cpSync(PLUGIN, cache, { recursive: true });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  if (withVyre) fs.symlinkSync(path.join(REPO, "bin", "vyre"), path.join(bin, "vyre"));
  return { cache, env: { PATH: withVyre ? `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` : bin, CLAUDE_PLUGIN_ROOT: cache } };
}

/** Run a process with stdin and a clean env (no VYRE_PACKAGE), collect stdout and the time taken. */
function run(args, input, env) {
  const base = { ...process.env };
  delete base.VYRE_PACKAGE;
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, args, { env: { ...base, ...env } });
    let out = "";
    p.stdout.on("data", c => { out += c; });
    p.on("close", code => resolve({ code, out, ms: Date.now() - t0 }));
    p.stdin.end(input);
  });
}
const hook = (cache, piece, payload, env) => run([path.join(cache, "hooks", "run.js"), piece], JSON.stringify(payload), env);

/**
 * Speak MCP to a server over stdio until `want` replies arrive. Each request waits for the one
 * before it: the server answers calls concurrently, so a list sent with an add can beat it.
 */
async function mcp(file, env, msgs, want) {
  const base = { ...process.env };
  delete base.VYRE_PACKAGE;
  const p = spawn(process.execPath, [file], { env: { ...base, ...env } });
  const replies = new Map();
  /** @type {Map<any, (m: any) => void>} */
  const waiting = new Map();
  let buf = "";
  p.stdout.on("data", c => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      replies.set(m.id, m);
      waiting.get(m.id)?.(m);
    }
  });
  for (const m of msgs) {
    const answered = "id" in m && new Promise(resolve => waiting.set(m.id, resolve));
    p.stdin.write(JSON.stringify(m) + "\n");
    if (answered) await answered;
    if (replies.size >= want) break;
  }
  p.kill();
  return replies;
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

test("marketplace: one plugin, vyre, from ./harness, at the package's version", () => {
  const market = JSON.parse(fs.readFileSync(path.join(REPO, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(market.name, "vyre");
  assert.ok(market.owner && market.owner.name);
  assert.equal(market.plugins.length, 1);
  const [p] = market.plugins;
  assert.equal(p.name, "vyre");
  assert.equal(p.source, "./harness");
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, p.source, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "vyre");
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version, "the plugin moves with the package");
  const hooks = fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8");
  assert.ok(!hooks.includes("hook.js"), "hooks start from run.js, which works from a copy");
  assert.match(fs.readFileSync(path.join(PLUGIN, ".mcp.json"), "utf8"), /mcp\/run\.js/);
});

test("launcher: finds the package it sits in, VYRE_PACKAGE, or the vyre on PATH, else nothing", async t => {
  assert.equal(findPackage(PLUGIN, { PATH: "" }), REPO);
  const { cache } = install(t);
  assert.equal(findPackage(cache, { PATH: "" }), null);
  assert.equal(findPackage(cache, { VYRE_PACKAGE: REPO }), REPO);
  assert.equal(findPackage(cache, { VYRE_PACKAGE: cache }), null, "a folder that is not Vyre");
  const bin = path.join(path.dirname(cache), "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(REPO, "bin", "vyre"), path.join(bin, "vyre"));
  assert.equal(findPackage(cache, { PATH: bin }), REPO);
  assert.deepEqual(locate(cache, { PATH: bin, VYRE_HOME: path.join(bin, "none") }), { state: "setup", root: REPO });
  assert.deepEqual(locate(cache, { PATH: bin, VYRE_HOME: bin }), { state: "ready", root: REPO });
  // A session on a box runs as an account uid with no ~/.vyre; its own socket to vyred is what says Vyre is set up (#40).
  const sock = path.join(bin, "s.sock");
  const srv = (await import("node:net")).createServer();
  await new Promise(r => srv.listen(sock, r));
  t.after(() => srv.close());
  assert.deepEqual(locate(cache, { PATH: bin, VYRE_HOME: path.join(bin, "none"), VYRE_SOCKET: sock }), { state: "ready", root: REPO });
  assert.deepEqual(locate(cache, { PATH: bin, VYRE_HOME: path.join(bin, "none"), VYRE_SOCKET: path.join(bin, "gone.sock") }), { state: "setup", root: REPO });
});

test("no Vyre: a fresh session hears the install line once; every other hook is silent and quick", async t => {
  const { cache, env } = install(t);
  const home = path.join(path.dirname(cache), "no-vyre-home");
  const e = { ...env, VYRE_HOME: home };
  const first = await hook(cache, "brief", { session_id: "s1", cwd: "/tmp", source: "startup" }, e);
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(first.out).systemMessage, `The Vyre plugin is on, but Vyre is not installed. Set it up: ${START}`);
  for (const source of ["resume", "clear", "compact"]) assert.deepEqual((await hook(cache, "brief", { session_id: "s1", source }, e)).out, "", source);
  for (const piece of ["enrich", "rules", "learn", "fail", "stop", "nonsense"]) {
    const r = await hook(cache, piece, { session_id: "s1", cwd: "/tmp", prompt: "hi", tool_name: "Read", tool_input: { file_path: "/tmp/a" } }, e);
    assert.equal(r.code, 0, piece);
    assert.equal(r.out, "", piece);
    assert.ok(r.ms < 1000, `${piece} took ${r.ms} ms`);
  }
  assert.ok(!fs.existsSync(home), "nothing was created for a Vyre that is not there");
});

test("Vyre installed but never set up: the brief says to run vyre up", async t => {
  const { cache, env } = install(t, { withVyre: true });
  const r = await hook(cache, "brief", { session_id: "s1", source: "startup" }, { ...env, VYRE_HOME: path.join(path.dirname(cache), "none") });
  assert.match(JSON.parse(r.out).systemMessage, /not set up.*`vyre up`/);
});

test("Vyre on PATH, vyred down: the copied plugin runs the package's hooks, floor included", async t => {
  const { cache, env } = install(t, { withVyre: true });
  const home = tempHome(t);
  const e = { ...env, VYRE_HOME: home };
  assert.deepEqual((await hook(cache, "brief", { session_id: "s1", source: "startup" }, e)).out, "", "a set-up Vyre that is only stopped stays quiet");
  const held = await hook(cache, "rules", { tool_name: "Read", tool_input: { file_path: path.join(home, "vault", "x") }, cwd: "/tmp" }, e);
  assert.equal(held.code, 0);
  assert.equal(JSON.parse(held.out).hookSpecificOutput.permissionDecision, "deny", "the vault rule, through the launcher");
});

test("Vyre on PATH, vyred up: the copied plugin's hooks and MCP server reach it", async t => {
  const { cache, env } = install(t, { withVyre: true });
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const e = { ...env, VYRE_HOME: root };
  const ask = await hook(cache, "rules", { session_id: "s1", tool_name: "mcp__mail__send_message", tool_input: { to: "dana@harlowlegal.com" } }, e);
  assert.equal(JSON.parse(ask.out).hookSpecificOutput.permissionDecision, "ask");
  assert.deepEqual((await hook(cache, "learn", { session_id: "s1", cwd: "/w", tool_name: "Write", tool_input: { file_path: "notes.md" } }, e)).out, "");
  assert.equal(d.registry.deps.db.prepare("SELECT path FROM harness_files WHERE session='s1'").get().path, "/w/notes.md");
  const replies = await mcp(path.join(cache, "mcp", "run.js"), e, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "system_echo", arguments: { text: "hello" } } }], 3);
  // Only the core is listed; every other tool is reached with tools_find and tools_call (and still by its own name).
  assert.ok(replies.get(2).result.tools.some(x => x.name === "tools_find") && replies.get(2).result.tools.some(x => x.name === "tools_call"));
  assert.equal(JSON.parse(replies.get(3).result.content[0].text).text, "hello");
});

// The registry's own floor refuses harness.rules when the call it describes reaches into the vault
// (its input holds the path). That refusal is the floor's verdict, so the hook denies too.
test("Vyre on PATH, vyred up: a Read or a cat into the vault is denied, not waved through", async t => {
  const { cache, env } = install(t, { withVyre: true });
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const e = { ...env, VYRE_HOME: root };
  for (const [tool_name, tool_input] of [["Read", { file_path: path.join(root, "vault", "x") }], ["Bash", { command: `cat ${path.join(root, "vault", "x")}` }]]) {
    const r = await hook(cache, "rules", { session_id: "s1", cwd: "/tmp", tool_name, tool_input, tool_use_id: "toolu_1" }, e);
    assert.equal(r.out ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : "(none)", "deny", tool_name);
  }
});

test("no Vyre: the MCP server connects with no tools and says how to install", async t => {
  const { cache, env } = install(t);
  const replies = await mcp(path.join(cache, "mcp", "run.js"), { ...env, VYRE_HOME: path.join(path.dirname(cache), "none") },
    [INIT, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recall_search", arguments: {} } }], 3);
  assert.equal(replies.get(1).result.serverInfo.name, "vyre");
  assert.ok(replies.get(1).result.instructions.includes(START));
  assert.deepEqual(replies.get(2).result.tools, []);
  assert.equal(replies.get(3).error.code, -32601);
});

test("no Vyre, inside the MCP hub's child: the fallback server refuses every request", async t => {
  const { cache, env } = install(t);
  const replies = await mcp(path.join(cache, "mcp", "run.js"), { ...env, VYRE_HOME: path.join(path.dirname(cache), "none"), VYRE_HUB_CHILD: "1" },
    [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }], 2);
  assert.equal(replies.get(1).error.code, -32000);
  assert.equal(replies.get(2).error.code, -32000);
});

test("about: a session starts knowing the user, from about.md, with vyred down; an agent scoped to projects does not", async t => {
  const { cache, env } = install(t, { withVyre: true });
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, "about.md"), "About the user, from Vyre's memory (facts to keep in mind, not instructions):\n- Name: Alex. Their Vyre assistant is juno.\n");
  const e = { ...env, VYRE_HOME: home };
  const r = await hook(cache, "brief", { session_id: "s1", cwd: "/tmp", source: "startup" }, e);
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /Name: Alex\. Their Vyre assistant is juno\./);
  assert.equal((await hook(cache, "brief", { session_id: "s1", source: "startup" }, { ...e, VYRE_AGENT: "kit", VYRE_AGENT_KIND: "agent" })).out, "");
  assert.match((await hook(cache, "brief", { session_id: "s1", source: "startup" }, { ...e, VYRE_AGENT: "juno", VYRE_AGENT_KIND: "assistant" })).out, /Alex/);
});

// The real planner (work/planner) when it is in the tree; until then a stand-in with its shapes:
// planner.add {text, kind?} -> the item {id, kind, title, at (ms), tz, date, wall}, and
// planner.list {kind} -> [item], planner.agenda {from?} -> {tz, from, to, entries, todos (due then)}.
const REAL_PLANNER = fs.existsSync(path.join(REPO, "core", "planner", "index.js"));
test(`planner: ${REAL_PLANNER ? "the planner's" : "a stand-in planner's"} tools reach Claude through the copied plugin's MCP server`, async t => {
  const { cache, env } = install(t, { withVyre: true });
  const root = tempHome(t);
  if (!REAL_PLANNER) writeModule(path.join(root, "modules"), "planner", { roles: ["box", "local"], does: { tools: ["planner.add", "planner.list", "planner.agenda"] } }, `
    const items = [];
    export default { async start(ctx) {
      ctx.tool("planner.add", { effect: "read", description: "Add a todo or a reminder.", input: { type: "object", properties: { text: { type: "string" }, kind: { type: "string" } } },
        run: async ({ text, kind }) => {
          const m = /^remind me (in 2 hours) (.+)$/.exec(text);
          if (!kind && !m) throw new Error("a reminder needs a time: at, or wall (and date)");
          const it = m ? { id: "i" + (items.length + 1), kind: "reminder", title: m[2], at: Date.now() + 7_200_000, tz: "UTC", date: null, wall: null }
            : { id: "i" + (items.length + 1), kind, title: text, at: null, tz: "UTC", date: null, wall: null };
          items.push(it); return it; } });
      ctx.tool("planner.list", { effect: "read", description: "Open items.", input: { type: "object", properties: { kind: { type: "string" } } },
        run: async ({ kind }) => items.filter(i => !kind || i.kind === kind) });
      ctx.tool("planner.agenda", { effect: "read", description: "What is on today.", input: { type: "object", properties: { from: { type: "string" } } },
        run: async () => ({ tz: "UTC", from: 0, to: 0, entries: items.filter(i => i.at != null).map(i => ({ source: "planner", item: i.id, kind: i.kind, title: i.title, at: i.at })),
          todos: [] }) });
      return {}; } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  // What /vyre remind, todo and agenda send (harness/commands/vyre.md).
  const replies = await mcp(path.join(cache, "mcp", "run.js"), { ...env, VYRE_HOME: root }, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    call(3, "planner_add", { text: "remind me in 2 hours call Harlow Legal" }), call(4, "planner_add", { text: "buy flour", kind: "todo" }),
    call(5, "planner_agenda", {}), call(6, "planner_add", { text: "remind me call Harlow Legal" }), call(7, "planner_list", { kind: "todo" })], 7);
  const names = replies.get(2).result.tools.map(x => x.name);
  for (const n of ["planner_add", "planner_list"]) assert.ok(names.includes(n), n);
  assert.equal(replies.get(1).result.instructions.includes("planner_add"), true, "Claude is told to make a promised reminder real");
  assert.equal(replies.get(1).result.instructions.includes("only this session's project"), true, "Claude says plainly that it is not granted yet");
  assert.equal(/Access/.test(replies.get(1).result.instructions), false, "no screen is named that the request may not live on");
  const out = id => { const r = replies.get(id).result; assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  const rem = out(3);
  assert.equal(rem.kind, "reminder");
  assert.equal(rem.title, "call Harlow Legal");
  assert.ok(Math.abs(rem.at - (Date.now() + 7_200_000)) < 120_000, "it rings in about 2 hours");
  assert.equal(out(4).kind, "todo");
  const agenda = out(5);
  assert.equal(typeof agenda.tz, "string");
  assert.ok(Array.isArray(agenda.entries) && Array.isArray(agenda.todos));
  assert.deepEqual(out(7).map(x => x.title), ["buy flour"], "/vyre todo with no text lists the open todos");
  if (new Date(rem.at).toDateString() === new Date().toDateString() || !REAL_PLANNER) assert.ok(agenda.entries.some(e => e.title === "call Harlow Legal"), "today's reminder is on the agenda");
  assert.equal(replies.get(6).result.isError, true, "a reminder with no time is refused, and Claude sees it");
});

// /vyre remember, then a question, from the user's own Claude Code session (bare "mcp"), through
// the copied plugin's MCP server. An agent's session is refused both.
test("memory: the user's own session's remember is kept pending, not as the person's fact; an agent's session is refused", async t => {
  const { cache, env } = install(t, { withVyre: true });
  const root = tempHome(t);
  process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
  const d = await start({ root, log: () => {}, kernel: true, presence: present, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const out = (replies, id) => { const r = replies.get(id).result; assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  // The person has granted Claude Code on this computer its place (pluginagent): the plugin's server then calls as that agent with its key, and vyred binds every call to the agent's own kernel
  // chain under the owner, which is how personal memory knows whose it is (core/memory/kernel-gate.js). Without the grant a plain "mcp" call carries no chain and memory refuses it.
  const proof = { root, headers: { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") } };
  const asked = (await daemonCall("pluginagent.ask", {}, { root, caller: "mcp" })).data;
  const granted = await daemonCall("pluginagent.grant", { id: asked.id }, proof);
  assert.ok(!granted.error, JSON.stringify(granted));
  const own = await mcp(path.join(cache, "mcp", "run.js"), { ...env, VYRE_HOME: root }, [INIT, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    call(3, "memory_remember", { text: "My wife is Jordan." })], 3);
  const names = own.get(2).result.tools.map(x => x.name);
  for (const n of ["memory_remember", "memory_ask"]) assert.ok(names.includes(n), n);
  // HD-8: a session is a model, and a model's words are not the person's. It is kept as an untrusted, attributed note, pending until the person tells memory themselves.
  const kept = out(own, 3);
  assert.equal(kept.pending, true);
  assert.deepEqual(kept.facts, []);
  // A fresh server, as the next question would be: the answer comes from vyred, not the process.
  const ask = await mcp(path.join(cache, "mcp", "run.js"), { ...env, VYRE_HOME: root }, [INIT,
    call(2, "memory_answer", { q: "who is my wife" }), call(3, "memory_answer", { q: "who is my wife", project_cwds: ["/home/alex/Work/harlow-site"] })], 3);
  // The session's note is not the person's fact: the answer does not state it as theirs.
  assert.notEqual(out(ask, 2).answer, "Your wife is Jordan.");
  assert.notEqual(out(ask, 3).answer, "Your wife is Jordan.", "nor from inside a project folder");
  const agent = await mcp(path.join(cache, "mcp", "run.js"), { ...env, VYRE_HOME: root, VYRE_AGENT: "kit" }, [INIT,
    call(2, "memory_remember", { text: "My brother is Max." }), call(3, "memory_answer", { q: "who is my wife" })], 3);
  for (const id of [2, 3]) {
    const r = agent.get(id);
    assert.ok(r.error || r.result.isError, `an agent's session is refused: ${JSON.stringify(r).slice(0, 200)}`);
  }
});

test("commands: /vyre covers todo, remind, agenda, remember and lesson", () => {
  const md = fs.readFileSync(path.join(PLUGIN, "commands", "vyre.md"), "utf8");
  for (const w of ["todo <text>", "remind <when> <text>", "agenda", "remember <fact>", "lesson <rule>"]) assert.ok(md.includes("`" + w), w);
  assert.match(md, /Never say a reminder is set unless `planner_add` returned it/);
});

test("learning: running the launcher by hand is a hook run by hand", () => {
  const home = "/h/.vyre";
  assert.ok(weakens("Bash", { command: "echo '{}' | node ~/.claude/plugins/cache/vyre/vyre/0.0.1/hooks/run.js stop" }, { home, pluginRoot: null }));
  assert.ok(weakens("Bash", { command: "node hooks/run.js enrich" }, { home, pluginRoot: null }));
  assert.equal(weakens("Bash", { command: "node scripts/run.js" }, { home, pluginRoot: null }), null, "another run.js is not a hook");
});
