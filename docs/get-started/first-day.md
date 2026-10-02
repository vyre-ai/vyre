---
title: Your first day
summary: What to do on your first day after onboarding: open Lumen, start a thread in a project, launch an agent, store a secret, and find something from last week.
audience: users
owner: e2e
status: draft
---

# Your first day

Setup left you with a server at your own address, such as `https://alex.vyre.run`, your phone on it, and a Mac paired with it. If Now still shows **Create your assistant**, press it first and give your assistant a name such as `juno`. This page walks through the five things most people do next, each in the fewest steps. Most steps work from the terminal as well as from a screen; both are shown. The examples use a project called `harlow-legal` and an agent called `kit`.

## Check that everything is up

On the Mac:

```
vyre status
vyre link
```

`vyre status` says whether Vyre is running on this Mac and how many of its modules started (a failed one is named with `vyre modules`). `vyre link` says whether this Mac is paired with your server and whether the server answers; paired and answering, it prints `●` and `linked to` with your server's name. If either is wrong, see [Troubleshooting](troubleshooting.md).

## Open Lumen

Press Control twice, in any app. Lumen opens over what you are doing, with the caret in its box. Press Escape to put it away.

- Type a question and press Return. It goes to your assistant, which can see every project and every session. Lumen shows where a message goes before you send it.
- Type `@` to pick who hears it: an agent (`@kit`), a project, or a thread. Talking to a thread types into that session directly.
- Anything that came from memory rather than a model shows in gold, with its source.
- Anything waiting on you (a permission question from a thread, a message held before sending) shows in Lumen and can be answered there.

> [!SNAG] Control twice does nothing
> Click Lumen's menu bar icon. If a line there starts `Double-Control is off:`, it says why.
> Grant Input Monitoring in System Settings, Privacy & Security, then run `vyre capsule` to open
> it again. Option-Space opens it meanwhile.

More in [Lumen](../using/capsule.md).

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

A thread can run on Claude, Codex, Grok or OpenRouter, from the accounts you signed in to at setup. In Chat, the chip above the message box shows who answers, with its model and effort, and opens a menu to change them. Starting a message with `@codex` or `@grok` sends only that message to that provider, and the thread keeps its own. More in [Sessions](../using/sessions.md#one-message-on-another-provider).

More in [Projects and threads](../using/projects-and-threads.md).

## Launch an agent

An agent is a named, headless Claude Code worker that runs on the server. It uses your Claude subscription (a setup token in the vault) or an API key with a budget, and it sees only the projects you give it.

- **In the Deck:** open Agents and press **New agent**. Give it a name, and say what it does and what it must ask you before doing.
- **In the terminal:**

```
vyre agents create kit --projects harlow-legal --budget 20 \
  --instructions "Keep the Harlow Legal client folder tidy. Ask before deleting anything."
vyre agents ask kit "List the documents that came in this week."
```

`--budget` is in dollars and applies to API-key use: the thread is told at 80%, and stops at 100% with a note saying how to raise it. `--vault` and `--fallback` name the vault items holding the subscription token and the API key; without any auth set, the agent uses the Claude Code sign-in on the server.

If an agent stops on a permission question, `vyre agents ask` prints it with the command to answer it (`vyre threads answer <id> allow|deny`). See what your agents are doing with `vyre agents`, and what they have spent with `vyre agents usage`. More in [Agents](../using/agents.md).

## Store a secret

Put a credential in the vault once, and never paste it into a session again. Claude sees the item's name, never its value.

- **In the Deck:** open Vault and press **Add item**.
- **In the terminal:**

```
vyre vault put harlow-stripe --kind api-key --description "Harlow Legal billing key"
```

It prompts for the value without echoing it. Putting a value is a human-only action, so the command asks you to prove you are there: Touch ID on the Mac, or the code Vyre writes to your terminal. In the Deck, it is your passkey.

To use it from a script outside Vyre, let the vault hand it to that one process:

```
vyre vault run STRIPE_KEY=harlow-stripe -- node sync-invoices.js
```

The value reaches only that process's environment, and is scrubbed from its output. `vyre vault list` shows names and kinds, never values. More in [The vault](../using/vault.md), including how to share one item with another person without handing it over.

## Find something from last week

Recall searches every session you have had, on this machine and indexed from your history. In the Deck on your server, the paired Mac's sessions are listed too, marked with the Mac's name.

```
vyre recall "retainer template"
```

```output
  Retainer template for Harlow Legal
    6f1c2a90-1b7e-4c11-9a52-0d3e8b1f4a77 · 6d ago · user · /Users/alex/Work/harlow-legal
    can you draft the retainer template from the one we used for Northwind Bakery

  resume one with: claude --resume <id>  ·  vyre call recall.thread '{"session":"<id>"}'
```

Each hit shows the session's name, its id, how long ago it was, who said it (`user` or `assistant`), the folder it ran in, and the matching words in gold. Resume the session with `claude --resume <id>`, or open it in its project with `vyre resume <thread>`. Add `--here` to search only sessions from the current folder, `--user` for only what you said.

Until the search model is on this machine, recall matches keywords, and says so on its last line. `vyre recall --setup` fetches the model (about 130 MB) now.

Recall has no date filter; it ranks by match. To browse by time instead, open the project in the Deck: its threads are listed newest first.

You can also ask for it in words. In Lumen, ask your assistant ("what did we decide about the Northwind Bakery invoice last week?"); the answer comes from memory, marked in gold, with the turns it came from. From the terminal, `vyre why <fact>` shows the turns a fact came from. More in [Memory](../using/memory.md).

## What is not here yet

- A date filter for recall, as above.
- A phone app from an app store. Native iPhone and Android builds exist, but you build and install them yourself. On the phone, open your address in Safari or Chrome and add it to the Home Screen: it runs full screen, with notifications. See [On your phone](../using/mobile.md).
- Replying to a Mac session from the server. The Deck shows the Mac's sessions read-only, with "Open it there to continue."; reply in the Mac's terminal or its Lumen.
- Updates on a Mac by themselves. Run `vyre update` on the Mac. A server updates from Settings, with `vyre update`, or by itself between 2 and 5 in the morning if you turn on **Update automatically** (off by default). Updates are signed. See [Looking after the server](../using/box-care.md).

## Where to go next

- [Lumen](../using/capsule.md), [The Deck](../using/deck.md), [Chat](../using/chat.md)
- [Watchers](../using/watchers.md), for work that should happen while you are away
- [Troubleshooting](troubleshooting.md)
