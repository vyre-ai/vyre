---
title: How Vyre runs your sessions
summary: The sessions Vyre starts run on your own server with your own Claude, Codex, Grok and OpenRouter accounts, one model picker per session, closed when idle and resumed on the next message, with a system prompt you can edit at three levels and undo.
audience: users
owner: docs
status: draft
---

# How Vyre runs your sessions

Every session Vyre starts, from Chat, the Lumen on your Mac, your phone, an agent, the planner or
a learning job, is a real session that Vyre runs and keeps on your own server. It carries on
after you close a window, and every surface you use sees the same conversation. A `claude` you
start yourself in a terminal stays yours: Vyre follows it through [the plugin](claude-code.md)
and never takes it over. The two kinds write the same transcripts, so either can pick up the
other. The decision behind this is [ADR 0030](../adr/0030-sessions.md).

## Four providers, your own accounts

A session runs on one provider at a time, and each provider runs from an account of yours.

| Provider | How it runs | Account you bring |
| --- | --- | --- |
| Claude | Claude Code, on the Claude Agent SDK | A Claude sign-in or setup token, or an Anthropic API key |
| Codex | Codex, over the Agent Client Protocol | A ChatGPT sign-in, or an OpenAI API key |
| Grok | Grok Build, over the Agent Client Protocol | A Grok sign-in, or an xAI API key |
| OpenRouter | Chat over HTTP | An OpenRouter API key |

OpenRouter answers in words only. It has no tools, so it never asks a permission question and
cannot touch a file or run a command; it is there so a conversation can carry on when everything
else is out of usage. Codex and Grok cannot be steered mid-turn or rewound, and the effort
levels are Claude's only.

You connect Claude when you set up Vyre, or later in Settings, with the
provider's own sign-in: you open its page, enter the code it shows, and the token goes into
that account's own private folder, which Vyre never reads. An account can also hold an API key
from the [Vault](vault.md). Store the key, let sessions read it, and add the account:

```sh
vyre vault put openrouter-key --kind api-key
vyre vault grant openrouter-key threads
vyre call sessions.accounts.add '{"provider":"openrouter","label":"work","kind":"api-key","vault_item":"openrouter-key"}'
```

A provider can have several accounts. An account can be limited to some projects or agents, and
`sessions.accounts.list` shows each one with its plan and, for a sign-in, who it is signed in as.
On a server, each account runs as its own user, so one account's sign-in cannot be read from
another's. An account that an agent started stays pending until you finish it on your own
device.

## One picker per session

Chat has one chip above the message box that says who answers, the model and the effort, for
example "Codex · GPT-5 high", with the provider's logo. Press it to open **Answer with**: each
signed-in account, the models under it, and (for Claude) the effort levels. The choice applies
from the next turn.

- Picking another account moves the same session, folder and files to that provider between
  turns. The new provider is given a short brief of what was said so far, and the session says
  so in the thread, for example "Switched to Codex. It has this session's memory and files.",
  with a line on anything the new provider cannot do. Switching while a turn runs is refused
  until you stop it or it finishes.
- Switching back to a provider that ran this session before returns to its own memory of the
  session: "Back on Claude. It has this session's memory and files, and what Codex said this
  turn."
- Every reply carries the logo of the provider that wrote it, and a reply keeps its logo after
  you switch.
- When a provider's usage runs out and you have set a fallback order, the session moves to the
  next one by itself and says "Claude's limit was reached. Switched to Codex." The order is per
  project, per agent or for the whole machine, for example Claude, then Codex, then Grok:

  ```sh
  vyre call sessions.routes.set '{"scope":"default","entries":[{"provider":"claude"},{"provider":"codex"}]}'
  ```

  Two entries on one provider (two accounts of one vendor) can break that vendor's terms, so
  Vyre saves them only with `"acknowledge": true`, after you have read the warning.

### One message on another provider

Start a message with `@codex` or `@grok` (or `@claude`, `@openrouter`) to send that one message
to that provider. The session keeps its own provider. The other provider gets the session's
memory and files, its reply carries its logo, and the session is told what was said while it
was away. When a provider has several accounts, the word is the name with the account's label,
such as `@codex-work`, and the message box shows "This turn runs on" the account that will answer. Only the first word of the
message counts. If that account is signed out or out of usage, Vyre says so in plain words and
sends nothing; it never falls back to another one.

## What runs them

Vyre runs Claude sessions on the Claude Agent SDK, which runs Claude Code itself. The SDK is
installed on first use into `~/.vyre/sessions-sdk` (on a box, the home's volume), and sessions run
directly on the `claude` command until it is ready. To install it now and wait:

```sh
vyre sessions setup
```

`vyre sessions status` says which driver is in use, which sign-in, which Claude Code, and
whether the SDK is installed.

| Setting (`sessions` in `config.json`) | Box default | Mac default | What it does |
| --- | --- | --- | --- |
| `driver` | `sdk` | `sdk` | `sdk` runs sessions on the Agent SDK; `cli` on the `claude` command. Until the SDK is installed, sessions run on `claude` either way. |
| `auth` | `setup-token` | `login` | The Claude sign-in sessions use when no account is named. `setup-token` is the token you gave during setup, kept in the vault; `login` is Claude Code's own sign-in on that machine; `api-key` is the API key in the vault. |
| `claude` | `bundled` | `installed` | Which Claude Code: the one the SDK ships, the `claude` you installed, or a path. |
| `idle_minutes` | `10` | `10` | A session nobody is using closes after this long, and comes back on your next message. `0` keeps them open. |
| `max_live` | `6` | `0` (none) | At most this many sessions running at once. The one idle longest closes to make room; when all are busy, a new one is refused until one finishes. |

When your Claude subscription's limit is reached and an Anthropic API key is in the vault, a
session carries on under the key and says so in the thread. With a fallback order set (above),
it moves to the next provider instead.

## Which model

This is the model for a Claude session before you pick one in the chip. Real work runs on Opus:
Chat, agents, teammates and project sessions. Quick answers and background jobs (Lumen quick
asks, memory, the planner, learning, any one-shot job) run on a faster, cheaper model, haiku by
default. An agent's own model wins, and you can change any of it:

```sh
vyre call sessions.models.get
vyre call sessions.models.set '{"scope":"purpose:capsule","model":"sonnet"}'
vyre call sessions.models.set '{"scope":"project:northwind-bakery","model":"opus"}'
```

`sessions.models` in `config.json` sets the defaults per purpose (`chat`, `agent`, `project`,
`teammate`, `capsule` for Lumen, `job`, `memory`, `planner`, `learn`, `helper`); `vyre sessions
models` takes the first eight and the others are set with `sessions.models.set`. A thread shows
its model on its chip.

**Effort**, as `/effort` in Claude Code: `low`, `medium`, `high`, `xhigh` or `max` (the model's
own limits apply). The picker offers it for Claude sessions. An agent's saved Effort is used
for its sessions. Change a running session's at once, and it stays with the session when it
comes back:

```sh
vyre call threads.effort '{"thread":"<id>","effort":"high"}'
```

A send can switch both first: `threads.send {thread, text, model: "opus", effort: "max"}`. In
Lumen, Command-Return inside an answer's own thread asks the deeper model (sonnet) and turns
thinking on.

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

What still holds: Vyre's safety checks run before every tool call (writes to your settings or
Vyre's state, secrets, and the rest of its rules are refused), and the Gate still holds outbound
actions. Only a person sets it: no answer to a question, no model and no agent can, and a
session's own tools cannot. A session started without Vyre's plugin (a quick answer) refuses it.
The mode carries over when an idle session comes back.

## Closed when idle, back on the next message

An idle session holds memory on the machine. So a session with no turn running, no question
waiting, nobody at its keyboard and no watch on it is closed after `idle_minutes`. Its thread
shows "paused", and your next message resumes it where it was: the same conversation, the same
transcript. Nothing is lost.

## Messages while it works

A message you send while a Claude session is working joins the running turn at Claude's next
step, as in Claude Code (steering). Send with `mode: "queue"` to wait for the turn to end instead; a queued
message can be edited, taken back or sent now until then. Pasted images go with either. Steered
words that a stop or a restart cut off before Claude took them in are kept, and run first when
the session comes back.

## Near your plan's limit

Claude Code reports how much of your plan's window is used. When a Claude sign-in is near its
limit (a warning, 80 percent used, or refused), Vyre stops starting new subagents and teammates on it until
the window resets; sessions already running carry on. To go on anyway, or to turn the pause off:

```sh
vyre call sessions.usage.get
vyre call sessions.usage.resume '{"auth":"subscription"}'
```

`"pause_at_warning": false` under `sessions` in `config.json` turns it off.

## Stop a turn

`threads.interrupt` (`vyre threads interrupt <thread>`) stops the turn a session is running, as Escape does in Claude Code. The session
stays and takes your next message. Any question that turn was waiting on is cancelled.

## The system prompt

What every Claude session is told can be edited at three levels:

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

### Lumen's quick answer (Vyre Memory)

A question you ask in Lumen runs as a small session on the fast model with its own prompt:
it is Vyre Memory, it answers only from the facts Lumen showed you for the same words, cites
them by number (`[1]`), and says "I don't know yet." in one line when none of them answers. It
never talks about its access or tools, answers in one to three sentences, and fixes your typos
without saying so. Thinking is off, so the same words get the same answer. The prompt is
versioned (`capsule@2`, or `capsule@own-<n>` once you add your own), and the version is on the thread's start.

To add a line of your own, or replace it, use scope `capsule`, versioned and undoable like the
others:

```sh
vyre call sessions.prompt.set '{"scope":"capsule","text":"Call me alex."}'
vyre call sessions.prompt.preview '{"purpose":"capsule"}'
```

`npm run eval:iq` asks the model eleven fixed questions twice each with your own Claude sign-in
and says which answers break a rule or change between runs.

## Each session's own line to Vyre

On a server that runs sessions as their own user, a session cannot open Vyre's own socket. Vyre
opens one for each session instead and hands it over as `VYRE_SOCKET`: the session's Vyre tools,
its hooks and any `vyre` command it runs go through it, as that session, whatever they claim to
be, and your own tools (answering, approving, modes) are never reachable from it. It closes when the
session stops. `sessions.thread_socket` (`auto`, `on`, `off`) controls it; `auto` opens one only
where sessions run as their own user.

## Open in terminal

`vyre resume <thread>` opens any thread in `claude` in your terminal, where it ran. A session Vyre
is running is handed over first: if it is idle Vyre closes it, and your terminal takes it. If it
is in the middle of a turn or waiting on a question, it is left alone and the command says so. A
message from the Vyre app or Lumen after you exit brings it back to Vyre.
