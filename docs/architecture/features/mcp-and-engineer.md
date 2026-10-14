---
title: MCP and the Engineer
summary: The Vyre MCP server that exposes module tools to Claude Code and other clients, the keys that let a person's own AI act as them, the MCP servers Vyre connects to, and the built-in Engineer agent.
audience: builders, agents
owner: docs
status: stable
---

# MCP and the Engineer

## What it is

Vyre speaks MCP in three directions. The Vyre MCP server (`harness/mcp/server.js`) offers Vyre's tools to Claude Code and any MCP client. The MCP hub (`core/mcp`) connects Vyre sessions to other MCP servers. Two doors (`core/mcpconn`, `core/outside`) let an AI that is not a Vyre session call in over HTTP.
The Engineer is a built-in agent that helps an owner or admin shape a Space (record types, Flows, Kits, Playbooks, agent instructions). It proposes changes and applies none.

## What a person sees

- Settings has **Your AI keys**: a person names a key for one of their AIs ("Claude Code on laptop", "Codex"), sees it once, and later sees only the name, where it is used and when. Revoking needs no presence and works at once. The name shows in Activity, approvals and lists as "via <name>".
- Settings, Connections, MCP, **Your accounts**: a team member keeps their own remote MCP servers.
- Outside agents (an AI that is not a Vyre session, registered with a token and a chosen reach) are listed and ended from the app; see [outside agents](../../using/outside-agents.md).
- The Engineer is a pinned chat next to the personal assistant (`work.chat.persistent` with kind `engineer`). Pages for Playbooks, Objects, Flows and Agents hand a request to it with a block the Engineer is told to read; its answer is a card a person approves.

## How it works

**The MCP server.** `harness/mcp/server.js` is a dependency-free stdio JSON-RPC server. It holds no tools of its own: it lists what vyred has and forwards calls, so a new module tool appears without a change here. A dot becomes an underscore (`recall.search` is offered as `recall_search`). A short core is listed (`harness/mcp/core-tools.js`: memory, recall, work, planner, flows, vault list and request, files, `team_ask`, `agents_ask`, `gate_request`, docs, skills). Everything else the caller may use is reached with `tools_find` (ranked for an intent, with an example call) and `tools_call`; both use the same call path, so scope and the Gate are unchanged. Tools whose names start with harness are the hooks and are not offered. Hub tools appear as `<server>__<tool>`.

**Who is calling.** The server picks an identity per process: inside a Vyre agent thread it is `mcp:agent:<name>`; with `VYRE_MCP_ID` and `VYRE_MCP_KEY` it is a hosted key; with the file mcp-connection.json in the home it is the person's connected AI; with the file plugin-agent.json it is the Claude Code plugin agent; otherwise a plain `mcp`. vyred binds each call to what it verified, never to a claim in the input.

**Keys (`core/mcpconn`).** Tables `mcpconn_connections` (name in `client`, `key_hash`, `hosted`, `revoked_at`) and `mcpconn_activity` (tool name and ok, never the input). `mcpconn.connect` needs presence once, makes a 32-byte key and keeps only its hash. A local key is written to the home as mcp-connection.json (mode 0600) for `vyre mcp`; a hosted key is a bearer token `<id>~<secret>`. `mcpconn.vouch` checks a key in constant time. Events: `mcpconn.connected`, `mcpconn.revoked`.

**The hosted door.** POST /mcp (`core/mcpconn/listener.js`): JSON body up to 64 KB, read within 5 seconds, one request per connection, everything else 404 or 405. Each key gets its own stdio server child, so tools and scope match `vyre mcp`. A revoked key is a 401 on the next request. It is reached through the relay's public gate or on loopback.

**What a key's call may do.** A call on a key runs on the person's own chain through the same kernel and door as the app, with the call marked as coming through a connected client. Outward acts are still held at the Gate. `core/modules/agent-reach.js` holds two lists:
- The never-list for a local key, `MCP_NEVER_PREFIXES`: `mcpconn.`, `pluginagent.`, `presence.`, `signin.`, `relay.`, `vault.`, `outside.`, `wink.`, `link.`, `spaces.devices.`, `spaces.presence.`, `spaces.identity.`, `spaces.setup.`, `memory.identity.`, `publish.decide`, plus any person-only tool whose reason names presence, devices, sign-in, secrets or keys.
- For a hosted key, an allowlist by tool name (`core/modules/hosted-allow.json`, one reason per tool) with `HOSTED_NEVER` as a second wall: code execution (`term.`, `runner.`, `agents.spawn`), desktop control, credentials and connections, devices, people and roles, and key making. A refused tool is simply refused, with no prompt. `test/hosted-keys.test.js` holds the registry equal to the allowlist, so a new tool fails CI until placed.

**Plugin agent (`core/pluginagent`).** Claude Code on a computer can ask once to read the person's memory and every project's sessions. `pluginagent.grant` (person-only, with presence) registers an agent and writes its key where only the OS user can read. It is read-only and never the person. Events: `pluginagent.asked`, `pluginagent.granted`, `pluginagent.revoked`, `pluginagent.declined`.

**Outside agents (`core/outside`).** A separate door, POST /agents-mcp (`core/outside/listener.js`): the agent is a kernel actor `ext_<id>` with no person behind it, reads only what the person granted, and every write waits at the Gate. Events: `outside.registered`, `outside.granted`, `outside.held`, `outside.refused`, `outside.revoked`.

**The hub (`core/mcp`).** Table `mcp_servers` (transport stdio, http or sse; credentials as vault item names; a scope of projects and agents). `mcp.add`, `mcp.update`, `mcp.remove` and `mcp.test` are callable only by a person or a module, never a model, and add no credential by themselves: the vault grant to `mcp` lets a value out and asks for presence. A module that is not first-party may add an http or sse server but not a command. `mcp.servers`, `mcp.tools` and `mcp.call` are scoped by the verified agent, thread and project. A held call goes to the Gate under sender `mcp:<server>`. Events: `mcp.added`, `mcp.called`, `mcp.held`, `mcp.failed` and others in `core/mcp/module.json`.

**Member MCP.** `mcp.mine.add`, `mcp.mine.list`, `mcp.mine.remove` keep a member's own servers in their personal vault (`lib/member-mcp.js`). Only remote servers are kept: https, http or sse, a named public host; a stdio entry or a local address is refused at put and dropped at read. The owner's vault and other members never see them.

**The Engineer.** Defined as `ENGINEER` in `core/agents/index.js`: a built-in agent (`builtin` column) that cannot be deleted, renamed, or given projects, credentials or a computer. Its session may call only a fixed list: Flow drafting and checking (`flows.define`, `flows.compile-text`, `flows.simulate`, `flows.test.save`), proposing (`flows.propose`, `flows.kit.propose`), Playbook tools (`work.template.define`, `work.template.test`), reads (`agents.list`, `skills.find`, `docs.find`, `docs.read`), and nothing that approves or applies. A person's yes on one card applies a change, and each applied change is a version that can be rolled back. It runs on the person's own chain and model, so it can build only what that person can. Any person may have an Engineer chat (`core/work/persistent.js`).

**A team of agents in one project (`core/team`).** A project can hold several teammates, one per role. `team.add` takes `project`, `role` and a `brief` (what work goes to this teammate), plus optional `instructions`, `tools` and `isolation`; it makes the agent `<role>-<project>`, with its own notes file as memory. A model that adds a teammate gets the default tools and models, and the approval binds the project and the role, so the person sets the rest. `team.ask` sends work to a role (`to`, `text`) and takes an optional `model`: a provider such as `codex` or `grok`, `provider/model`, or a Claude model name. That request runs in its own session on that model, through the same Gate and spend. A teammate can also hold standing duties (`team.duties.create`, in `core/team/duties.js`): a trigger, such as an event like `thread.finished`, or a schedule like `daily 07:00`, and an instruction. A duty a teammate proposes for itself starts off and does not run until a person turns it on.

A "reviewer" or a "planner" is not a named feature. A person assembles one: add a teammate with the role `reviewer` and a brief that says what to check, give it a duty on `thread.finished` that reads the finished work and files notes, and send it work with `team.ask`. The Planner module (`core/planner`) is a different thing. It keeps alarms, timers, reminders, to-dos, notes and a calendar as the Space's records and fires `planner.fired`. It is not an agent. Chat across Claude, Codex, Grok and other providers in one group chat is covered in [Sessions and models](./sessions-and-models.md).

**The builder.** `core/builder` answers `builder.build` for Publish (module-only). It builds a folder of ready files or a public GitHub repo, and with a build command it writes a Dockerfile and builds in a container; apps with their own server are refused in this release. See [Sites and publishing](./sites-and-publishing.md).

## Where the code lives

- `harness/mcp/server.js` (stdio server), `harness/mcp/core-tools.js` (listed core), `harness/mcp/memory-tools.js`, `harness/mcp/design.js`.
- `core/cli/commands/mcp.js`: `vyre mcp` and `vyre mcp install`.
- `core/mcpconn/`: person's AI keys, /mcp listener.
- `core/modules/agent-reach.js`, `core/modules/hosted-allow.json`: the never-lists and the hosted allowlist.
- `core/pluginagent/`, `core/outside/`: Claude Code plugin grant, outside agents door.
- `core/mcp/hub.js`, `core/mcp/client.js`, `core/mcp/discover.js`: the hub.
- `lib/member-mcp.js`: member's own servers.
- `core/agents/index.js`: the Engineer definition and tool list. `core/work/persistent.js`: the pinned chat.
- `core/builder/`: the publish builder.

## How agents use it

- Through MCP an agent sees the short core, then `tools_find` and `tools_call`. Calls carry the agent's identity; a tool outside its scope returns `denied`.
- Open to models: `mcp.servers`, `mcp.tools`, `mcp.call`, `agents.ask`, `team.ask`. Held: any outward act, at the Gate.
- Person or module only: `mcp.add`, `mcp.update`, `mcp.remove`, `mcpconn.connect`, `mcpconn.revoke`, `pluginagent.grant`, `outside.register`.
- The Engineer: ask it from its pinned chat; it proposes, a person approves. Docs: Tools (agent doc "tools"), Connections (agent doc "connections"), Authority (agent doc "authority"), [Claude Code](../../using/claude-code.md).

## Extend it

- In 0.5 `flows.describe`, `flows.runs` and `flows.connections` over MCP are for owners. A member's own AI account is a provider sign-in, a member's session-level MCP sign-ins last for that session, and a connected AI belongs to the person who owns the Vyre, on their own computer. 0.6 work is on the [roadmap](../../roadmap.md).
- Publishing apps with their own server depends on the setting `publish.servers`; a folder of ready files and a React page publish today.
- A custom module adds tools that every MCP client then sees, because the server lists what vyred has. The hosted allowlist places each new tool before a hosted key can call it. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).
- Another MCP server joins through the hub (`mcp.add`, by a person), with its credentials in the Vault.

## Related

- [Sessions and models](./sessions-and-models.md), [Gate](./gate.md), [Vault](./vault.md), [Kernel](./kernel.md), [Agents](./agents.md), [Flows](./flows.md), [Sites and publishing](./sites-and-publishing.md), [Spaces and members](./spaces-and-members.md), [Relay and networking](./relay-and-networking.md)
- [Architecture map](../map.md), [Architecture overview](../overview.md)
- [Outside agents](../../using/outside-agents.md), [Claude Code](../../using/claude-code.md), Connections (agent doc "connections"), [Modules reference](../../reference/modules.md)
