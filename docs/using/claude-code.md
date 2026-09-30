---
title: Vyre in Claude Code
summary: Install the Vyre plugin in your own Claude Code for Vyre's hooks, tools, skills and /vyre command, and put Vyre's status line under every session.
audience: users
owner: docs
status: stable
---

# Vyre in Claude Code

Every thread Vyre starts already runs with Vyre's hooks and tools. The Vyre plugin brings the same
to a `claude` you start yourself, in any terminal: the security floor, your memory and lessons,
and every Vyre tool. It is the Harness (`harness/` in the Vyre repository), installed from the
`vyre` marketplace. The decision behind it is [ADR 0020](../adr/0020-claude-code-plugin.md).

## Install the plugin

Inside Claude Code:

```
/plugin marketplace add vyre-ai/vyre
/plugin install vyre@vyre
```

Or from a shell:

```sh
claude plugin marketplace add vyre-ai/vyre && claude plugin install vyre@vyre
```

New sessions load it. The plugin runs the code of the Vyre installed on your machine, so it
always matches the vyred it talks to.

## What you get

**Hooks**, each a step of the session:

| When | What the hook does |
| --- | --- |
| A session starts | Adds the brief: this folder's project and what it knows. |
| You send a prompt | Adds what memory has on it. |
| Before each tool call | Applies the [security floor](../concepts/floor.md) and your checked [lessons](learning.md). |
| After a file edit or a shell command | Notes the files the session changed. |
| At the end of a turn | Checks your lessons against what the turn did. |

**The `vyre` MCP server**, with every Vyre tool: the tools of every module vyred runs, and every
[connector](connectors.md) tool you may use. See the [tools reference](../reference/tools.md).

**Skills** Claude reaches for on its own: `write-a-watcher` (something to watch over time),
`use-the-vault` (anything that needs a credential) and `work-in-a-project` (a project, client or
earlier decision).

**The `/vyre` command:**

| Command | What it does |
| --- | --- |
| `/vyre` or `/vyre status` | What this machine runs, this folder's project, what each agent is doing, and how many things need you. |
| `/vyre ask <agent> <text>` | Asks an agent and shows its reply, for example `/vyre ask kit draft the Northwind Bakery invoice`. |
| `/vyre send <session> <text>` | Types into another session, named by its id, the first 8 characters of it, or its name. The reply streams there. |
| `/vyre recall <query>` | Searches your past sessions. |
| `/vyre project` | This folder's project brief. |
| `/vyre todo <text>` | Adds a todo. With no text, lists your open todos. |
| `/vyre remind <when> <text>` | Sets a reminder, for example `/vyre remind 6pm call Harlow Legal`, "tomorrow 9am" or "in 20 minutes". The [planner](planner.md) reads the time and says when it will ring. With no time, Claude asks for one. The reminder arrives by push, Lumen and the Deck, not in the Claude session. |
| `/vyre agenda` | Today: what is on, then your todos, overdue ones too. `/vyre agenda tomorrow` shows another day. |
| `/vyre remember <fact>` | Saves a fact about you or your work to [memory](memory.md), for every future session. A session scoped to some projects can't teach personal facts; Claude offers a lesson instead. |
| `/vyre lesson <rule>` | Makes a lesson, and says whether hooks check it or it is a reminder. |
| `/vyre lessons` | Your lessons, with how often each was applied, caught and broken. |
| `/vyre statusline` | Tells you how to put Vyre's line under every session. |

> [!SNAG] A `/vyre` command says a tool is missing
> vyred, or the module that owns the tool, is not running. Run `vyre up`, then `vyre modules` to
> see which module failed and why.

## Without Vyre on the machine

The plugin does nothing until Vyre is installed. At the start of a new session (not a resume,
`/clear` or compaction) it shows one line:

```output
The Vyre plugin is on, but Vyre is not installed. Set it up: https://vyre.run/start
```

If Vyre is installed but `vyre up` never ran, the line says to run `vyre up` instead. Every other
hook exits at once and prints nothing. The `vyre` MCP server shows as connected, with no tools.
Nothing is written to disk.

## Put Vyre's line under every session

Vyre's status line shows what needs you, whether your box answers, and what the assistant is
doing:

```output
vyre · 2 need you · box ok · juno idle
```

The line is empty while vyred is not running, and the box part appears only once this Mac is
paired with a box.

1. In your own terminal, run:

   ```sh
   vyre statusline install
   ```

2. It asks before it edits Claude Code's `settings.json` (`~/.claude/settings.json`, or the one
   under `CLAUDE_CONFIG_DIR`). Answer `y`. If the file already exists, it keeps a copy of it beside it, with
   `.vyre-backup` added to its name.
3. Start a new Claude Code session. The line is under it.

If you already have a status line, `install` changes nothing and says so. Run
`vyre statusline install --chain` to keep yours and add Vyre's line under it.

`vyre statusline uninstall` takes Vyre's line out and puts yours back. `vyre up` on a Mac, run in a
terminal, offers the status line and remembers a no. It never asks when its output is piped or
with `--json`.

> [!WHY] Why can't the plugin set the status line itself?
> Claude Code does not let a plugin set the status line: only your own `settings.json` can. Vyre
> could write that file from a hook, but that edits your setup without asking. So the plugin only
> tells you the command, and the command asks first.

## Threads Vyre starts

The threads Vyre starts (from the Deck, Chat, Lumen, an agent, `vyre start` or
`vyre resume`) load the same plugin from Vyre's own copy with `--plugin-dir`. For that session it
replaces the installed plugin, so the hooks never run twice.

## Uninstall

```
/plugin uninstall vyre@vyre
```

To drop the marketplace too:

```
/plugin marketplace remove vyre
```

Take the status line out separately with `vyre statusline uninstall`.

## What it will not do

- It never edits your Claude Code settings. Only `vyre statusline install` does, after asking.
- It does not bypass vyred's rules. A tool that needs a person (a Gate approval, a vault reveal)
  still needs one when Claude calls it.
- `/vyre lessons` never accepts, retires or loosens a lesson for you. Use
  `vyre learn accept|retire|level <id>` in your own terminal.

## Next

- [Connectors](connectors.md): MCP servers and Google accounts behind the same `vyre` server.
- [Learning](learning.md): the lessons the hooks check.
- [Memory](memory.md): what the prompt hook adds.
- [ADR 0020](../adr/0020-claude-code-plugin.md): why the plugin works this way.
