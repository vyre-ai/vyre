---
title: Connect your own AI to Vyre
summary: Connect your own Claude Code or Codex once, and it acts as you in Vyre, with the access you have. It can set your space up from the work already on your computer and bring your old sessions in. Settings lists each connection and ends it.
audience: users, agents
owner: import-mcp
status: draft
---

# Connect your own AI to Vyre

You already have a structure of work: folders per client, instructions in `CLAUDE.md` files, months of sessions. Your own Claude Code or Codex can read all of that. Once you connect it, it acts as you in Vyre and builds the matching space for you, and brings the old sessions in. You confirm the plan and say yes where Vyre asks.

## Connect it

```
vyre mcp connect
```

One yes on your device. Vyre makes a connection for this computer: a key only your user account can read, and a line in `vyre mcp list` with the client's name and when it was last used. It then prints the line that registers it:

- Claude Code: `claude mcp add -s user vyre -- vyre mcp`
- Codex: `codex mcp add vyre -- vyre mcp`

Run yours once. `vyre mcp revoke <id>` ends a connection at once, and needs no yes.

In the app, Settings > Connect your AI does the same: it shows both lines with a copy button, lists each connection with its device and when it was last used and a Revoke, and shows what your AI changed lately.

## What it can do

A connected client is you, on a connection you made. It has exactly the access you have, judged by the same rules as the app, so it can do what you do in the app: make projects, agents, record types, templates and Flows, and file sessions in projects. It cannot do more than you can.

It still cannot send, publish or pay for you: those wait for your yes, like any assistant's. What you prove with a face or a key stays yours (pairing, devices, your passkey, the Vault's providers, and connecting or revoking an AI). Each change it makes is recorded in Activity as "via your Claude Code".

## Let it do the work

In a new Claude Code session, run the prompt `/mcp__vyre__setup-vyre`. In Codex, or anywhere prompts are not offered, tell it to call `mcpconn_guide` and follow it. The guide walks your AI through four steps:

1. Look. It lists the sessions on this computer (`import_sessions_list`: folder, size, date, never what was said) and reads your project folders.
2. Propose. It writes a plan per client: project, instructions, agents, records, templates, flows. You correct it.
3. Make. It creates what you agreed to, in order, and tells you what is waiting on your yes.
4. Bring the sessions in. It tells you how many, how big and from where, and on your yes calls `import_sessions_run` with the sessions and the project each belongs to.

## Which sessions

Claude Code (`~/.claude/projects`), Codex and Gemini CLI sessions are found and converted. Grok is not supported yet. Sessions from temporary folders and from work on Vyre itself come back marked not suggested. Credential files are never listed or sent, and the server scrubs secrets from what arrives. A session you did not choose never leaves the computer.

## Where it runs

On your computer, through the Vyre running there. For a space on another server, name it with the tool's `space` field where it has one.
