---
title: Your first day
summary: What to do on your first day after onboarding: open the Capsule, start a thread in a project, launch an agent, store a secret, and find something from last week.
audience: users
owner: e2e
status: draft
---

# Your first day

Onboarding left you with a box at your own address, a paired Mac, and an assistant. This page walks through the five things most people do next, each in the fewest steps. Every step works from the terminal as well as from a screen; both are shown. The examples use a project called `harlow-legal` and an agent called `kit`.

Before you start, check that everything is up. On the Mac:

```
vyre status
vyre link
```

`vyre status` says whether `vyred` is running and which modules started. `vyre link` says whether this Mac is paired with your box and whether the box answers. If either is wrong, see [Troubleshooting](troubleshooting.md).

## Open the Capsule

Press Control twice, in any app. The Capsule opens over what you are doing, with the caret in its box. Press Escape to put it away.

- Type a question and press Return. By default it goes to your assistant, which can see every project and every session.
- Type `@` to pick who hears it: an agent (`@kit`), a project, or a thread. Talking to a thread types into that session directly.
- Anything that came from memory rather than a model shows in gold, with its source.
- Anything waiting on you (a permission question from a thread, a message held before sending) shows in the Capsule and can be answered there.

If Control twice does nothing, run `vyre capsule` to open it wired to this Mac's `vyred`, and check that macOS granted the app Input Monitoring. More in [The Capsule](../using/capsule.md).

## Start a thread in a project

A project groups the sessions that belong together, and every new thread in it starts with the project's brief: what the project is, its people, its other threads and its memory.

If you made projects during onboarding, they are already there. To make one from the terminal, run this in the project's folder and pick the sessions that belong to it:

```
cd ~/Work/harlow-legal
vyre new harlow-legal
```

Then start a thread:

- **In the Deck:** open Projects, pick `harlow-legal`, press **New thread**, and say what it should do (or leave it empty).
- **In the terminal:** in the project's folder, `vyre start` opens Claude Code in a new thread with the brief. `vyre open harlow-legal` shows what the brief says and lists the project's threads; `vyre resume <thread>` picks up an old one where it ran.

To see what a new thread will be told before you start one:

```
vyre context harlow-legal
```

More in [Projects and threads](../using/projects-and-threads.md).

## Launch an agent

An agent is a named, headless Claude Code worker that runs on the box. It uses your Claude subscription (a setup token in the vault) or an API key with a budget, and it sees only the projects you give it.

- **In the Deck:** open Agents and press **New agent**. Give it a name, and say what it does and what it must ask you before doing.
- **In the terminal:**

```
vyre agents create kit --projects harlow-legal --budget 20 \
  --instructions "Keep the Harlow Legal client folder tidy. Ask before deleting anything."
vyre agents ask kit "List the documents that came in this week."
```

`--budget` is in dollars and applies to API-key use: the thread is told at 80%, and stops at 100% with a note saying how to raise it. `--vault` and `--fallback` name the vault items holding the subscription token and the API key; without any auth set, the agent uses the Claude Code sign-in on the box.

If an agent stops on a permission question, `vyre agents ask` prints it with the command to answer it (`vyre threads answer <id> allow|deny`). See what your agents are doing with `vyre agents`, and what they have spent with `vyre agents usage`. More in [Agents](../using/agents.md).

## Store a secret

Put a credential in the vault once, and never paste it into a session again. Claude sees the item's name, never its value.

- **In the Deck:** open Vault and press **Add item**.
- **In the terminal:**

```
vyre vault put harlow-stripe --kind api-key --description "Harlow Legal billing key"
```

It prompts for the value without echoing it. Putting a value is a human-only action, so Vyre asks you to prove you are there (Touch ID on the Mac, a passkey in the Deck) first.

To use it from a script outside Vyre, let the vault hand it to that one process:

```
vyre vault run STRIPE_KEY=harlow-stripe -- node sync-invoices.js
```

The value reaches only that process's environment, and is scrubbed from its output. `vyre vault list` shows names and kinds, never values. More in [The vault](../using/vault.md), including how to share one item with another person without handing it over.

## Find something from last week

Recall searches every session you have had, on this machine and indexed from your history.

```
vyre recall "retainer template"
```

Each hit shows the session, how long ago it was (`6d ago`), who said it, the folder it ran in, and the matching words in gold. Resume the session with `claude --resume <id>`, or open it in its project with `vyre resume <thread>`. Add `--here` to search only sessions from the current folder, `--user` for only what you said.

Recall has no date filter; it ranks by match. To browse by time instead, open the project in the Deck: its threads are listed newest first.

You can also ask for it in words. In the Capsule, ask your assistant ("what did we decide about the Northwind Bakery invoice last week?"); the answer comes from memory, marked in gold, with the turns it came from. From the terminal, `vyre why <fact>` shows the turns a fact came from. More in [Memory](../using/memory.md).

## What is not here yet

- A date filter for recall, as above.
- A native phone app. On the phone, open your address and add the Deck to the home screen. See [On your phone](../using/mobile.md).
- Automatic updates. On the box run `vyre update`; on the Mac run the install line again. See [Looking after the box](../using/box-care.md).

## Where to go next

- [The Capsule](../using/capsule.md), [The Deck](../using/deck.md), [Chat](../using/chat.md)
- [Watchers](../using/watchers.md), for work that should happen while you are away
- [Troubleshooting](troubleshooting.md)
