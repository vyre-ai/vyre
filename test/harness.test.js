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
