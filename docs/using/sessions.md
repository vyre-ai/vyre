---
title: How Vyre runs your sessions
summary: The sessions Vyre starts run on the Claude Agent SDK, with this machine's own Claude sign-in, closed when idle and resumed on the next message, with a system prompt you can edit at three levels and undo.
audience: users
owner: docs
status: draft
---

# How Vyre runs your sessions

Every session Vyre starts, from Chat, the Capsule, your phone, an agent, the planner or a
learning job, is a real Claude Code session that vyred runs and keeps. A `claude` you start
yourself in a terminal stays yours: Vyre follows it through [the plugin](claude-code.md) and never
takes it over. The two kinds write the same transcripts, so either can pick up the other. The
decision behind this is [ADR 0030](../adr/0030-sessions.md).

## What runs them

Vyre runs its sessions on the Claude Agent SDK, which runs Claude Code itself. The SDK is
installed on first use into `~/.vyre/sessions-sdk` (on a box, the home's volume), and sessions run
directly on the `claude` command until it is ready. To install it now and wait:

```sh
vyre call sessions.setup
```

`vyre call sessions.status` says which driver is in use, which sign-in, which Claude Code, and
whether the SDK is installed.

| Setting (`sessions` in `config.json`) | Box default | Mac default | What it does |
| --- | --- | --- | --- |
| `driver` | `sdk` | `sdk` | `sdk` runs sessions on the Agent SDK; `cli` on the `claude` command. Until the SDK is installed, sessions run on `claude` either way. |
| `auth` | `setup-token` | `login` | The Claude sign-in sessions use. `setup-token` is the token you gave during setup, kept in the vault; `login` is Claude Code's own sign-in on that machine; `api-key` is the API key in the vault. |
| `claude` | `bundled` | `installed` | Which Claude Code: the one the SDK ships, the `claude` you installed, or a path. |
| `idle_minutes` | `10` | `10` | A session nobody is using closes after this long, and comes back on your next message. `0` keeps them open. |
| `max_live` | `6` | `0` (none) | At most this many sessions running at once. The one idle longest closes to make room; when all are busy, a new one is refused until one finishes. |

When your subscription's limit is reached and an API key is in the vault, a session carries on
under the key and says so in the thread.

## Which model

Real work runs on Opus: Chat, agents and project sessions. Quick answers and background jobs
(Capsule quick asks, memory, the planner, learning, any one-shot job) run on a faster, cheaper
model, haiku by default. An agent's own model wins, and you can change any of it:

```sh
vyre call sessions.models.get
vyre call sessions.models.set '{"scope":"purpose:capsule","model":"sonnet"}'
vyre call sessions.models.set '{"scope":"project:northwind-bakery","model":"opus"}'
```

`sessions.models` in `config.json` sets the defaults per purpose (`chat`, `agent`, `project`,
`capsule`, `job`, `memory`, `planner`, `learn`). A thread shows its model on its chip.

**Effort**, as `/effort` in Claude Code: `low`, `medium`, `high`, `xhigh` or `max` (the model's
own limits apply). An agent's saved Effort is used for its sessions. Change a running session's
at once, and it stays with the session when it comes back:

```sh
vyre call threads.effort '{"thread":"<id>","effort":"high"}'
```

A send can switch both first, which is what the Capsule's Cmd-Return does to go deeper on the
same thread: `threads.send {thread, text, model: "opus", effort: "max"}`.

## Your existing sessions

Every session is in one list, whether a terminal, Vyre, your Mac or your box started it. Send one
a message from Chat and Vyre resumes it where it ran, on the machine that has it; from then on it
works like any session Vyre started. If it is open in a terminal right now, your message waits and
is handed over when that terminal's turn ends, or you can fork it: `threads.fork` carries on the
conversation as a copy, and the terminal's session is never touched.

## Permission modes

`threads.mode` puts a running session in `default` (asks), `acceptEdits` (edits without asking)
or `plan` (reads and plans only), as Shift+Tab does in Claude Code, or "Doesn't ask" (below). Only
you can change a mode; a session or an agent never can, and no answer to a question ever does.

### Doesn't ask

"Doesn't ask" (Claude Code's `bypassPermissions`) runs a session without permission questions.
You turn it on yourself, with no Touch ID: for one session, as Shift+Tab does, or as a project's
default for new sessions there.

```sh
vyre call threads.mode '{"thread":"<id>","mode":"bypassPermissions"}'
vyre call sessions.mode.set '{"project":"northwind-bakery","mode":"bypassPermissions"}'
vyre call sessions.mode.set '{"project":"northwind-bakery"}'    # back to asking
```

What still holds: Vyre's security floor runs before every tool call (writes to your settings or
Vyre's state, secrets, and the rest of its rules are refused), and the Gate still holds outbound
actions. Only a person sets it: no answer to a question, no model and no agent can, and a
session's own tools cannot. A session started without Vyre's plugin (a quick answer) refuses it.
The mode carries over when an idle session comes back.

## Closed when idle, back on the next message

An idle session costs about 180 MB of memory. So a session with no turn running, no question
waiting, nobody at its keyboard and no watch on it is closed after `idle_minutes`. Its thread
shows "stopped (idle)", and your next message resumes it where it was: the same conversation, the
same transcript. Nothing is lost; the first reply takes about a second longer.

## Messages while it works

A message you send while a session is working joins the running turn at Claude's next step, as in
Claude Code (steering). Send with `mode: "queue"` to wait for the turn to end instead; a queued
message can be edited, taken back or sent now until then. Pasted images go with either. Steered
words that a stop or a restart cut off before Claude took them in are kept, and run first when
the session comes back.

## Near your plan's limit

Claude Code reports how much of your plan's window is used. When a sign-in is near its limit (a
warning, 80 percent used, or refused), Vyre stops starting new subagents and teammates on it until
the window resets; sessions already running carry on. To go on anyway, or to turn the pause off:

```sh
vyre call sessions.usage.get
vyre call sessions.usage.resume '{"auth":"subscription"}'
```

`"pause_at_warning": false` under `sessions` in `config.json` turns it off.

## Stop a turn

`threads.interrupt` stops the turn a session is running, as Escape does in Claude Code. The session
stays and takes your next message. Any question that turn was waiting on is cancelled.

## The system prompt

What every session is told can be edited at three levels:

| Level | Scope | Applies to |
| --- | --- | --- |
| The assistant | `assistant` | Your assistant's sessions and every session no agent runs |
| An agent | `agent:<name>` | That agent's sessions |
| A project | `project:<slug>` | Every session in that project |

By default your text is added after Claude Code's own system prompt, which keeps its tool use,
safety and coding behaviour. More specific levels come after more general ones.

```sh
vyre call sessions.prompt.set '{"scope":"assistant","text":"Answer alex in short paragraphs."}'
vyre call sessions.prompt.set '{"scope":"project:northwind-bakery","text":"Prices are in dollars with two decimals."}'
vyre call sessions.prompt.preview '{"project":"northwind-bakery"}'
```

An edit applies from the next session, never to one in the middle of a conversation.

**Every edit is a version.** A bad edit is undone by going back to an older version, and going
back is itself a version, so it can be undone too:

```sh
vyre call sessions.prompt.history '{"scope":"assistant"}'
vyre call sessions.prompt.revert '{"scope":"assistant","version":1}'
```

**Replace, for experts.** `"mode":"replace"` makes your text the whole system prompt. This drops
Claude Code's own instructions (tool use, safety and coding behaviour), and the reply to the edit
says so. Vyre's own rules for the session (who it works for, that you answer its permission
questions) are still added after your text.

Only you can edit a system prompt. No agent, model or tool call from inside a session can, its own
least of all.

### The Capsule's quick answer (Vyre IQ)

A question you ask in the Capsule runs as a small session on the fast model with its own prompt:
it is Vyre IQ, it answers only from the facts the Capsule showed you for the same words, cites
them by number (`[1]`), and says "I don't know yet." in one line when none of them answers. It
never talks about its access or tools, answers in one to three sentences, and fixes your typos
without saying so. Thinking is off, so the same words get the same answer. The prompt is
versioned (`capsule@1`), and the version is on the thread's start.

To add a line of your own, or replace it, use scope `capsule`, versioned and undoable like the
others:

```sh
vyre call sessions.prompt.set '{"scope":"capsule","text":"Call me alex."}'
vyre call sessions.prompt.preview '{"purpose":"capsule"}'
```

`npm run eval:iq` asks the model eleven fixed questions twice each with your own Claude sign-in
and says which answers break a rule or change between runs.

## Each session's own line to Vyre

On a box that runs sessions as their own user, a session cannot open vyred's socket. vyred opens
one for each session instead and hands it over as `VYRE_SOCKET`: the session's Vyre tools, its
hooks and any `vyre` command it runs go through it, as that session, whatever they claim to be,
and your own tools (answering, approving, modes) are never reachable from it. It closes when the
session stops. `sessions.thread_socket` (`auto`, `on`, `off`) controls it; `auto` opens one only
where sessions run as their own user.

## Open in terminal

`vyre resume <thread>` opens any thread in `claude` in your terminal, where it ran. A session vyred
is running is handed over first: if it is idle vyred closes it, and your terminal takes it. If it
is in the middle of a turn or waiting on a question, it is left alone and the command says so. A
message from the Deck or the Capsule after you exit brings it back to vyred.
