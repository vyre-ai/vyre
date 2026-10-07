---
title: The MCP hub
summary: How Vyre offers every module tool and every hub tool to Claude through one MCP server, and how the hub runs other MCP servers with vault credentials without ever becoming a route around the floor.
audience: builders, agents
owner: connectors
status: stable
---

# The MCP hub

Claude reaches Vyre through MCP. Every tool a module registers shows up in Claude Code as a tool of one MCP server, `vyre`, with no per-tool wiring. The other direction, Vyre running other MCP servers for you with credentials from the vault, is the MCP hub (the `mcp` module, `core/mcp/`). Its tools come through the same `vyre` server, so a session has one entry for everything.

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
- **Hub tools.** Beside the module tools it lists `mcp.tools`, from the hub's cache, so listing never starts a server. Each is named `<server>__<tool>`, which no module tool can take (module tool names have one underscore between words). A tool the hub will hold starts its description with "(held for approval) ". A call goes to `mcp.call` with the session key; a held call answers with the held item as text and in `structuredContent.held`, not as an error.
- **Changes.** `listChanged` is false. A tool added while a session runs appears in the next session.
- **`vyre mcp`.** Runs this same server on stdio for a `claude` started outside Vyre. It imports the server rather than spawning it, so the server's parent is still `claude` and it finds its session. `vyre mcp install` prints `claude mcp add -s user vyre -- vyre mcp` and runs it only with `--yes`.

### What is not offered

- Tools named `harness.*`: they are the hooks' own.
- Tools whose `callers` list leaves out `mcp`, and `internal` or `hook` tools.
- Inside an agent's thread, when the agent is not the assistant: `threads.*` and `agents.*`, the tools that drive other sessions.

### Inside an agent's thread

The Switchboard sets `VYRE_AGENT` and a key in the agent's environment. The server then calls as `mcp:agent:<name>`, and vyred believes that name only with the key of a live thread of that agent. `recall.search` is held to the folders of the agent's projects (`VYRE_PROJECTS`, `VYRE_SCOPE_CWDS`); an agent with no project folders searches nothing.

### Where the server is loaded

Every Claude Code session Vyre starts, from the `vyre` home, the Vyre app, Chat, the Capsule or an agent, runs `claude` with `--plugin-dir` pointing at `harness/`. Your global Claude Code setup is never modified. A lean one-question thread (`lean: true` on `threads.start`) loads no plugin and no MCP servers at all (`--strict-mcp-config` with no config).

Every Claude session Vyre starts, lean or not, runs with `--strict-mcp-config` and an explicit config that names only Vyre's own server (the Agent SDK path sets `strictMcpConfig` the same way). So the session never loads the connectors a Claude account carries (Gmail, Drive, Slack and the like), the person's own user-scope servers, or the servers of other plugins. A server the person wants in Vyre sessions is added through the hub, and its tools go through the Gate. Two things are outside this: a Claude session you start yourself in a terminal is your own and still loads that account's connectors, and `scripts/claude-connector-check.mjs` should be rerun after each Claude Code upgrade. Grok sessions start with Grok's import of Claude and Cursor MCP servers switched off; Codex reads only the account's own Vyre-made home.

## The hub

The `mcp` module runs any number of MCP servers (stdio, streamable HTTP and SSE) behind Vyre. People add them with `mcp.add`, `vyre connect add mcp` or the Vyre app; see [connectors](../using/connectors.md).

- **Rows hold names, never values.** A server row names vault items: `auth { type: bearer | env | oauth | service-account, item }`, and `env { VAR: item }` for a stdio server. `mcp.add` refuses a header, env value, argument or url that looks like a credential, and any `VYRE_` variable. Plain http is allowed only to this machine, the private network (100.64.0.0/10) or an origin under `mcp.httpHosts`.
- **Credentials at call time.** Values are fetched under the `mcp` grant when a server starts or a request is sent: an env for one stdio child, a header per HTTP request. A stdio child gets `PATH`, `HOME`, `LANG`, `TMPDIR`, its own env and nothing of vyred's. A 401 invalidates the token, reconnects and retries once. Every result and error is scrubbed of every value touched, and a result is cut at 256 KB.
- **Light.** Nothing starts at boot. A server starts on first use, its tools are cached, and it stops after `idle` (10 minutes by default) on one timer. A server that fails more than three times in five minutes stays failed until `mcp.restart`.
- **Scope.** A row has `scope { projects, agents }`. For a model caller, scope follows what vyred verified: the agent from its key, the thread from the session key and the thread's project from the Switchboard. A claim in the input is never used. `mcp.call` checks scope again, whatever was listed.
- **Who may manage.** `mcp.add`, `mcp.update`, `mcp.remove`, `mcp.test` and `mcp.restart` are for people and modules (`cli`, `local`, `deck`, `capsule`, `module`), never a model. `mcp.servers`, `mcp.tools` and `mcp.call` are open to all, scoped as above.

### What goes through the Gate

- A tool is a **read** when its name has a read verb (`list`, `get`, `search`, `read`, `find`, `fetch`, `query`, `describe`, `lookup`, `view`, `show`), or its annotations say `readOnlyHint: true`, and it has no send, write or delete word. Everything else is **outward**. Unknown is outward.
- A person can set `tools.mode` per tool: `read`, `write` (held) or `off` (hidden). A tool with a send word (`send`, `post`, `reply`, `forward`, `publish`, `share`, `invite`, `tweet`, `dm`, `comment`) is held whatever the mode says, and `mcp.add` refuses `read` for one.
- An outward call becomes `gate.request { kind, via: "mcp:<server>", to, content: { tool, arguments } }`. `kind` is `delete`, `spend` or `send` by the tool's name. `to` is the first of the arguments `to`, `channel`, `recipient`, `email`, `address`, `url`, else the server's name. The model gets `{ held, message }`.
- Each server is a Gate sender, `mcp:<server>`, registered with `gate.offer`. On approval the Gate calls `mcp.release` (internal, `module:gate` only), which runs exactly the approved arguments on the server the item was held for.

### Never a route around the floor

The Harness Rules ask about any MCP tool whose name means sending, and `gate.route` denies such a tool to an agent. Both step aside for `mcp__vyre__<server>__<tool>` (and `mcp__plugin_vyre_vyre__...`), because the hub already holds every such call at the Gate and its rule is stricter than the name rule. Everything else in the floor still applies to hub tools: a path or command that reaches the vault is denied whatever the tool.

That step-aside is sound only because:

- every hub tool with a send word is held, whatever the person's mode;
- Vyre's own MCP server is never a hub server: `mcp.add` refuses `vyre mcp` and `harness/mcp/server.js`, every hub child carries `VYRE_HUB_CHILD=1`, and the Vyre MCP server answers every request with an error when it sees it;
- a model can never add or change a server, release a held call or approve one.

Other MCP servers in your own Claude Code setup are not the hub's: the Rules watch their tools by name. See [the security floor](../concepts/floor.md), rules 1 and 2.

## Google

The `google` module (`core/google/`) is the other connector: Calendar and Gmail over REST with an OAuth refresh token or a domain-wide-delegation service account from the vault. It mints the narrowest scope each call needs, holds `google.mail.send` and any event with attendees at the Gate as `google:<account>`, and adds accounts through `google.add` or the `google.connect` sign-in flow. See [connectors](../using/connectors.md#connect-google-calendar-and-gmail).

## Next

- [Tools and events](tools-and-events.md): offering a tool Claude can call.
- [The module contract](module-contract.md): `callers`, `internal` and the checks every call passes.
- [Agents](../using/agents.md): what an agent's thread can see.
- [Tools reference](../reference/tools.md): every `mcp.*` and `google.*` tool.
