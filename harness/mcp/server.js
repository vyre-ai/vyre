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
import { request, call } from "../../core/daemon/client.js";
import { ensureUp } from "../../core/cli/daemonctl.js";
import { VERSION } from "../../core/daemon/index.js";
import { home, paths } from "../../core/config/index.js";
import { readKey } from "../../core/switchboard/sessions.js";

const PROTOCOL = "2025-06-18";
/**
 * MCP name -> what a call runs: a Vyre module tool, or a hub tool by its aggregated name.
 * @type {Map<string, { tool: string } | { hub: string }>}
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
const DRIVES = /^(threads|agents)\./;
const offered = t => !t.name.startsWith("harness.") && !(AGENT && process.env.VYRE_AGENT_KIND !== "assistant" && DRIVES.test(t.name));
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
  let r = await request("GET", "/v1/tools", undefined, { caller: CALLER });
  if (r.error && r.error.code === "unreachable") { await ensureUp(); r = await request("GET", "/v1/tools", undefined, { caller: CALLER }); }
  if (r.error) return [];
  const list = r.data.filter(offered);
  const own = list.map(t => ({ name: mcpName(t.name), description: t.description || t.name, inputSchema: { type: "object", ...(t.input || {}) } }));
  const next = new Map(list.map(t => [mcpName(t.name), { tool: t.name }]));
  // No mcp module (no_such_tool) or any other refusal: the module tools alone, as before.
  const hub = await call("mcp.tools", {}, { caller: CALLER, session: sessionKey() });
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
  const r = await call("mcp.call", { name, arguments: args }, { caller: CALLER, session: sessionKey(), timeout: 120_000 });
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
          "When the user asks what you know about them or their work, ask memory_answer, when it is offered, before saying you do not know. " +
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
      // agents.ask waits for a whole turn of another session, which can take minutes.
      const session = sessionKey();
      const r = await call(tool, scoped(tool, params?.arguments || {}), { caller: CALLER, session, timeout: tool === "agents.ask" ? 600_000 : 120_000 });
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
  if (HUB_CHILD) { if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Vyre's MCP server does not run inside the MCP hub" } }); return; }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: /** @type {any} */ (e).code || -32603, message: /** @type {Error} */ (e).message } });
  }
});
