// @ts-check
// The Harness plugin as Claude Code runs it: hook processes fed JSON on stdin, and the MCP
// server spoken to over stdio, against a real vyred in a temp home.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { interactiveFrom } from "../core/harness/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { socketPath } from "../core/config/index.js";
import { tempHome } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";

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
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.match(hooks.PostToolUse[0].matcher, /\bBash\b/, "PostToolUse hears Bash too");
  assert.match(hooks.PostToolUseFailure[0].matcher, /\bBash\b/);
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
  for (const piece of ["brief", "enrich", "learn", "fail", "stop"]) {
    const r = await hook(piece, { session_id: "s1", cwd: "/tmp", prompt: "hi", tool_name: "Edit", tool_input: { file_path: "a" }, tool_use_id: "toolu_1", error: "boom" }, env);
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

test("hooks: PostToolUseFailure and PostToolUse on Bash reach Learning as failed, then fixed", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { VYRE_HOME: root };
  const base = { session_id: "s1", cwd: "/w", prompt_id: "p1" };
  await hook("enrich", { ...base, prompt: "fix the build" }, env);
  const pre = id => hook("rules", { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: id }, env);
  await pre("toolu_1");
  // Exactly the fields Claude Code 2.1.283 sends to a PostToolUseFailure hook.
  const fail = await hook("fail", { ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" },
    tool_use_id: "toolu_1", error: "Exit code 1\n1 failing test", is_interrupt: false, duration_ms: 812 }, env);
  assert.deepEqual(fail, { code: 0, out: "" });
  await pre("toolu_2");
  await hook("learn", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_2", tool_response: { stdout: "ok" } }, env);
  const db = d.registry.deps.db;
  assert.deepEqual(db.prepare("SELECT kind FROM learn_signals WHERE kind IN ('failed','fixed') ORDER BY id").all().map(r => r.kind), ["failed", "fixed"]);
  assert.ok(!db.prepare("SELECT 1 FROM learn_signals WHERE meta LIKE '%failing%' OR text LIKE '%failing%'").get(), "the error itself is never kept");
  assert.deepEqual(db.prepare("SELECT id, outcome FROM learn_calls ORDER BY id").all().map(r => [r.id, r.outcome]), [["toolu_1", "failed"], ["toolu_2", "ok"]]);
});

test("hooks: a broken lesson sends the turn back from Stop, in Claude Code's top-level shape", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { VYRE_HOME: root };
  assert.ok((await call("learn.add", { text: "never use em dashes in anything you write" }, { root, caller: "cli", timeout: 20_000 })).data.id);
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
  assert.equal((await call("learn.add", { text: "never use em dashes in anything you write" }, { root, caller: "cli", timeout: 20_000 })).data.id, 1);
  assert.equal((await call("learn.add", { text: "update CHANGELOG.md whenever you change code" }, { root, caller: "cli", timeout: 20_000 })).data.id, 2);
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

test("hooks: with vyred down and lessons.json deleted, the lessons still hold, read from vyre.db", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  assert.equal((await call("learn.add", { text: "never use em dashes in anything you write" }, { root, caller: "cli", timeout: 20_000 })).data.id, 1);
  await d.stop();
  fs.rmSync(path.join(root, "lessons.json"));
  const env = { VYRE_HOME: root };
  const w = await hook("rules", { session_id: "s1", prompt_id: "p1", cwd: "/w/harlow-site", tool_name: "Write",
    tool_input: { file_path: "/w/harlow-site/a.md", content: "Harlow \u2014 Legal" } }, env);
  assert.equal(JSON.parse(w.out).hookSpecificOutput.permissionDecision, "deny");
  const g = await hook("rules", { session_id: "s1", prompt_id: "p1", cwd: "/w/harlow-site", tool_name: "Bash",
    tool_input: { command: `echo '{}' > ${root}/lessons.json` } }, env);
  assert.equal(JSON.parse(g.out).hookSpecificOutput.permissionDecision, "deny", "rewriting the snapshot is refused, offline too (the floor, ADR 0004)");
  const back = await hook("stop", { session_id: "s1", prompt_id: "p1", cwd: "/w/harlow-site", hook_event_name: "Stop", stop_hook_active: false,
    last_assistant_message: "Sure \u2014 here it is" }, env);
  assert.equal(JSON.parse(back.out).decision, "block");
});

test("hooks: with vyred down and no lesson, running a hook by hand and changing the loaded hooks are still asked", async t => {
  const root = tempHome(t);
  // The loaded plugin lives outside the Vyre home, as it does for a user: inside it, the floor
  // (ADR 0004) would deny it as Vyre's own state before the hooks' guard could ask.
  const plugin = fs.mkdtempSync(path.join(SCRATCH, "vyre-plugin-"));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const env = { VYRE_HOME: root, CLAUDE_PLUGIN_ROOT: plugin };
  const rules = async tool_input => {
    const r = await hook("rules", { session_id: "s1", prompt_id: "p1", cwd: plugin, tool_name: tool_input.command ? "Bash" : "Edit", tool_input }, env);
    return r.out ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : null;
  };
  assert.equal(await rules({ command: "echo '{\"prompt\":\"no\"}' | node ./hooks/hook.js enrich" }), "ask");
  assert.equal(await rules({ file_path: path.join(plugin, "hooks", "hooks.json") }), "ask");
  assert.equal(await rules({ command: `sqlite3 ${root}/vyre.db 'delete from learn_lessons'` }), "deny", "the floor refuses Vyre's store outright");
  assert.equal(await rules({ command: "npm test" }), null);
});

test("interactiveFrom: a claude with a terminal and no -p, --print, --output-format or --input-format", () => {
  for (const l of ["ttys012  claude", "ttys012  claude --resume abc --dangerously-skip-permissions", "pts/3 /home/a/.local/bin/claude -c", "ttys001 claude -- -p"]) assert.equal(interactiveFrom(l), true, l);
  for (const l of ["??       claude", "?  claude", "ttys001 claude -p", "ttys001 claude --print hi", "ttys001 claude -cp", "ttys001 claude --output-format stream-json",
    "ttys001 claude --output-format=json", "ttys001 claude --input-format stream-json", "ttys001 /bin/zsh -c node hook.js enrich", "ttys001 node hook.js", "", "ttys001"]) assert.equal(interactiveFrom(l), false, l);
});

/**
 * Run a hook as Claude Code does, as the child of a process that `ps` shows as `claude`: a
 * symlink to node named claude, in a pseudo-terminal from script(1) when tty is true (so it has a
 * controlling terminal, as a person's claude does), detached with none when false.
 */
async function hookUnder(t, dir, { tty, args = [], env = {} }, piece, payload) {
  const claude = path.join(dir, "claude");
  if (!fs.existsSync(claude)) {
    fs.symlinkSync(process.execPath, claude);
    fs.writeFileSync(path.join(dir, "parent.mjs"), `import { spawn } from "node:child_process"; import fs from "node:fs";
const p = spawn(process.execPath, [process.env.HOOK, process.env.PIECE], { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
let out = ""; p.stdout.on("data", c => { out += c; }); p.on("close", () => fs.writeFileSync(process.env.HOOK_OUT, out)); p.stdin.end(process.env.HOOK_IN);`);
  }
  const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
  const cmd = [claude, path.join(dir, "parent.mjs"), ...args];
  const e = { ...process.env, ...env, HOOK: path.join(PLUGIN, "hooks", "hook.js"), PIECE: piece, HOOK_IN: JSON.stringify(payload), HOOK_OUT: out };
  const [bin, argv] = !tty ? [cmd[0], cmd.slice(1)] : process.platform === "darwin" ? ["script", ["-q", "/dev/null", ...cmd]] : ["script", ["-qec", cmd.join(" "), "/dev/null"]];
  await new Promise(resolve => { const p = spawn(bin, argv, { env: e, stdio: ["ignore", "ignore", "ignore"], detached: !tty }); p.on("close", resolve); p.on("error", resolve); });
  const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  return text ? JSON.parse(text).hookSpecificOutput.additionalContext : "";
}

test("hooks: a plain yes accepts a lesson only when a person typed it into an interactive claude", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const root = tempHome(t);
  // HD-4b: the person's "yes" counts only when the session's own transcript has it as the last user line; Claude Code writes that line, a model cannot.
  const projects = path.join(root, "claude-projects");
  fs.mkdirSync(path.join(projects, "-w"), { recursive: true });
  fs.writeFileSync(path.join(projects, "-w", "s1.jsonl"), JSON.stringify({ type: "user", sessionId: "s1", cwd: "/w", message: { role: "user", content: "yes" } }) + "\n");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [projects] }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { VYRE_HOME: root, VYRE_THREAD: "", VYRE_AGENT: "" };
  const dir = fs.mkdtempSync(path.join(root, "pty-"));
  const status = () => d.registry.deps.db.prepare("SELECT status FROM learn_lessons WHERE id = 1").get().status;
  let n = 0;
  /** Tell the proposal in one turn (a plain hook run), then answer yes in the next, under `under`. */
  const tellThenYes = async under => {
    const told = `p${++n}`, yes = `p${++n}`;
    await hook("enrich", { session_id: "s1", cwd: "/w", prompt_id: told, prompt: "never use em dashes in anything you write" }, env);
    await hook("stop", { session_id: "s1", cwd: "/w", prompt_id: told, last_assistant_message: "Keep it?", stop_hook_active: false }, env);
    const text = await hookUnder(t, dir, { ...under, env: { ...env, ...(under.env || {}) } }, "enrich", { session_id: "s1", cwd: "/w", prompt_id: yes, prompt: "yes" });
    await hook("stop", { session_id: "s1", cwd: "/w", prompt_id: yes, last_assistant_message: "ok", stop_hook_active: false }, env);
    return text;
  };
  const refused = /did not accept lesson 1.*vyre learn accept 1/;
  assert.match(await tellThenYes({ tty: true, args: ["-p"] }), refused, "claude -p");
  assert.match(await tellThenYes({ tty: true, args: ["--print"] }), refused, "claude --print");
  assert.match(await tellThenYes({ tty: true, args: ["--output-format", "stream-json"] }), refused, "stream-json output");
  assert.match(await tellThenYes({ tty: true, args: ["--input-format", "stream-json"] }), refused, "stream-json input (the Switchboard's threads)");
  assert.match(await tellThenYes({ tty: true, env: { VYRE_THREAD: "s1" } }), refused, "our own headless thread");
  assert.match(await tellThenYes({ tty: false }), refused, "no terminal");
  assert.equal(status(), "proposed");
  // Only the hook of the person's own Claude Code (the surface `harness`, no agent, no thread, the transcript's own line) may set typedBy: the same enrich call from any other surface, or an assistant's label, changes nothing,
  // and no other harness tool takes a yes at all.
  for (const caller of ["mcp", "cli", "hook", "module:x", "tailnet:alex", "mcp:agent:kit", "harness:agent:juno", "cli agent:kit", "deck"]) {
    await d.registry.call("harness.enrich", { session: "s1", cwd: "/w", prompt_id: `p-x-${caller}`, prompt: "yes", interactive: true }, caller);
    assert.equal(status(), "proposed", `${caller} cannot make a plain yes count`);
  }
  await d.registry.call("harness.stop", { session: "s1", cwd: "/w", prompt_id: "p-x-stop", last_assistant_message: "yes", interactive: true }, "harness");
  assert.equal(status(), "proposed", "a harness event that is not the prompt cannot make a yes count");
  assert.match(await tellThenYes({ tty: true }), /The user said yes: lesson 1 is in force now/, "a person at an interactive claude");
  assert.equal(status(), "active");
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

/** Talk JSON-RPC to Vyre's MCP server over stdio. */
function entry(t, env) {
  const p = spawn(process.execPath, [path.join(PLUGIN, "mcp", "server.js")], { env: { ...process.env, ...env } });
  t.after(() => p.kill());
  const replies = new Map();
  let buf = "";
  p.stdout.on("data", c => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); }
  });
  let n = 0;
  /** @returns {Promise<any>} */
  const rpc = (method, params) => new Promise(r => { const id = ++n; replies.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const notify = method => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { rpc, notify };
}

test("mcp: the hub is never a route around the floor", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  // A presence that records every prompt and answers no, until a person is there.
  const prompts = [];
  let here = false;
  const presence = {
    required: (tool, def) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence),
    verify: async ({ tool, caller }) => { prompts.push(`${tool} ${caller}`); return here ? { ok: true, method: "test" } : { ok: false, message: "nobody is there" }; },
    challenge: async () => ({ error: { code: "bad_input", message: "no challenge in this test" } }),
  };
  const d = await start({ root, presence, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => d.registry.call(tool, input, "cli");
  const log = path.join(root, "fake-mcp.log");
  const fakeMcp = path.join(PLUGIN, "..", "core", "mcp", "testing", "fake-mcp.js");
  const chat = { name: "chat", transport: "stdio", command: process.execPath, args: [fakeMcp, "--stdio"], vars: { FAKE_MCP_LOG: log } };
  const added = await cli("mcp.add", { ...chat, tools: { mode: { echo_env: "read" } } });
  assert.equal(added.data?.test?.ok, true, JSON.stringify(added));
  const calls = () => fs.readFileSync(log, "utf8").split("\n").filter(l => l.startsWith("call "));
  const sent = () => calls().filter(l => l.startsWith("call send_message"));

  // Through the one vyre entry, as a model in a person's session.
  const { rpc } = entry(t, { VYRE_HOME: root, VYRE_AGENT: "", VYRE_AGENT_KEY: "" });
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const listed = (await rpc("tools/list", {})).result.tools.map(x => x.name);
  for (const x of ["mcp_add", "mcp_update", "mcp_remove", "mcp_release"]) assert.ok(!listed.includes(x), `${x} is offered to a model`);
  const via = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  for (const [tool, args] of [["mcp.add", { ...chat, name: "sneaky" }], ["mcp.update", { name: "chat", tools: {} }], ["mcp.remove", { name: "chat" }]]) {
    const r = await via(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.content[0].text, /^denied: /, tool);
  }
  assert.match((await via("mcp.release", { id: "g-1", content: {} })).content[0].text, /^no_such_tool: /);

  // A hub send is held, and nothing reaches the server.
  const send = await via("chat__send_message", { to: "dana@harlowlegal.com", text: "Friday works" });
  const id = send.structuredContent?.held;
  assert.ok(id, JSON.stringify(send));
  assert.deepEqual(sent(), []);
  assert.match((await via("gate.approve", { id })).content[0].text, /^denied: gate.approve is not available to mcp callers/, "the model approves its own send");
  assert.deepEqual(sent(), []);

  // The same, as an agent vyred verified.
  const juno = (tool, input) => d.registry.call(tool, input, "mcp:agent:juno", { agent: "juno", thread: "t-1" });
  for (const [tool, args] of [["mcp.add", { ...chat, name: "sneaky" }], ["mcp.update", { name: "chat", tools: {} }], ["mcp.remove", { name: "chat" }]])
    assert.equal((await juno(tool, args)).error?.code, "denied", tool);
  assert.equal((await juno("mcp.release", { id, content: {} })).error?.code, "no_such_tool");
  assert.equal((await juno("gate.approve", { id })).error?.code, "denied");
  assert.deepEqual(sent(), []);

  // A person without presence cannot approve either; with it, the send reaches the server once.
  assert.equal((await cli("gate.approve", { id })).error?.code, "presence_required");
  assert.deepEqual(sent(), []);
  here = true;
  const ok = await cli("gate.approve", { id });
  assert.equal(ok.data?.state, "sent", JSON.stringify(ok));
  assert.deepEqual(sent(), [`call send_message ${JSON.stringify({ to: "dana@harlowlegal.com", text: "Friday works" })}`]);
  here = false;
  // A model's approval is refused before presence is even asked; a person's is asked each time.
  assert.deepEqual(prompts, ["gate.approve cli", "gate.approve cli"], "only a person's approvals asked, and nothing else did");

  // A person cannot mark a send as a read, at add or at update.
  const always = /send_message sends as the person, so it is always held and cannot be read: set send_message to write or off/;
  assert.match((await cli("mcp.add", { ...chat, name: "chat-two", tools: { mode: { send_message: "read" } } })).error?.message, always);
  assert.match((await cli("mcp.update", { name: "chat", tools: { mode: { send_message: "read" } } })).error?.message, always);
  assert.equal((await cli("mcp.update", { name: "chat", tools: { mode: { send_message: "write", echo_env: "read" } } })).data?.name, "chat");

  // Vyre's own MCP server is never a hub server, and VYRE_ settings are Vyre's.
  const own = /that is Vyre's own MCP server; its tools are already offered through the one vyre entry/;
  assert.match((await cli("mcp.add", { name: "loop", transport: "stdio", command: path.join(PLUGIN, "..", "bin", "vyre"), args: ["mcp"] })).error?.message, own);
  assert.match((await cli("mcp.add", { name: "loop", transport: "stdio", command: process.execPath, args: [path.join(PLUGIN, "mcp", "server.js")] })).error?.message, own);
  assert.match((await cli("mcp.add", { ...chat, name: "loop", vars: { VYRE_HOME: root } })).error?.message, /VYRE_ settings belong to Vyre, not a server/);
  assert.match((await cli("mcp.update", { name: "chat", vars: { VYRE_HUB_CHILD: "" } })).error?.message, /VYRE_ settings belong to Vyre/);
  assert.deepEqual((await cli("mcp.servers")).data.map(x => x.name), ["chat"]);

  // Every hub child carries VYRE_HUB_CHILD, and Vyre's server run under it refuses everything
  // without reaching vyred: in a home with no vyred, none is started.
  assert.equal((await cli("mcp.call", { server: "chat", tool: "echo_env", arguments: { name: "VYRE_HUB_CHILD" } })).data?.structuredContent?.set, true);
  const empty = fs.mkdtempSync(path.join(SCRATCH, "vyre-hubchild-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const child = entry(t, { VYRE_HOME: empty, VYRE_HUB_CHILD: "1" });
  child.notify("notifications/initialized");
  const refusal = { code: -32000, message: "Vyre's MCP server does not run inside the MCP hub" };
  const init = await child.rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.deepEqual([init.error, init.result], [refusal, undefined]);
  const list = await child.rpc("tools/list", {});
  assert.deepEqual([list.error, list.result], [refusal, undefined], "no tools are listed");
  assert.deepEqual((await child.rpc("tools/call", { name: "system_echo", arguments: {} })).error, refusal);
  assert.equal(fs.existsSync(socketPath(empty)), false, "it started or reached a vyred");
  assert.deepEqual(fs.readdirSync(empty), []);
});
