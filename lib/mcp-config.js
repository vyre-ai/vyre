// @ts-check
import path from "node:path";

/**
 * The one MCP server a Vyre-started Claude session gets: Vyre's own (the harness plugin's mcp/run.js), and none when the launch has no plugin.
 * @param {string|null|undefined} plugin the harness plugin folder
 */
export function vyreMcpConfig(plugin) {
  return plugin ? { mcpServers: { vyre: { command: "node", args: [path.join(String(plugin), "mcp", "run.js")] } } } : { mcpServers: {} };
}

