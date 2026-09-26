---
title: The MCP hub
summary: How Vyre offers every module tool to Claude through one MCP server, how it treats the other MCP servers your sessions use, and what the hub that runs MCP servers for you will add.
audience: builders, agents
owner: connectors
status: draft
---

# The MCP hub

Claude reaches Vyre through MCP. Every tool a module registers shows up in Claude Code as a tool of one MCP server, `vyre`, with no per-tool wiring. The other direction, Vyre running other MCP servers for you with credentials from the vault, is the MCP hub. The hub is being built and is not on `main` yet. This page describes what ships today and marks what does not.

## Vyre as an MCP server

The Harness plugin declares one server in `harness/.mcp.json`:

```json
{ "mcpServers": { "vyre": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"] } } }
```

`harness/mcp/server.js` is a stdio JSON-RPC server with no dependencies and no tools of its own. It lists what vyred has and forwards calls, so a module added to vyred appears in the next session without a change here.

- **Listing.** On `tools/list` it asks vyred for `GET /v1/tools` as the caller `mcp` and offers each tool with its description and input schema. If vyred is not running, it starts it and asks again.
- **Names.** MCP names allow letters, digits, `_` and `-`, so dots become underscores, cut to 64 characters: `recall.search` is `recall_search`. Claude Code shows it as `mcp__vyre__recall_search`, or `mcp__plugin_vyre_vyre__recall_search` when the plugin is installed through Claude Code's plugin system.
- **Calling.** On `tools/call` it maps the name back and posts to `/v1/tools/<tool>`. The result comes back as text (JSON, pretty-printed) and, for an object, as `structuredContent`. An error comes back as `isError` with the text `<code>: <message>`.
- **Which session.** Each call says which session it comes from, with the key the session's `SessionStart` hook was given for its `claude` process. vyred checks it and passes the verified `thread` to the tool. The key is read on every call, since `/clear` starts a new session.
- **Timeouts.** 120 seconds per call; `agents.ask` gets 10 minutes, because it waits for a whole turn of another session.
- **Changes.** `listChanged` is false. A tool added while a session runs appears in the next session.

### What is not offered

- Tools named `harness.*`: they are the hooks' own.
- Tools whose `callers` list leaves out `mcp`, and `internal` or `hook` tools.
- Inside an agent's thread, when the agent is not the assistant: `threads.*` and `agents.*`, the tools that drive other sessions.

### Inside an agent's thread

The Switchboard sets `VYRE_AGENT` and a key in the agent's environment. The server then calls as `mcp:agent:<name>`, and vyred believes that name only with the key of a live thread of that agent. `recall.search` is held to the folders of the agent's projects (`VYRE_PROJECTS`, `VYRE_SCOPE_CWDS`); an agent with no project folders searches nothing.

### Where the server is loaded

Every Claude Code session Vyre starts, from the `vyre` home, the Deck, Chat, the Capsule or an agent, runs `claude` with `--plugin-dir` pointing at `harness/`. Your global Claude Code setup is never modified. A lean one-question thread (`lean: true` on `threads.start`) loads no plugin and no MCP servers at all (`--strict-mcp-config` with no config).

## Other MCP servers your sessions use

On `main`, Vyre does not run other MCP servers. The ones in your own Claude Code setup keep working in your terminal sessions as before, and Vyre's floor watches their tools like any other:

- An MCP tool whose name means sending (`send`, `post`, `reply`, `forward`, `publish`, `share`, `invite`, `tweet`, `dm`, `comment`, and not also `draft`, `list`, `get`, `search` or `read`) is asked about in your own session, with its destination named.
- Inside an agent's thread, such a tool is denied, and the agent is told to file the send with `gate.request` so the Gate holds it for your approval.

See [the security floor](../concepts/floor.md), rules 1 and 2.

## The hub: in progress

Not on `main` yet. The connectors team is building it on its own branch, with its own ADR. The design:

- An `mcp` module that runs many MCP servers (stdio, streamable HTTP and SSE) behind Vyre, starting each only when first used and stopping it when idle.
- Credentials from the [vault](../using/vault.md) at call time, so a server's token never sits in a config file.
- Scope per project and per agent.
- Hub tools offered through the same `vyre` MCP server, so Claude sees one entry for everything.
- Tools that act outward held at the Gate for your approval.
- CLI commands to add, list, test and remove servers, and a Connections section in the Deck.

Until it merges, this section is a plan. See [connectors](../using/connectors.md) for what you can connect today.

## Next

- [Tools and events](tools-and-events.md): offering a tool Claude can call.
- [The module contract](module-contract.md): `callers`, `internal` and the checks every call passes.
- [Agents](../using/agents.md): what an agent's thread can see.
