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
[CLI reference](../reference/cli.md); `vyre help` prints the same list, and `vyre help <command>`
shows one command's usage and flags.

## Where to run it

::: tabs
::: tab On a server
The host's `vyre` (in `/usr/local/bin`) is a small wrapper that runs the same CLI inside the
box's container, so every command on this page works there. The wrapper adds two of its own:

```sh
vyre update    # fetch a new release, check it, rebuild and recreate the box
vyre logs      # follow vyred's output
```

It looks for the box in `/srv/vyre`; set `VYRE_DIR` if you put it elsewhere.
::: tab On this Mac
`vyre` talks to the vyred on your Mac. `vyre box` looks after a box on a server from here:

```sh
vyre box            # which box, and whether it answers
vyre box update
vyre box backup
```

See [Box care](box-care.md).
:::

## Start Vyre and check on it

```sh
vyre up        # start vyred; print the onboarding link, or your box's address
vyre status    # is it running, which version, how many modules
vyre modules   # every module and whether it started
vyre down      # stop vyred
```

```output
  vyred running · 0.0.1 · box · pid 412 · up 3600s
  17 modules running
```

`vyre up` is safe to run any time. After an upgrade it restarts an older vyred. When it has
nothing left to set up, it prints the same "Vyre is ready" block every time.

> [!SNAG] vyre status says a module failed
> Run `vyre modules`. A failed module shows its error on its line; vyred keeps running without it.

## Open your projects

`vyre` with no arguments opens the home: every project, a new session without a project, and your
agents. Arrow keys move, typing filters, Enter opens. Picking a session resumes it in Claude Code.
Inside a project's folder, that project is preselected. Piped, it prints the list and exits.

```sh
vyre projects             # every project
vyre open harlow-intake   # what a project's threads are told, and its threads
vyre new                  # make a project by picking sessions
```

## Find something you said

```sh
vyre recall "retainer letter for Harlow Legal"
vyre threads harlow       # sessions on this machine that mention harlow
```

`vyre recall` searches every past session by meaning and by words. Its flags:

| Flag | Does |
| --- | --- |
| `--here` | only sessions run in this folder |
| `--user` | only what you typed |
| `--assistant` | only what Claude wrote |
| `--keyword` | words only, no meaning |
| `--limit <n>` | how many hits (default 10) |
| `--json` | the hits as JSON |

`vyre recall` with no words says how many sessions are indexed. `vyre index` indexes new sessions
now instead of waiting.

## Resume or start a thread in Claude Code

```sh
vyre resume <thread>      # open it where it ran, with its project's brief
vyre start                # a new thread in this folder's project
vyre context              # what a new thread here would be told
```

These hand your terminal to Claude Code until it exits. They load Vyre's hooks and tools with
`--plugin-dir`. To get the same in a `claude` you start yourself, install the Vyre plugin: see
[Vyre in Claude Code](claude-code.md).

## Drive a running session

Headless threads are sessions vyred runs in the background, so they outlive every terminal and
browser tab.

1. Start one:

   ```sh
   vyre threads start --project harlow-intake "draft the intake checklist"
   ```

   ```output
     started 3f9c2a71-...  harlow-intake · ~/Vyre/projects/harlow-intake
     vyre threads watch 3f9c2a71
   ```

   Without `--project`, it starts in the current folder (`--cwd` picks another). `--name` and
   `--model` are optional.
2. Watch it. Its recent history prints, then what it does next, until it stops or you press
   Control-C:

   ```sh
   vyre threads watch 3f9c
   ```

3. Send it more words, or answer what it asks:

   ```sh
   vyre threads send 3f9c "also add a conflicts check"
   vyre threads asks                    # what is waiting on you
   vyre threads answer <ask> allow      # or deny, with an optional message
   ```

4. Stop it: `vyre threads stop 3f9c`.

`vyre threads list` shows headless threads from the last day (`--all` for every one). A thread id
can be shortened to its first four or more characters.

Only one surface types into a session at a time. If another holds it, `send` says who;
`vyre threads lease <thread>` takes it and `vyre threads release <thread>` gives it back.

> [!SNAG] "This session is open somewhere else"
> `send` resumes a stopped session, or one you ran in a terminal, only when no other process has it
> open. Close it in the other terminal, or type there.

## Ask an agent

```sh
vyre agents                          # every agent and what it is doing
vyre agents ask juno "what is left on the intake form?"
vyre agents threads juno
vyre agents usage juno               # turns, time, tokens, spend, rate limits
```

`vyre agents ask` waits for the answer (up to ten minutes). If the agent stops on a permission
question, it prints the ask and the `vyre threads answer` line to answer it.

`vyre agents create kit --projects harlow-intake` makes an agent; see [Agents](agents.md) for
every flag.

## Ask what memory knows

```sh
vyre memory                    # what memory holds
vyre memory "Northwind Bakery" # everything about one thing
vyre why "<fact>"              # the turns a fact came from
```

To correct memory, see [Memory](memory.md).

## Use a credential without seeing it

```sh
vyre vault put stripe-key                  # prompts without echo
vyre vault run stripe-key -- npm run deploy
```

`vyre vault run` puts the value in one command's environment, named after the item
(`STRIPE_KEY`), and scrubs it from the command's output. `VAR=item.field` picks the variable name
and field. Everything else the vault does is in [Vault](vault.md).

## Script anything

Every tool Claude and the surfaces can call is callable from the terminal:

```sh
vyre tools                                   # every tool, with a line on each
vyre call projects.list
vyre call system.echo '{"text":"hi"}'
```

`vyre call` prints the tool's data as JSON, or an error with its code. A tool that needs a person
(an approval, a vault reveal) asks you to prove you are here: Touch ID when vyred offers it, or a
code typed in this terminal. `--tty` asks for the code in the terminal.

For machine-readable output from a command, use `--json` where it exists: `vyre up`,
`vyre recall` and every `vyre vault` command.

## What it will not do

- It will not take a secret on the command line, where shell history and Claude's transcript
  would see it. `vyre vault put` prompts or reads stdin.
- It will not approve anything for a script or for Claude's own shell. Approvals need a person at
  a terminal: a process with no terminal is refused.

## Next

- [CLI reference](../reference/cli.md), every command and usage line.
- [Projects and threads](projects-and-threads.md), what the project commands work on.
- [Vyre in Claude Code](claude-code.md), the plugin and `vyre statusline`.
- [Tools reference](../reference/tools.md), everything `vyre call` can run.
