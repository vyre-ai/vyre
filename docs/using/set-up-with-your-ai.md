---
title: Set up Vyre with your own AI
summary: Connect your own Claude Code or Codex to Vyre, give it a few hours of Set up mode, and let it build your projects, agents, record types and flows from the work already on your computer and bring your old sessions in.
audience: users, agents
owner: import-mcp
status: draft
---

# Set up Vyre with your own AI

You already have a structure of work: folders per client, instructions in `CLAUDE.md` files, months of sessions. Your own Claude Code or Codex can read all of that. In Set up mode it builds the matching Vyre space for you and brings the old sessions in, using Vyre's tools. You confirm the plan and say yes once.

## Connect it

```
vyre mcp connect
```

It prints two lines and runs neither:

- Claude Code: `claude mcp add -s user vyre -- vyre mcp`
- Codex: `codex mcp add vyre -- vyre mcp`

Run yours once. Your AI then reads your memory and your sessions, nothing more, the way it always could through Vyre's plugin.

## Give it a few hours

```
vyre mcp setup on
```

One yes on your device (add `--hours 8` for longer; the most is 24). Set up mode ends by itself, and `vyre mcp setup off` ends it now. `vyre mcp setup status` says where it stands. Revoking Claude Code's access ends it too.

In Set up mode your AI acts as you, with the access you have and no more. It can:

- make and rename projects, and file sessions in them;
- make and change agents, with their instructions;
- propose a Kit of record types, templates, roles and Flows, and test it. You see one install card and say yes once. Changing record types or roles directly stays yours;
- write Flows and templates. A Flow runs only after you approve it;
- find and import your old sessions (below).

It cannot send, publish or pay (those still wait for you), reach your Vault, change who has which role, or work on a project you do not hold. Each thing it does is recorded as "set up by your Claude Code".

## Let it do the work

In a new Claude Code session, run the prompt `/mcp__vyre__setup-vyre`. In Codex, or anywhere prompts are not offered, tell it to call `pluginagent_setup_guide` and follow it. The guide walks your AI through four steps:

1. Look. It lists the sessions on this computer (`import_sessions_list`: folder, size, date, never what was said) and reads your project folders.
2. Propose. It writes a plan per client: project, instructions, agents, records, templates, flows. You correct it.
3. Make. It creates what you agreed to, in order, and tells you what is waiting on your yes (the Kit card, any Flow).
4. Bring the sessions in. It tells you how many, how big and from where, and on your yes calls `import_sessions_run` with the sessions and the project each belongs to.

## Which sessions

Claude Code (`~/.claude/projects`), Codex and Gemini CLI sessions are found and converted. Grok is not supported yet. Sessions from temporary folders and from work on Vyre itself come back marked not suggested. Credential files are never listed or sent, and the server scrubs secrets from what arrives. A session you did not choose never leaves the computer.

## Where it runs

On your computer, through the Vyre running there. The tools act on the space that Vyre belongs to. For a space on another server, name it with the tool's `space` field where it has one.
