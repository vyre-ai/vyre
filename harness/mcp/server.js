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

async function tools() {
  let r = await request("GET", "/v1/tools", undefined, { caller: "mcp" });
  if (r.error && r.error.code === "unreachable") { await ensureUp(); r = await request("GET", "/v1/tools", undefined, { caller: "mcp" }); }
  if (r.error) return [];
  const list = r.data.filter(t => !t.name.startsWith("harness."));
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
      const r = await call(tool, params?.arguments || {}, { caller: "mcp", timeout: 120_000 });
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
