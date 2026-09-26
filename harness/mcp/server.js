#!/usr/bin/env node
// @ts-check
// The Vyre MCP server: every module tool, for Claude (docs/SPEC.md section 5.3).
//
// A stdio JSON-RPC server with no dependencies. It holds no tools of its own: it lists what
// vyred has and forwards calls, so a module added to vyred shows up here without a change.
// MCP names allow letters, digits, "_" and "-", so "recall.search" is offered as
// "recall_search". Tools named harness.* are the hooks' own and are not offered.

import readline from "node:readline";
import { request, call } from "../../core/daemon/client.js";
import { ensureUp } from "../../core/cli/daemonctl.js";
import { VERSION } from "../../core/daemon/index.js";

const PROTOCOL = "2025-06-18";
/** @type {Map<string, string>} MCP name -> Vyre tool name */
let names = new Map();

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

async function tools() {
  let r = await request("GET", "/v1/tools", undefined, { caller: CALLER });
  if (r.error && r.error.code === "unreachable") { await ensureUp(); r = await request("GET", "/v1/tools", undefined, { caller: CALLER }); }
  if (r.error) return [];
  const list = r.data.filter(offered);
  names = new Map(list.map(t => [mcpName(t.name), t.name]));
  return list.map(t => ({ name: mcpName(t.name), description: t.description || t.name, inputSchema: { type: "object", ...(t.input || {}) } }));
}

/** @param {any} msg */
async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "vyre", version: VERSION },
        instructions: "Vyre's tools: projects, recall across every past session, memory, and whatever modules this machine runs. Facts from memory come with their source; say where a fact came from when you use one." };
    case "ping": return {};
    case "tools/list": return { tools: await tools() };
    case "tools/call": {
      if (!names.size) await tools();
      const tool = names.get(params?.name) || String(params?.name || "");
      // agents.ask waits for a whole turn of another session, which can take minutes.
      const r = await call(tool, scoped(tool, params?.arguments || {}), { caller: CALLER, timeout: tool === "agents.ask" ? 600_000 : 120_000 });
      if (r.error) return { content: [{ type: "text", text: `${r.error.code}: ${r.error.message}` }], isError: true };
      return { content: [{ type: "text", text: typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2) }], structuredContent: r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : undefined };
    }
    default:
      if (id === undefined) return undefined;           // a notification: no reply
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

const send = o => process.stdout.write(JSON.stringify(o) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: /** @type {any} */ (e).code || -32603, message: /** @type {Error} */ (e).message } });
  }
});
