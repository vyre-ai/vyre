---
title: Connectors
summary: How Claude reaches Vyre's tools through Vyre's own MCP server, how your own MCP servers fit in today, and what the connectors work will add.
audience: users, builders
owner: connectors
status: draft
---

# Connectors

A connector is how a Claude Code session reaches something outside itself: Vyre's own tools, or
a service like your calendar or mail. Today Vyre ships one connector, its own MCP server, which
hands every session the tools of every module vyred runs. A hub for other MCP servers, and native
Google mail and calendar, are being built and are not on this branch yet.

## What every session already gets

Every thread Vyre starts, and every `vyre resume` or `vyre start`, loads the Vyre Harness as a
Claude Code plugin (`--plugin-dir`), so your own Claude Code setup is never changed. The Harness
brings an MCP server named `vyre`. It holds no tools of its own: it asks vyred for the tool list
and forwards each call, so a module added to vyred shows up in Claude with no change.

Tool names change one character: MCP names allow only letters, digits, `_` and `-`, so
`recall.search` is offered as `recall_search`. Tools named `harness.*` are the hooks' own and are
not offered. Inside an agent's thread, an agent that is not the assistant is not offered the tools
that drive other sessions (`threads.*`, `agents.*`), and its `recall_search` is held to its
projects' folders.

To see every tool vyred has, with its description:

```
vyre tools
```

This lists the tools under their own names (`recall.search`) and includes the `harness.*` hooks'
tools. Claude sees the same list with `.` turned into `_` and those hooks' tools left out.

> [!SNAG] A `/vyre` command says a tool is missing
> vyred, or the module that owns the tool, is not running. Run `vyre up`, then `vyre modules` to
> see which module failed and why.

The Harness also adds a `/vyre` command inside Claude Code: `/vyre status`, `/vyre project`,
`/vyre recall <query>`, `/vyre remember <text>` and `/vyre lessons`.

## Use your own MCP servers

Sessions Vyre starts load your Claude Code settings, so an MCP server you configured in Claude
Code on that machine is there in those sessions too. Configure it the way Claude Code documents.
Vyre does not manage it: its credentials, its scope and its outbound actions are outside the Vyre
Gate and [Vault](vault.md).

Two kinds of session load none of your settings and no MCP servers: quick answers from the
Capsule, and the background jobs Learning runs. They run with no tools on purpose.

## What is coming

The connectors workstream is building, on its own branch:

- an MCP hub in vyred: many servers (stdio, streamable HTTP, SSE), credentials from the Vault at
  call time, scoped per project and per agent, started on first use and stopped when idle;
- outward tools from those servers held at the Gate for your approval, like Vyre's own;
- one entry point: the Harness `vyre` server lists hub tools beside module tools, as
  `<server>__<tool>`;
- a `connect` command (add, list, remove, test) and a Connections section in Deck Settings;
- native Google mail and calendar, with sends and invites through the Gate.

None of this is on this branch. This page will describe it when it merges.

## What it will not do

- Vyre's MCP server never bypasses vyred's rules. A tool that needs a person (a Gate approval, a
  vault reveal) still needs one when Claude calls it.
- It does not offer tools from modules that are not running. Start them, then Claude sees them on
  its next tool list.

## Next

- [Tools reference](../reference/tools.md), every tool the `vyre` server offers.
- [MCP hub](../build/mcp-hub.md), for builders.
- [Modules](../concepts/modules.md), where tools come from.
