---
title: Outside agents
summary: How to let an agent that is not a Vyre session (Dots, Muse, Hermes, ChatGPT, your own Claude Code on another machine) read the records, memory and files you choose, ask before it changes anything, and stop the moment you end it.
audience: users, agents
owner: docs
status: draft
---

# Outside agents

An outside agent is any agent that is not one of Vyre's own sessions: Dots, Muse, Hermes, ChatGPT, or your own Claude Code on another machine. Vyre gives it one address and one token. It holds only what you give it, every use is on the record, and you end it with one tap.

## Register one

Register the agent with a name, and Vyre shows its token once, with the line to paste into the agent's own settings. For Claude Code that is a `claude mcp add` line; for Codex a `codex mcp add` line. A new agent can reach nothing. Its token lasts a week unless you ask for longer, at most 90 days, and you can make a new one at any time: the old one stops working at once.

## Give it something to reach

You give an agent reach in three kinds:

- **Records**: chosen record types, such as Clients and Matters. It reads them like you do, with every sealed field shown as "[sealed]". It never sees a sealed value or the reference to one.
- **Memory**: what Vyre has filed about one project.
- **Files**: one project's folder.

You can only give what you hold yourself. Taking one thing back leaves the rest. Giving or changing reach asks for your approval on your device.

## It asks before it changes anything

With read access an agent cannot change a record. If you also give it write access to a type, a change it wants still waits for you: a card says "Muse wants to add a client: Dana Reyes", you can edit the fields, and one yes does exactly that change. The record is the agent's own, made under what it was given. A yes covers that one change, not the next one and not another agent.

## What it sees about you

Nothing but what you gave it. It cannot register another agent, give itself more, reach your Vault, send a message, or start a session. Every use is an event with the tool and the address it touched, never a value. Five wrong tokens from one address lock that address out for ten minutes.

## End it

Ending an agent takes back everything at once: its token opens nothing, its reach is gone, and anything it was still waiting on is dropped. If you approve a card from it afterwards, nothing happens. Ending needs no one's proof, so you can always do it.
