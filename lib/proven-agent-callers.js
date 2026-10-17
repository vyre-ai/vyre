// @ts-check
// Caller labels a proven named agent uses on the MCP socket. Reach and Gate rules are the same for every provider session (Claude Code, Codex, Grok, and the rest).

/** MCP agent labels integration tests use for Gate and outward tools (provider-agnostic; the name is the agent id, not the model vendor). */
export const PROVEN_NAMED_AGENT_CALLERS = Object.freeze([
  "mcp:agent:kit",
  "mcp:agent:assistant",
  "mcp:agent:codex",
  "mcp:agent:grok",
  "mcp:agent:juno",
]);

/** Harness uses the same reach classes; live daemon Gate tests use MCP labels because they carry thread proof in meta. */
export const PROVEN_HARNESS_AGENT_CALLERS = Object.freeze([
  "harness:agent:kit",
  "harness:agent:assistant",
]);
