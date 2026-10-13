// @ts-check
// merge-mcp: a session's MCP servers: the member's own, then Vyre's entry, which wins any name clash.
/** The session's `mcpServers`: the member's own servers, then Vyre's own entry, which always wins a name clash. @param {Record<string, any>} vyre @param {{ mcpServers?: Record<string, any> } | null | undefined} member */
export function mergeMcpServers(vyre, member) {
  return { ...((member && member.mcpServers) || {}), ...vyre };
}
