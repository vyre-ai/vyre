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
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../core/daemon/index.js";
import { fakeApi } from "./fake-api.mjs";

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

/** A fresh world: temp HOME and config, a Vyre home with about.md and vyred up, a node shim that logs hook runs. */
async function world(mode) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, `parity-${mode}-`));
  const home = path.join(dir, "home"), config = path.join(home, ".claude"), root = path.join(dir, "vyre"), work = path.join(dir, "work"), shim = path.join(dir, "shim");
  for (const d of [config, root, work, shim]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, "about.md"), ABOUT);
  const runs = path.join(dir, "node-runs.log");
  fs.writeFileSync(path.join(shim, "node"), `#!/bin/sh
echo "$* <- $PPID $(ps -o args= -p $PPID | cut -d" " -f1)" >> "${runs}"
exec "${NODE}" "$@"
`, { mode: 0o755 });
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
async function runSdk(w, prompt) {
  const asked = [];
  const messages = [];
  const q = sdk.query({ prompt, options: {
    pathToClaudeCodeExecutable: CLAUDE, cwd: w.work, env: w.env, plugins: [{ type: "local", path: path.join(REPO, "harness") }],
    // No allowedTools: every call reaches canUseTool, as in an owned session (ADR 0030); `allowed` is the terminal's list.
    settingSources: ["user", "project", "local"], includeHookEvents: true,
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
  // threads.bind wants the hook's parent to be claude; a /bin/sh that forks (dash) is in between.
  const parent = l => { const [pid, cmd] = (l.split(" <- ")[1] || "").split(" "); return { pid: Number(pid), cmd: path.basename(cmd || "") }; };
  const hookParent = [...new Set(lines.filter(l => l.includes("hooks/run.js")).map(l => parent(l).cmd))];
  // The MCP server reads its session key under its parent's pid: that must be the pid the brief bound.
  const mcpParent = lines.filter(l => l.includes("mcp/run.js")).map(parent);
  const db = w.d.registry.deps.db;
  const bound = session ? db.prepare("SELECT pid FROM threads_binds WHERE session=?").all(session).map(x => Number(x.pid)) : [];
  const binds = bound.length;
  const files = session ? db.prepare("SELECT path FROM harness_files WHERE session=?").all(session).map(x => path.basename(x.path)) : [];
  const hookEvents = r.messages.filter(m => m.type === "system" && m.subtype === "hook_response").map(m => `${m.hook_name}${m.stdout ? " -> " + m.stdout.slice(0, 120) : ""}`);
  return {
    mode, code: r.code, claude: init.claude_code_version,
    plugins: (init.plugins || []).map(p => p.name),
    mcp: (init.mcp_servers || []).filter(s => s.name.includes("vyre")).map(s => `${s.name}=${s.status}`),
    tools: (init.tools || []).filter(t => t.startsWith("mcp__plugin_vyre")).length,
    vyreCommand: (init.slash_commands || []).filter(c => /vyre/.test(c)),
    aboutInFirstRequest: Boolean(first && JSON.stringify(first.body).includes("Name: Alex. Their Vyre assistant is juno.")),
    toolResults, pieces, hookParent, binds, mcpParent: mcpParent.map(p => p.cmd), mcpFindsKey: mcpParent.length > 0 && mcpParent.every(p => bound.includes(p.pid)), files, asked: r.asked || null, hookEvents: hookEvents.length ? hookEvents : undefined,
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
  const api = await fakeApi(steps, { isMain: b => Array.isArray(b.tools) && b.tools.some(t => t.name === ECHO) });
  w.env.ANTHROPIC_BASE_URL = api.url;
  const allowed = [ECHO, PLAN, "Write", "Read"];
  try {
    if (mode !== "sdk") installPlugin(w);
    const r = mode === "terminal" ? await runTerminal(w, "remember flour", allowed) : await runSdk(w, "remember flour");
    out.push(summarise(mode, w, api, r));
    console.error(JSON.stringify(out.at(-1)));
  } catch (e) {
    out.push({ mode, error: String(/** @type {any} */ (e).stderr || e).slice(0, 800) });
  } finally {
    api.server.close();
    await Promise.race([w.d.stop(), new Promise(r => setTimeout(r, 5000))]);
  }
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
