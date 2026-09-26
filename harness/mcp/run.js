#!/usr/bin/env node
// @ts-check
// The `vyre` MCP server starts here. With Vyre on this machine it runs that package's server.js.
// Without it, it is an MCP server with no tools whose instructions say how to install Vyre, so
// Claude Code shows the server as connected rather than failed, and Claude can tell the user.

import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { locate, hint } from "../lib/vyre.js";

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { state, root } = locate(pluginRoot);

if (state === "ready" && root) {
  await import(pathToFileURL(path.join(root, "harness", "mcp", "server.js")).href);
} else {
  const text = hint(/** @type {"setup"|"missing"} */ (state));
  const send = (/** @type {any} */ o) => process.stdout.write(JSON.stringify(o) + "\n");
  readline.createInterface({ input: process.stdin }).on("line", line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg || {};
    if (id === undefined) return;
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vyre", version: "0.0.0" }, instructions: `${text} Until then this server offers no tools.` } });
    } else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [] } });
    else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
    else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `${text}` } });
  });
}
