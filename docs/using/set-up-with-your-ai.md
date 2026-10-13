---
title: Give your own AI a key
summary: Make a named key for each of your AIs (Claude Code, Codex, an agent in another tool). It acts as you in Vyre, with the access you have, on this computer or hosted over HTTP. Settings lists the keys and revokes one with a tap.
audience: users, agents
owner: app-design
status: draft
---

# Give your own AI a key

You already have a structure of work: folders per client, instructions in `CLAUDE.md` files, months of sessions. Your own Claude Code or Codex can read all of that. Give it a key and it acts as you in Vyre: it builds the matching space and brings the old sessions in. You confirm the plan and say yes where Vyre asks.

## Make a key and name it

```
vyre mcp connect --name "Claude Code on laptop"
```

One yes on your device. The name is what you see afterwards in Activity ("via Claude Code on laptop"), in approvals and in lists, so give each AI its own. The key is shown once; only its hash is kept.

- On this computer, the key goes to a file only your user account can read, and Vyre prints the line that registers `vyre mcp`:
  - Claude Code: `claude mcp add -s user vyre -- vyre mcp`
  - Codex: `codex mcp add vyre -- vyre mcp`
- Hosted, for any MCP client anywhere (`--hosted`): Vyre gives you a URL (your server's `/mcp`, through the address you already have, so nothing to install on the client side) and the key. Ready-to-paste lines for Claude Code (`claude mcp add --transport http ...`), Codex and a generic JSON config come with it. The client sends the key as `Authorization: Bearer <key>` over streamable HTTP.

In the app, Settings > Your AI keys does the same: name, Hosted switch, copy buttons, the list of keys with where each runs and when it was last used, and Revoke. `vyre mcp list` and `vyre mcp revoke <id>` do it from the terminal.

## What a hosted key cannot do

A hosted key is reachable from the internet, so it never installs apps or runs code on your server, adds or changes accounts and connections, touches the Vault, manages computers or devices, changes people, roles or access, or makes keys. There is no prompt for this; those tools are simply refused. A key for `vyre mcp` on your own computer keeps the full reach described below.

## Revoke

Revoke is one tap and needs no yes. The key stops working at once: the next call over HTTP is a 401, and `vyre mcp` on the computer is refused.

## What a key can do

A key is you, on a key you made. It has exactly the access you have, judged by the same rules as the app, so it can do what you do in the app: make projects, agents, object types, templates and Playbooks, and file sessions in projects. It cannot do more than you can, and it serves the same tools `vyre mcp` does.

It still cannot send, publish or pay for you: those wait for your yes, like any assistant's. What you prove with a face or a key stays yours (pairing, devices, your passkey, the Vault's providers, and making or revoking keys). Each change a key makes is recorded in Activity under its name.

## Let it do the work

In a new Claude Code session, run the prompt `/mcp__vyre__setup-vyre`. In Codex, or anywhere prompts are not offered, tell it to call `mcpconn_guide` and follow it. The guide walks your AI through four steps:

1. Look. It lists the sessions on this computer (`import_sessions_list`: folder, size, date, never what was said) and reads your project folders.
2. Propose. It writes a plan per client: project, instructions, agents, objects, templates, playbooks. You correct it.
3. Make. It creates what you agreed to, in order, and tells you what is waiting on your yes.
4. Bring the sessions in. It tells you how many, how big and from where, and calls `import_sessions_run` with the sessions and the project each belongs to; sending them is held as a card for you to approve.

## Which sessions

Claude Code (`~/.claude/projects`), Codex and Gemini CLI sessions are found and converted. Grok is not supported yet. Sessions from temporary folders and from work on Vyre itself come back marked not suggested. Credential files are never listed or sent, and the server scrubs secrets from what arrives. A session you did not choose never leaves the computer. Sessions are read on the computer where the AI runs, so the import tools work with a key for that computer.

## Where it runs

A key runs as you on your Vyre. For a space on another server, name it with the tool's `space` field where it has one.
