#!/usr/bin/env node
// @ts-check
// The Vyre MCP server: every module tool, for Claude (docs/SPEC.md section 5.3).
//
// A stdio JSON-RPC server with no dependencies. It holds no tools of its own: it lists what
// vyred has and forwards calls, so a module added to vyred shows up here without a change.
// MCP names allow letters, digits, "_" and "-", so "recall.search" is offered as
// "recall_search". Tools named harness.* are the hooks' own and are not offered.
//
// It also offers the MCP hub's tools (ADR 0016 decision 5), from the hub's cache so listing never
// starts a server: each under its own "<server>__<tool>" name, which no module tool can take
// (those have one underscore between words), and each call goes to mcp.call. Both the listing
// and the call carry the session, so the hub scopes them by this session's project.

import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request, call } from "../../core/daemon/client.js";
import { ensureUp } from "../../core/cli/daemonctl.js";
import { VERSION } from "../../core/daemon/index.js";
import { home, paths } from "../../core/config/index.js";
import { readKey } from "../../core/switchboard/sessions.js";
import { PERSON_ONLY, HUMAN_ONLY } from "../../core/presence/index.js";
import { ALIASES, REPLACED } from "./memory-tools.js";

const PROTOCOL = "2025-06-18";
/**
 * MCP name -> what a call runs: a Vyre module tool, or a hub tool by its aggregated name.
 * @type {Map<string, { tool: string, alias?: string } | { hub: string }>}
 */
let names = new Map();
/** A model reads this first on a hub tool that goes to the Gate, so it expects to wait. */
const HELD = "(held for approval) ";

const mcpName = t => t.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

// Inside an agent's thread the switchboard sets VYRE_AGENT, VYRE_AGENT_KIND and the agent's
// scope. The caller names the agent, so vyred can refuse what it may not do; an agent that is
// not the assistant is not even offered the tools that drive other sessions; and recall.search
// is held inside the folders of the agent's projects.
const AGENT = process.env.VYRE_AGENT || "";
const CALLER = AGENT ? `mcp:agent:${AGENT}` : "mcp";
/**
 * Claude Code on this computer (core/pluginagent): once the person has granted it, the home holds plugin-agent.json ({ agent, key }, mode 0600) and this server calls as that agent with the key, so vyred
 * binds every call to the agent's own kernel token. Read on each call (the grant can come while a session runs), and never inside a session Vyre started (its own socket binds it). No file: a plain "mcp".
 * @returns {{ caller: string, headers?: Record<string, string> }}
 */
function ident() {
  if (AGENT) return { caller: CALLER };
  if (!process.env.VYRE_SOCKET) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home(), "plugin-agent.json"), "utf8"));
      if (j && /^[A-Za-z0-9_-]+$/.test(String(j.agent)) && typeof j.key === "string" && j.key) return { caller: `mcp:agent:${j.agent}`, headers: { "x-vyre-agent-key": j.key } };
    } catch { /* not granted (yet) */ }
  }
  return { caller: CALLER };
}
let asked = false;
/** Not granted yet: ask the person once for this process, in the background; the answer is read from the key file on a later call. */
function askOnce() {
  if (asked || AGENT || process.env.VYRE_SOCKET || ident().headers) return;
  asked = true;
  call("pluginagent.ask", { computer: os.hostname() }, { caller: CALLER }).catch(() => null);
}
const DRIVES = /^(threads|agents)\./;
// Nor the person's own tools (answering, approving, presence, a session's mode): vyred refuses
// them from any session, so listing them only spends the model's context.
const offered = t => !t.name.startsWith("harness.") && !PERSON_ONLY.has(t.name) && !HUMAN_ONLY.has(t.name)
  && !(AGENT && process.env.VYRE_AGENT_KIND !== "assistant" && DRIVES.test(t.name));
/** @param {string} tool @param {any} input */
function scoped(tool, input) {
  const projects = process.env.VYRE_PROJECTS;
  if (tool !== "recall.search" || !projects || projects === "*") return input;
  let cwds = [];
  try { cwds = JSON.parse(process.env.VYRE_SCOPE_CWDS || "[]"); } catch {}
  // An agent with no project folders searches nothing rather than everything.
  return { ...input, project_cwds: cwds.length ? cwds : ["/nonexistent/vyre-agent-scope"] };
}

/**
 * Outside an agent's thread, which session this is: the key the SessionStart hook of our claude
 * process (our parent) was given. Read on every call, since /clear starts a new one.
 */
const sessionKey = () => (AGENT ? null : readKey(paths(home()).sessions, process.ppid));

async function tools() {
  let r = await request("GET", "/v1/tools", undefined, ident());
  // A session's own socket (VYRE_SOCKET) is vyred's to open: never start a vyred from inside one.
  if (r.error && r.error.code === "unreachable" && !process.env.VYRE_SOCKET) { await ensureUp(); r = await request("GET", "/v1/tools", undefined, ident()); }
  if (r.error) return [];
  askOnce();
  const all = r.data.filter(offered);
  // The five memory tools go by their own names; their raw twins are not offered beside them.
  const has = new Set(all.map(t => t.name));
  const list = all.filter(t => !(REPLACED.has(t.name) && Object.values(ALIASES).some(a => a.tool === t.name)));
  const aliased = Object.entries(ALIASES).filter(([, a]) => has.has(a.tool));
  const own = list.map(t => ({ name: mcpName(t.name), description: t.description || t.name, inputSchema: { type: "object", ...(t.input || {}) } }));
  const next = new Map(list.map(t => [mcpName(t.name), { tool: t.name }]));
  for (const [name, a] of aliased) { own.push({ name, description: a.description, inputSchema: a.input }); next.set(name, { tool: a.tool, alias: name }); }
  // No mcp module (no_such_tool) or any other refusal: the module tools alone, as before.
  const hub = await call("mcp.tools", {}, { ...ident(), session: sessionKey() });
  const extra = [];
  if (!hub.error && Array.isArray(hub.data)) {
    for (const t of hub.data) {
      const name = String(t.name || "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !name.includes("__") || next.has(name)) continue;
      next.set(name, { hub: name });
      extra.push({ name, description: (t.outward ? HELD : "") + (t.description || `${t.tool} on ${t.server}`), inputSchema: { type: "object", ...(t.input || {}) } });
    }
  }
  names = next;
  return [...own, ...extra];
}

/** A hub call: the server's own MCP result as it is, or a held call said plainly. @param {string} name @param {any} args */
async function hubCall(name, args) {
  const r = await call("mcp.call", { name, arguments: args }, { ...ident(), session: sessionKey(), timeout: 120_000 });
  if (r.error) return { content: [{ type: "text", text: `${r.error.code}: ${r.error.message}` }], isError: true };
  const d = r.data;
  if (d && d.held) return { content: [{ type: "text", text: `${d.message || "Held at the Gate until the user approves it in Vyre."} (Gate item ${d.held}; nothing reached the server yet.)` }], structuredContent: { held: d.held } };
  if (d && Array.isArray(d.content)) return d;
  return { content: [{ type: "text", text: typeof d === "string" ? d : JSON.stringify(d, null, 2) }] };
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "vyre", version: VERSION },
        instructions: "Vyre's tools: projects, recall across every past session, memory, and whatever modules this machine runs. Facts from memory come with their source; say where a fact came from when you use one. " +
          "When the user asks what you know about them or their work, ask memory_ask, when it is offered, before saying you do not know. " +
          "When recall or memory finds nothing beyond this session's project and the user expected more, say so plainly: Claude Code can read only this session's project Tell them: Claude Code can read only this session's project until you allow it in Vyre. " +
          "When you promise a reminder or a todo (\"I'll remind you at 6\"), make it real with planner_add in the same turn and say when it is set. Without planner_add, say Vyre cannot remind yet rather than promise." };
    case "ping": return {};
    case "tools/list": return { tools: await tools() };
    case "tools/call": {
      if (!names.size) await tools();
      const asked = String(params?.name || "");
      const hit = names.get(asked);
      // A hub name this session has not listed yet (a server added since) still goes to the hub,
      // which checks scope itself; a module tool's name never has "__".
      if ((hit && "hub" in hit) || (!hit && asked.includes("__"))) return hubCall(asked, params?.arguments || {});
      const tool = hit && "tool" in hit ? hit.tool : asked;
      const alias = hit && "alias" in hit ? ALIASES[String(hit.alias)] : null;
      // agents.ask waits for a whole turn of another session, which can take minutes.
      const session = sessionKey();
      // Claude Code's own id for this tool call, so a tool's steps (a Glass step, a computer action)
      // link back to the chat row that caused them (vyred reads it as meta.call on a session's paths).
      const meta = params?._meta || {};
      const callId = [meta["claudecode/toolUseId"], meta.toolUseId, meta.tool_use_id].find(v => typeof v === "string" && v);
      const args = params?.arguments || {};
      const via = alias && alias.route && alias.route.when(args, process.env) ? alias.route : null;
      const sent = via ? via.tool : tool;
      const r = await call(sent, scoped(sent, via ? via.map(args, process.env) : alias ? alias.map(args, process.env) : args), { ...ident(), session, timeout: tool === "agents.ask" ? 600_000 : 120_000,
        ...(callId ? { headers: { "x-vyre-call-id": callId } } : {}) });
      if (r.error) return { content: [{ type: "text", text: `${r.error.code}: ${r.error.message}` }], isError: true };
      return { content: [{ type: "text", text: typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2) }], structuredContent: r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : undefined };
    }
    default:
      if (id === undefined) return undefined;           // a notification: no reply
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

const send = o => process.stdout.write(JSON.stringify(o) + "\n");
// Started by the MCP hub (ADR 0016): vyred's own child with no session, where an agent's scope
// would be lost. Every request is refused, no tool is offered and vyred is never contacted.
const HUB_CHILD = Boolean(process.env.VYRE_HUB_CHILD);
readline.createInterface({ input: process.stdin }).on("line", async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  // JSON that is not a request object (null, a number, an array): refused, never dereferenced.
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
  if (HUB_CHILD) { if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Vyre's MCP server does not run inside the MCP hub" } }); return; }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: /** @type {any} */ (e).code || -32603, message: /** @type {Error} */ (e).message } });
  }
});
