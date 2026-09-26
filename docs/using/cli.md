---
title: The vyre command
summary: Do the everyday things from a terminal with vyre, from starting Vyre to resuming a thread, driving a session, asking an agent and scripting any tool.
audience: users, agents
owner: polish-cli
status: draft
---

# The vyre command

`vyre` is Vyre in a terminal. Every command is a call to vyred, the daemon on your machine, so
the terminal, the [Deck](deck.md) and the [Capsule](capsule.md) never disagree about what is
true. This page is organised by task. Every command and its usage line is in the
[CLI reference](../reference/cli.md); `vyre help` prints the same list.

On a Docker box, the host's `vyre` is a small wrapper that runs the same CLI inside the box's
container, so every command below works there too.

## Start Vyre and check on it

```
vyre up        # start vyred; print the onboarding link, or your box's address
vyre status    # is it running, which version, how many modules
vyre modules   # every module and whether it started
vyre down      # stop vyred
```

`vyre up` is safe to run any time. After an upgrade it restarts an older vyred. When it has
nothing left to set up, it prints the same "Vyre is ready" block every time.

## Open your projects

`vyre` with no arguments opens the home: every project, a new session without a project, and your
agents. Arrow keys move, typing filters, Enter opens. Picking a session resumes it in Claude Code.
Inside a project's folder, that project is preselected.

```
vyre projects             # every project
vyre open harlow-intake   # what a project's threads are told, and its threads
vyre new                  # make a project by picking sessions
```

## Find something you said

```
vyre recall "retainer letter for Harlow Legal"
vyre threads harlow       # sessions on this machine that mention harlow
```

`vyre recall` searches every past session by meaning and by words. `--here` keeps it to the
current folder's project, `--user` to what you typed, `--json` prints the result as JSON.
`vyre index` indexes new sessions now instead of waiting.

## Resume or start a thread in Claude Code

```
vyre resume <thread>      # open it where it ran, with its project's brief
vyre start                # a new thread in this folder's project
vyre context              # what a new thread here would be told
```

These hand your terminal to Claude Code until it exits.

## Drive a running session

Headless threads are sessions vyred runs in the background, so they outlive every terminal and
browser tab. Start one, send it words, watch it, answer its questions:

```
vyre threads start --project harlow-intake "draft the intake checklist"
vyre threads list
vyre threads watch <thread>
vyre threads send <thread> "also add a conflicts check"
vyre threads asks                          # what is waiting on you
vyre threads answer <ask> allow
vyre threads stop <thread>
```

A thread id can be shortened to its first four or more characters. Only one surface types into a session at a
time; if another holds it, `send` says who, and `vyre threads lease <thread>` takes it.

## Ask an agent

```
vyre agents                          # every agent and what it is doing
vyre agents ask juno "what is left on the intake form?"
vyre agents threads juno
vyre agents usage juno               # spend, turns, rate limits
```

`vyre agents create kit --projects harlow-intake --budget 20` makes an agent; see
[Agents](agents.md) for what each flag means.

## Ask what memory knows

```
vyre memory                    # what memory holds
vyre memory "Northwind Bakery" # everything about one thing
vyre why "<fact>"              # the turns a fact came from
```

To correct memory, see [Memory](memory.md).

## Use a credential without seeing it

```
vyre vault put stripe-key                  # prompts without echo
vyre vault run stripe-key -- npm run deploy
```

`vyre vault run` puts the values in one command's environment and scrubs them from its output.
Everything else the vault does is in [Vault](vault.md).

## Look after your box from the Mac

```
vyre box            # which box, and whether it answers
vyre box update
vyre box backup
```

See [Box care](box-care.md).

## Script anything

Every tool Claude and the surfaces can call is callable from the terminal:

```
vyre tools                                   # every tool, with a line on each
vyre call projects.list
vyre call system.echo '{"text":"hi"}'
```

`vyre call` prints the tool's data as JSON, or an error with its code. A tool that needs a person
(an approval, a vault reveal) asks you to prove you are here, with Touch ID or in the terminal;
`--tty` makes it ask in the terminal. Scripts that need machine-readable output from a command
can use `--json` where it exists: `vyre up`, `vyre recall` and every `vyre vault` command.

## What it will not do

- It will not take a secret on the command line, where shell history and Claude's transcript
  would see it. `vyre vault put` prompts or reads stdin.
- It will not approve anything for a script or for Claude's own shell. Approvals need a person.

Coming: one live screen for `vyre` with no arguments (what needs you, projects, sessions and
agents, with the selected session streaming), `--json` on every read, and `vyre help <command>`.

## Next

- [CLI reference](../reference/cli.md), every command and usage line.
- [Projects and threads](projects-and-threads.md), what the project commands work on.
- [Tools reference](../reference/tools.md), everything `vyre call` can run.
