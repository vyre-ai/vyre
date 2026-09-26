# connectors

Branch: work/connectors · Worktree: ../vyre-connectors · ADR: 0015

## Scope

Owns `core/connectors/`, `core/mcp/`, `core/google/`, `core/cli/commands/connect.js`,
`deck/views/connections.js`. Small changes by contract in `core/gate/` (a module sender),
`core/harness/rules.js` (the hub's namespace), `harness/mcp/server.js` (aggregation) and
`deck/views/settings.js` (the Connections section).

- The MCP hub (`mcp`): many servers (stdio, streamable HTTP, SSE), credentials from the vault at
  call time, per-project and per-agent scope, lazy start and idle stop, outward tools held at the
  Gate.
- One MCP entry: the harness `vyre` server aggregates hub tools; `vyre mcp` runs it on stdio.
- Native Google (`google`): calendar and mail with OAuth or a DWD service account; sends and
  invites through the Gate; `google.find` for the Capsule.
- Deck Settings, Connections; `vyre connect add|list|remove|test`.

## Done

- The MCP hub: `core/mcp/hub.js` (the Hub class, injected deps), `core/mcp/index.js` (tools and
  callers), `core/mcp/module.json`. Tests: `core/mcp/hub.test.js` (12), `core/mcp/module.test.js`
  (5, real vyred). Idle cost is zero: no timer or child exists until a server is first used.

## Doing

- ADR 0015 and the plan.

## Next

## Needs from others

## Changed contracts

- `gate.request` accepts `agent` in its input from a module caller only (core/gate/index.js), so
  the MCP hub can file a held call under the agent vyred verified for it.
