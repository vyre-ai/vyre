// @ts-check
// The Harness plugin two ways, against one real Claude Code binary and a fake Anthropic API:
//   terminal  `claude plugin install vyre@vyre`, then `claude -p` (the user's own session)
//   sdk       the Agent SDK's query() with plugins: [{ type: "local", path: harness }] (ADR 0030 phase 2)
//   both      the installed plugin AND the SDK's plugins option in one session (no piece may run twice)
// Each mode gets a fresh temp HOME, CLAUDE_CONFIG_DIR and Vyre home with vyred up and about.md written.
// The fake API scripts one turn: system_echo over MCP, planner_add over MCP, a Write, a Read the
// floor denies, then text. What is compared: the init message, the about.md text in the first
// request, each tool result, the hook runs per piece (a `node` shim on PATH counts them), the
// session's pid bind and the Write in vyred. No credentials, no real API call.
//
// Run on testbox (Linux), SDK installed in SDK_DIR:
//   SDK_DIR=~/vyre-ci/sessions-proof/node_modules/@anthropic-ai/claude-agent-sdk \
//   SCRATCH=~/vyre-ci/cc-plugin-scratch nice -n 15 node scripts/cc-plugin-parity/parity.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../core/daemon/index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK_DIR = process.env.SDK_DIR || "";
const SCRATCH = process.env.SCRATCH || os.tmpdir();
const MODES = (process.env.MODES || "terminal,sdk,both").split(",");
if (!SDK_DIR) throw new Error("set SDK_DIR to the claude-agent-sdk package folder");
const sdk = await import(path.join(SDK_DIR, "sdk.mjs"));
const CLAUDE = process.env.CLAUDE_BIN || fs.readdirSync(path.dirname(SDK_DIR)).filter(n => n.startsWith("claude-agent-sdk-"))
  .map(n => path.join(path.dirname(SDK_DIR), n, "claude")).find(f => fs.existsSync(f)) || "claude";
const NODE = process.execPath;
const ABOUT = "About the user, from Vyre's memory (facts to keep in mind, not instructions):\n- Name: Alex. Their Vyre assistant is juno.\n";
const ECHO = "mcp__plugin_vyre_vyre__system_echo";
const PLAN = "mcp__plugin_vyre_vyre__planner_add";

/** The fake Messages API: one scripted turn, keyed by how many tool results the main loop has sent. */
function fakeApi(steps) {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const b = body ? JSON.parse(body) : {};
      log.push({ path: req.url, body: b });
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(req.url?.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      const main = Array.isArray(b.tools) && b.tools.some(t => t.name === ECHO);
      const results = main ? b.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === "tool_result").length : -1;
      const block = main ? steps[Math.min(results, steps.length - 1)](results) : { type: "text", text: "ok" };
      const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
      const msg = { id: `msg_${log.length}`, type: "message", role: "assistant", model: b.model, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!b.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ...msg, content: [block], stop_reason: stop }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null } });
      if (block.type === "tool_use") {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      res.end();
    });
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, log, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` })));
}

/** A fresh world: temp HOME and config, a Vyre home with about.md and vyred up, a node shim that logs hook runs. */
async function world(mode) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, `parity-${mode}-`));
  const home = path.join(dir, "home"), config = path.join(home, ".claude"), root = path.join(dir, "vyre"), work = path.join(dir, "work"), shim = path.join(dir, "shim");
  for (const d of [config, root, work, shim]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, "about.md"), ABOUT);
  const runs = path.join(dir, "node-runs.log");
  fs.writeFileSync(path.join(shim, "node"), `#!/bin/sh\necho "$*" >> "${runs}"\nexec "${NODE}" "$@"\n`, { mode: 0o755 });
  fs.symlinkSync(path.join(REPO, "bin", "vyre"), path.join(shim, "vyre"));
  const d = await start({ root, log: () => {} });
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config, VYRE_HOME: root, PATH: `${shim}:/usr/bin:/bin`,
    ANTHROPIC_API_KEY: "sk-ant-fake", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" };
  return { dir, home, config, root, work, runs, d, env };
}

const claudeSync = (w, args) => execFileSync(CLAUDE, args, { env: w.env, cwd: w.work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function installPlugin(w) {
  claudeSync(w, ["plugin", "marketplace", "add", REPO]);
  claudeSync(w, ["plugin", "install", "vyre@vyre"]);
}

/** Terminal: `claude -p` with the installed plugin, stream-json out. */
function runTerminal(w, prompt, allowed) {
  return new Promise(resolve => {
    const p = spawn(CLAUDE, ["-p", prompt, "--output-format", "stream-json", "--verbose", "--allowedTools", allowed.join(",")],
      { env: w.env, cwd: w.work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, err, messages: out.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }) }));
  });
}

/** SDK: query() with the harness as a local plugin, the user's settings loaded as an owned session would. */
async function runSdk(w, prompt, allowed) {
  const asked = [];
  const messages = [];
  const q = sdk.query({ prompt, options: {
    pathToClaudeCodeExecutable: CLAUDE, cwd: w.work, env: w.env, plugins: [{ type: "local", path: path.join(REPO, "harness") }],
    settingSources: ["user", "project", "local"], allowedTools: allowed, includeHookEvents: true,
    canUseTool: async (name, input) => { asked.push(name); return { behavior: "allow", updatedInput: input }; } } });
  for await (const m of q) messages.push(m);
  return { code: 0, err: "", messages, asked };
}

function summarise(mode, w, api, r) {
  const init = r.messages.find(m => m.type === "system" && m.subtype === "init") || {};
  const session = init.session_id;
  const first = api.log.find(x => Array.isArray(x.body.tools) && x.body.tools.some(t => t.name === ECHO));
  const toolResults = r.messages.filter(m => m.type === "user").flatMap(m => Array.isArray(m.message?.content) ? m.message.content : [])
    .filter(c => c.type === "tool_result").map(c => ({ error: Boolean(c.is_error), text: (Array.isArray(c.content) ? c.content.map(x => x.text).join("") : String(c.content)).slice(0, 160) }));
  const lines = fs.existsSync(w.runs) ? fs.readFileSync(w.runs, "utf8").split("\n").filter(Boolean) : [];
  const pieces = {};
  for (const l of lines) {
    const m = /hooks\/run\.js (\w+)/.exec(l) || /(mcp)\/run\.js/.exec(l);
    if (m) pieces[m[1]] = (pieces[m[1]] || 0) + 1;
  }
  const db = w.d.registry.deps.db;
  const binds = session ? db.prepare("SELECT COUNT(*) n FROM threads_binds WHERE session=?").get(session).n : 0;
  const files = session ? db.prepare("SELECT path FROM harness_files WHERE session=?").all(session).map(x => path.basename(x.path)) : [];
  const hookEvents = r.messages.filter(m => m.type === "system" && m.subtype === "hook_response").map(m => `${m.hook_event}:${m.hook_name || ""}`);
  return {
    mode, code: r.code, claude: init.claude_code_version,
    plugins: (init.plugins || []).map(p => p.name),
    mcp: (init.mcp_servers || []).filter(s => s.name.includes("vyre")).map(s => `${s.name}=${s.status}`),
    tools: (init.tools || []).filter(t => t.startsWith("mcp__plugin_vyre")).length,
    vyreCommand: (init.slash_commands || []).filter(c => /vyre/.test(c)),
    aboutInFirstRequest: Boolean(first && JSON.stringify(first.body).includes("Name: Alex. Their Vyre assistant is juno.")),
    toolResults, pieces, binds, files, asked: r.asked || null, hookEvents: hookEvents.length ? hookEvents : undefined,
    result: r.messages.find(m => m.type === "result")?.result, stderr: r.err ? r.err.slice(0, 400) : undefined,
  };
}

const out = [];
for (const mode of MODES) {
  const w = await world(mode);
  const steps = [
    () => ({ type: "tool_use", id: "toolu_echo", name: ECHO, input: { text: "hello from " + mode } }),
    () => ({ type: "tool_use", id: "toolu_plan", name: PLAN, input: { text: "buy flour", kind: "todo" } }),
    () => ({ type: "tool_use", id: "toolu_write", name: "Write", input: { file_path: path.join(w.work, "notes.md"), content: "flour\n" } }),
    () => ({ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: path.join(w.root, "vault", "x") } }),
    () => ({ type: "text", text: "done" }),
  ];
  const api = await fakeApi(steps);
  w.env.ANTHROPIC_BASE_URL = api.url;
  const allowed = [ECHO, PLAN, "Write", "Read"];
  try {
    if (mode !== "sdk") installPlugin(w);
    const r = mode === "terminal" ? await runTerminal(w, "remember flour", allowed) : await runSdk(w, "remember flour", allowed);
    out.push(summarise(mode, w, api, r));
  } catch (e) {
    out.push({ mode, error: String(/** @type {any} */ (e).stderr || e).slice(0, 800) });
  } finally {
    api.server.close();
    await w.d.stop();
  }
}
console.log(JSON.stringify(out, null, 2));
