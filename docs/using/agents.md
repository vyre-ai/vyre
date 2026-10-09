---
title: Agents
summary: How to talk to your assistant, make agents that run on your own server with your own Claude quota, keep them inside the projects you choose, give them their own computer, and see what they cost.
audience: users, agents
owner: docs
status: stable
---

# Agents

An **agent** is a named record that says how Vyre should run sessions for you on your own
server: which credentials, which projects, what instructions. Its work happens in ordinary
headless threads that Vyre owns, so each one keeps running after you close a window or turn off
your laptop, streams to every surface, and routes its permission questions to wherever you are,
your phone included. An agent's sessions start on Claude. When Claude's usage runs out, the
session can move to Codex, Grok or OpenRouter if you set a fallback order for the agent (see
[Sessions](sessions.md#one-picker-per-session)). Every install has one special agent, **the assistant**, made at onboarding. You can make
others, such as a research agent or a bookkeeping agent.

| | The assistant | Other agents |
| --- | --- | --- |
| How many | exactly one | as many as you make |
| Projects it can see | every project (`"*"`) | only the ones in its list |
| Can start, drive and stop other sessions | yes, through the `threads.*` and `agents.*` tools | no |
| Where it works | its own folder under Vyre's home | its project's home when it has one project, else its own folder |
| Its computer | can name any agent's computer | its own computer only |

An agent never draws context from a project outside its list: its brief, its prompt hints and its
`recall.search` stay inside those projects' folders.

## Talk to the assistant or an agent

From Lumen, press Control twice and type. The assistant is the default destination; type
`@` to pick another agent, a project or a thread. The "Sends to" row shows where Enter will send
before anything goes.

From the terminal:

```sh
vyre agents ask juno "What changed in the Juniper Studio project this week?"
```

```output
  juno › Two threads ran in Juniper Studio this week: ...
  thread 3f9c2a71 · $0.0123
```

`vyre agents ask` waits up to ten minutes for the reply. Or run `vyre` with no arguments, pick an
agent under **Agents**, and talk a line at a time. An empty line goes back to the list.

In the Vyre app, open **Assistants** (`/u/assistants`) for every assistant and agent and what it
is doing. **Open** one for its page: a line to talk to it, what wakes it, its usage, its model and
its computer. **Search** (Command-K) asks the assistant what you type, and `@kit ...` there asks kit.

If an agent stops on a permission question, the reply says so and names the question. Answer it
from any surface; in the terminal:

```sh
vyre threads answer <ask> allow
```

The tool is `agents.ask {agent, text}`. It sends to the agent's current thread, resumes it if it
stopped, and starts one if there is none.

## Run an agent on your own quota

Agents run on your own Claude credentials, kept in the [Vault](vault.md) and set only in that
agent's own child process. Two kinds of item work:

- **A subscription setup token** from `claude setup-token`, stored as a `secret`. Onboarding runs
  `claude setup-token` for you and stores the result as `claude-setup-token`.
- **An Anthropic API key**, stored as an `api-key`. Onboarding names this one `anthropic-api-key`.

The subscription is used first. When its limit is reached and the agent has an API key as a
fallback, the thread switches to the key and says so in the thread, with the budget left. At 80% of
the budget the thread is told; at 100% it stops, and the note says to raise it with
`vyre agents update <name> --budget <dollars>`.

With neither item set, an agent uses the Claude Code login already on this machine.

To store your own and point an agent at them:

1. Store the token and the key. Each prompts for the value without echo:

   ```sh
   vyre vault put claude-setup-token --kind secret
   vyre vault put anthropic-api-key --kind api-key
   ```

2. Let the `agents` module release them:

   ```sh
   vyre vault grant claude-setup-token agents
   vyre vault grant anthropic-api-key agents
   ```

3. Point the agent at them, with a budget in dollars for the key:

   ```sh
   vyre agents update juno --vault claude-setup-token --fallback anthropic-api-key --budget 20
   ```

> [!SNAG] "juno cannot start: ..."
> The item named by `--vault` is missing, has no value, or is not granted to `agents`. Check it
> with `vyre vault list`, then grant it. A missing fallback key does not stop the agent: it starts
> without one, and Vyre's log says so.

## Make an agent

```sh
vyre agents create kit --projects juniper-legal,northwind-bakery \
  --vault claude-setup-token --fallback anthropic-api-key --budget 20 \
  --instructions "You keep the books for Juniper Studio and Northwind Bakery."
```

```output
  made kit  agent · juniper-legal, northwind-bakery
```

A name is lowercase letters, digits and dashes, starting with a letter, 2 to 31 characters. Flags: `--projects a,b` (or `*`), `--model`, `--vault`, `--fallback`, `--budget` (dollars),
`--instructions`, and `--assistant` to make the one assistant. `vyre agents update <name>`
takes the same flags and changes only what you name; the change applies from the agent's next
thread.

In the Vyre app, **New assistant** (`/u/settings/assistants/new`) is a form for a new agent: a
name, its projects, its job, what it runs on and the **Its own computer** switch.
`agents.create` and `agents.update` also take an `effort`; `vyre agents` has no flag for it. Making or changing an agent asks for no passkey. It is yours: the CLI, the Vyre app, the
Lumen and onboarding may call `agents.create` and `agents.update`. A model never edits an agent. Your assistant, or the agent itself, proposes a change to its
instructions, skills, model, effort or tags (see [project templates](project-templates.md)), the
agent's owner approves it, and it is a version you can roll back. Any other agent, a bare MCP
session and a guest are refused with "denied", and nobody is asked.

## Make the assistant later

If you skipped the assistant at onboarding, make it from a terminal:
`vyre agents create juno --assistant`, with the flags you give it.
To give it a computer, see [Give an agent a computer](#give-an-agent-a-computer).

## See what agents are doing and what they cost

```sh
vyre agents                 # every agent, the assistant first, with what each is doing
vyre agents threads kit     # its threads, newest first
vyre agents history kit     # what was asked of it, and its answers
vyre agents resume kit      # bring its latest thread back, with its own credentials
vyre agents usage           # turns, time, tokens, dollars against each budget, rate-limit state
vyre agents stop kit        # stop every running thread of kit; its record and transcripts stay
vyre agents delete kit      # remove the record; refused while a thread runs, and for the assistant
```

The matching tools are `agents.list`, `agents.threads`, `agents.history`, `agents.resume`,
`agents.usage`, `agents.stop` and `agents.delete`. `agents.delete` is open only to your own surfaces (the terminal, the Vyre app and the
Lumen), not to Claude.

In the Vyre app, **Assistants** shows the same list, and each assistant's page shows its **Usage**.

## Give an agent a computer

An agent can have its own computer: a container on your server with a desktop, Chrome and a
terminal. Screens come from a small shared pool and are checked out only while the agent needs to
look at something; an idle computer is frozen and its home volume stays. Computers need a machine
that can run containers; on one that cannot, `computers.list` reports driver `none`.

Turn it on with `computer: true` on `agents.create` or `agents.update`, or **Give kit a
computer** (with the agent's name) in the **Computer** section of its page in the Vyre app. Screen Share, which lets
you watch the screen and take over the keyboard, comes in 0.3.1.

Two rules hold for every computer:

- **Each agent has its own.** An agent can start, stop, pause and read only its own computer.
  Naming another agent's computer is refused. Your assistant can, because it acts for you.
- **Only you resume a pause.** When a computer is paused, or you have taken it over, its hands
  refuse every input action. The agent cannot lift that, and neither can another agent or a
  model. Resuming is yours, and so is giving the keyboard back.

From a terminal:

```sh
vyre agents computer kit                          # its state, screen, cores and memory
vyre agents computer kit restart                  # a new container on the same home
vyre agents computer kit limits --cpus 2 --memory 4
```

A restart closes whatever is open on its screen and keeps its files and Chrome profile. New
limits apply at the next restart.

## The `vyre` home

`vyre` with no arguments, from any folder, opens the home: every project, **New session without
a project**, and every agent with what it is doing. Pick an agent to talk to it. See
[projects and threads](projects-and-threads.md) for the rest of the home.

## Which surface does what

| Task | Terminal | Vyre app | Lumen | Claude |
| --- | --- | --- | --- | --- |
| Talk to an agent | `vyre agents ask`, `vyre` | Assistants, then **Open** | Control twice, `@name` | `agents.ask` |
| List agents | `vyre agents` | `/u/assistants` | `@` | `agents.list` |
| Make or change one | `vyre agents create`, `update` | New assistant | | `agents.create`, `agents.update` (the assistant, for an agent's name, instructions, model, effort and description) |
| Usage and budget | `vyre agents usage` | Usage | | `agents.usage` |
| Stop or delete | `vyre agents stop`, `delete` | | | `agents.stop` |
| Answer a question | `vyre threads answer` | Now, the chat | the held row | never |

## What it will not do

- Let a model answer a permission question, its own or another session's.
- Give an agent other than the assistant the tools to drive other sessions.
- Let an agent act on another agent's computer, or resume its own paused one.
- Show an agent's token or key. It goes from the Vault into the agent's child process and nowhere
  else.
- Spend past an agent's budget on the API key.

## Next

- [Vault](vault.md): where the setup token and API key live.
- [Watchers](watchers.md): things an agent can watch for you.
- Every tool: [agents](../reference/tools.md#agents), [threads](../reference/tools.md#threads),
  [computers](../reference/tools.md#computers). Every command:
  [`vyre agents`](../reference/cli.md#vyre-agents).
