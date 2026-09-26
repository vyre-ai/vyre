// @ts-check
// The Harness plugin as Claude Code runs it: hook processes fed JSON on stdin, and the MCP
// server spoken to over stdio, against a real vyred in a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness");

/** Run a process with stdin, collect stdout. */
function run(args, input, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", c => { out += c; });
    p.on("close", code => resolve({ code, out }));
    p.stdin.end(input);
  });
}
const hook = (piece, payload, env) => run([path.join(PLUGIN, "hooks", "hook.js"), piece], JSON.stringify(payload), env);

test("plugin: the manifest, hooks and MCP config are valid and point at files that exist", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "vyre");
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) {
    const file = h.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/)[1];
    assert.ok(fs.existsSync(path.join(PLUGIN, file)), `${file} is missing`);
  }
  const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".mcp.json"), "utf8"));
  assert.ok(fs.existsSync(mcp.mcpServers.vyre.args[0].replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN)));
  for (const s of fs.readdirSync(path.join(PLUGIN, "skills"))) {
    const md = fs.readFileSync(path.join(PLUGIN, "skills", s, "SKILL.md"), "utf8");
    assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: .{40,}\\n---\\n`), `skill ${s} has bad frontmatter`);
  }
});

test("hooks: with vyred down, every hook prints nothing and exits 0, except the floor", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  for (const piece of ["brief", "enrich", "learn", "stop"]) {
    const r = await hook(piece, { session_id: "s1", cwd: "/tmp", prompt: "hi", tool_name: "Edit", tool_input: { file_path: "a" } }, env);
    assert.deepEqual(r, { code: 0, out: "" }, piece);
  }
  const ok = await hook("rules", { tool_name: "Read", tool_input: { file_path: "/tmp/a" }, cwd: "/tmp" }, env);
  assert.deepEqual(ok, { code: 0, out: "" });
  const held = await hook("rules", { tool_name: "Read", tool_input: { file_path: path.join(env.VYRE_HOME, "vault", "x") }, cwd: "/tmp" }, env);
  assert.equal(held.code, 0);
  assert.equal(JSON.parse(held.out).hookSpecificOutput.permissionDecision, "deny", "the vault rule held without vyred");
});

test("hooks: with vyred down, the floor still refuses the model's routes around presence", async t => {
  const env = { VYRE_HOME: tempHome(t) };
  const routes = [`vyre call gate.approve '{"id":"g1"}'`, `curl --unix-socket ${path.join(env.VYRE_HOME, "vyred.sock")} -X POST http://x/v1/tools/gate.approve`,
    `curl -H 'x-vyre-caller: cli' http://127.0.0.1:1/v1/tools/gate.approve`];
  for (const command of routes) {
    const r = await hook("rules", { tool_name: "Bash", tool_input: { command }, cwd: "/tmp" }, env);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny", command);
  }
});

test("hooks: with vyred up, rules answer in Claude Code's shape and learn records the file", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { VYRE_HOME: root };
  const ask = await hook("rules", { session_id: "s1", tool_name: "mcp__mail__send_message", tool_input: { to: "dana@harlowlegal.com" } }, env);
  assert.deepEqual(JSON.parse(ask.out).hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(JSON.parse(ask.out).hookSpecificOutput.permissionDecision, "ask");
  assert.deepEqual(await hook("learn", { session_id: "s1", cwd: "/w", tool_name: "Write", tool_input: { file_path: "notes.md" } }, env), { code: 0, out: "" });
  assert.equal(d.registry.deps.db.prepare("SELECT path FROM harness_files WHERE session='s1'").get().path, "/w/notes.md");
  assert.deepEqual(await hook("brief", { session_id: "s1", cwd: "/w", source: "startup" }, env), { code: 0, out: "" }, "outside a project the brief is empty");
});

test("hooks: a broken lesson sends the turn back from Stop, in Claude Code's top-level shape", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { VYRE_HOME: root };
  assert.ok((await d.registry.call("learn.add", { text: "never use em dashes in anything you write" })).data.id);
  // Exactly the fields Claude Code 2.1.283 sends to a Stop hook.
  const payload = {
    session_id: "s1", transcript_path: path.join(root, "s1.jsonl"), cwd: "/w/harlow-site", prompt_id: "p1",
    permission_mode: "default", hook_event_name: "Stop", stop_hook_active: false,
    last_assistant_message: "Sure \u2014 here it is", background_tasks: [], session_crons: [],
  };
  const held = await hook("stop", payload, env);
  assert.equal(held.code, 0);
  const out = JSON.parse(held.out);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Lesson 1/);
  assert.equal(out.hookSpecificOutput, undefined, "Stop answers at the top level");
  const fixed = await hook("stop", { ...payload, stop_hook_active: true, last_assistant_message: "Sure, here it is" }, env);
  assert.deepEqual(fixed, { code: 0, out: "" });
});

test("hooks: with vyred down, the accepted lessons still hold, from the snapshot in the home", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  assert.equal((await d.registry.call("learn.add", { text: "never use em dashes in anything you write" })).data.id, 1);
  assert.equal((await d.registry.call("learn.add", { text: "update CHANGELOG.md whenever you change code" })).data.id, 2);
  await d.stop();
  const env = { VYRE_HOME: root };
  // Exactly the fields Claude Code 2.1.283 sends to a Stop hook.
  const payload = {
    session_id: "s1", transcript_path: path.join(root, "s1.jsonl"), cwd: "/w/harlow-site", prompt_id: "p1",
    permission_mode: "default", hook_event_name: "Stop", stop_hook_active: false,
    last_assistant_message: "Sure \u2014 here it is", background_tasks: [], session_crons: [],
  };
  const held = await hook("stop", payload, env);
  assert.equal(held.code, 0);
  const out = JSON.parse(held.out);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Lesson 1/);

  const w = await hook("rules", { session_id: "s1", prompt_id: "p1", cwd: "/w/harlow-site", tool_name: "Write",
    tool_input: { file_path: "/w/harlow-site/a.md", content: "Harlow \u2014 Legal" } }, env);
  assert.equal(JSON.parse(w.out).hookSpecificOutput.permissionDecision, "deny");

  const turn = { session_id: "s2", prompt_id: "p1", cwd: "/w/harlow-site" };
  assert.deepEqual(await hook("learn", { ...turn, tool_name: "Edit", tool_input: { file_path: "src/a.js", new_string: "x" } }, env), { code: 0, out: "" });
  const back = JSON.parse((await hook("stop", { ...turn, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." }, env)).out);
  assert.equal(back.decision, "block");
  assert.match(back.reason, /Lesson 2: .*src\/a\.js but not CHANGELOG\.md/);
});

test("mcp: initialize, list and call over stdio; harness tools are not offered", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "system_echo", arguments: { text: "hello" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "system_echo", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "nope" },
  ];
  const p = spawn(process.execPath, [path.join(PLUGIN, "mcp", "server.js")], { env: { ...process.env, VYRE_HOME: root } });
  const replies = new Map();
  let buf = "";
  const done = new Promise(resolve => p.stdout.on("data", c => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l); replies.set(m.id, m); }
    if (replies.size >= 5) resolve(null);
  }));
  for (const m of msgs) p.stdin.write(JSON.stringify(m) + "\n");
  await done;
  p.kill();
  assert.equal(replies.get(1).result.serverInfo.name, "vyre");
  const names = replies.get(2).result.tools.map(x => x.name);
  assert.ok(names.includes("system_echo"));
  assert.ok(!names.some(n => n.startsWith("harness_")));
  for (const n of names) assert.match(n, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(JSON.parse(replies.get(3).result.content[0].text).text, "hello");
  assert.equal(replies.get(4).result.isError, true);
  assert.equal(replies.get(5).error.code, -32601);
});

/**
 * A stand-in for `claude` that runs the Vyre SessionStart hook and then the MCP server as its own
 * children, the way Claude Code 2.1.283 does (both are direct children of the claude process).
 * It is node started through a link named `claude`, which is the name `ps` shows.
 */
const STANDIN = `
import { spawn } from "node:child_process";
const [hookJs, serverJs, session, calls] = process.argv.slice(2);
const child = (args, input) => new Promise(resolve => {
  const p = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
  let out = ""; p.stdout.on("data", c => { out += c; });
  if (input === undefined) return resolve(p);
  p.on("close", () => resolve(out)); p.stdin.end(input);
});
await child([hookJs, "brief"], JSON.stringify({ session_id: session, cwd: process.cwd(), source: "startup", hook_event_name: "SessionStart" }));
const mcp = await child([serverJs]);
const replies = new Map();
let buf = "";
mcp.stdout.on("data", c => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); } });
const rpc = (id, method, params) => new Promise(r => { replies.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
const out = [];
for (const [i, c] of JSON.parse(calls).entries()) out.push((await rpc(i + 2, "tools/call", c)).result);
mcp.kill();
process.stdout.write(JSON.stringify(out));
`;

test("sessions: an MCP call says which session it is in, and gate.request files the draft there", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com" } } } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "claude"));
  fs.writeFileSync(path.join(root, "standin.mjs"), STANDIN);
  const session = "5f0c2a61-7d7e-4c43-9a57-0b6f3d0e9a11";
  const draft = { kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Friday", body: "Hi Dana" } };
  const calls = [
    { name: "gate_request", arguments: draft },
    { name: "gate_request", arguments: { ...draft, thread: "0b1d9c7e-0000-4000-8000-000000000000" } },
  ];
  const out = await new Promise(resolve => {
    const p = spawn(path.join(bin, "claude"), [path.join(root, "standin.mjs"), path.join(PLUGIN, "hooks", "hook.js"), path.join(PLUGIN, "mcp", "server.js"), session, JSON.stringify(calls)],
      { env: { ...process.env, VYRE_HOME: root, VYRE_AGENT: "", VYRE_AGENT_KEY: "" } });
    let s = ""; p.stdout.on("data", c => { s += c; });
    p.on("close", () => resolve(JSON.parse(s)));
  });
  assert.equal(out[0].structuredContent.state, "held", JSON.stringify(out[0]));
  const held = (await d.registry.call("gate.held", {}, "local")).data;
  assert.equal(held.length, 1);
  assert.equal(held[0].thread, session, "filed under the session the call came from, which the model never named");
  assert.equal(out[1].isError, true);
  assert.match(out[1].content[0].text, new RegExp(`comes from thread ${session}; it cannot file under 0b1d9c7e`));

  // The key file is this user's alone, and the process it names is gone now: its claim is refused.
  const files = fs.readdirSync(path.join(root, "sessions"));
  assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(root, "sessions", files[0])).mode & 0o777, 0o600);
  const { key } = JSON.parse(fs.readFileSync(path.join(root, "sessions", files[0]), "utf8"));
  const { call } = await import("../core/daemon/client.js");
  const late = await call("gate.held", {}, { root, caller: "mcp", session: { id: session, key } });
  assert.equal(late.error.code, "denied");
  assert.match(late.error.message, /no running session bound with this key/);
  assert.equal((await call("gate.held", {}, { root, caller: "mcp", session: { id: session, key: "a-guess" } })).error.code, "denied");
  // Binding needs a running claude: the test process is node, and it cannot bind for itself.
  assert.match((await call("threads.bind", { session, pid: process.pid }, { root, caller: "harness" })).error.message, /not a running claude/);
  assert.equal((await call("threads.bind", { session, pid: process.pid }, { root, caller: "mcp" })).error.code, "denied");
});

test("mcp: the hub's tools are offered through the one vyre entry; a read reaches the server and a send is held", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const log = path.join(root, "fake-mcp.log");
  const fakeMcp = path.join(PLUGIN, "..", "core", "mcp", "testing", "fake-mcp.js");
  const added = await d.registry.call("mcp.add", { name: "issues", transport: "stdio", command: process.execPath, args: [fakeMcp, "--stdio"], vars: { FAKE_MCP_LOG: log } }, "cli");
  assert.equal(added.data?.test?.ok, true, JSON.stringify(added));

  const p = spawn(process.execPath, [path.join(PLUGIN, "mcp", "server.js")], { env: { ...process.env, VYRE_HOME: root, VYRE_AGENT: "", VYRE_AGENT_KEY: "" } });
  t.after(() => p.kill());
  const replies = new Map();
  let buf = "";
  p.stdout.on("data", c => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); }
  });
  const rpc = (id, method, params) => new Promise(r => { replies.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });

  const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.capabilities.tools.listChanged, false);
  const tools = (await rpc(2, "tools/list", {})).result.tools;
  const byName = new Map(tools.map(x => [x.name, x]));
  assert.ok(byName.has("system_echo"), "module tools are still offered");
  assert.ok(byName.has("issues__list_issues"));
  assert.equal(byName.get("issues__list_issues").description, "List open issues.");
  assert.match(byName.get("issues__send_message").description, /^\(held for approval\) Send a message/);
  assert.deepEqual(byName.get("issues__send_message").inputSchema.required, ["to", "text"]);
  for (const x of tools) assert.match(x.name, /^[A-Za-z0-9_-]{1,64}$/);

  const read = (await rpc(3, "tools/call", { name: "issues__list_issues", arguments: {} })).result;
  assert.equal(read.structuredContent.issues.length, 2, JSON.stringify(read));
  const echo = (await rpc(4, "tools/call", { name: "system_echo", arguments: { text: "still here" } })).result;
  assert.equal(JSON.parse(echo.content[0].text).text, "still here");

  const send = (await rpc(5, "tools/call", { name: "issues__send_message", arguments: { to: "dana@harlowlegal.com", text: "Friday works" } })).result;
  assert.ok(!send.isError, JSON.stringify(send));
  assert.match(send.content[0].text, /Held at the Gate|approve/i);
  assert.ok(send.structuredContent.held);
  const held = (await d.registry.call("gate.held", {}, "local")).data;
  assert.equal(held.length, 1);
  assert.equal(held[0].via, "mcp:issues");
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(l => l.startsWith("call "));
  assert.ok(calls.some(l => l.startsWith("call list_issues")));
  assert.ok(!calls.some(l => l.startsWith("call send_message")), "a held send never reaches the server");

  const unknown = (await rpc(6, "tools/call", { name: "nowhere__list_things", arguments: {} })).result;
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /^denied: /);
});
