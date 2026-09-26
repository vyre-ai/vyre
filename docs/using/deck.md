---
title: Deck
summary: Open the Deck, Vyre's web app on your box, and use its views to see what needs you, follow your projects and agents, and change settings from a laptop or a phone.
audience: users
owner: polish-surfaces
status: draft
---

# Deck

The Deck is Vyre's web app. Your box serves it at its own address, usually
`https://vyre.<tailnet>.ts.net`, and only your devices on your tailnet can open it: there is no
separate login, because Tailscale says who is on the other end (see [Tailscale](tailscale.md)).
It shows what needs you, what is running, your projects, agents, memory and vault, and every
setting the onboarding made or skipped. The same pages work on a phone, and it installs as an app
there (see [Mobile](mobile.md)). The Deck reads and writes only through vyred's API, so it never
disagrees with the terminal or the [Capsule](capsule.md).

## Open it

Run `vyre up` on the box, or on your Mac once it is paired. It prints the address:

```output
  Vyre is ready.

    your box        https://vyre.tail1234.ts.net
    your assistant  juno
    next            vyre      (your projects and threads)
```

Open that address in a browser on any device signed in to your tailnet as the box's owner. A
device signed in as anyone else gets `403 not_owner` ("This Vyre serves only its owner.").

> [!SNAG] The last line reads "Almost there: your box has no address yet."
> The address step of the onboarding is not done, and the Deck is served only at the address.
> Finish that step: see [Onboarding](../get-started/onboarding.md).

## What is on each view

The rail on the left holds the views. On a phone, a tab bar holds Now, Projects, Chat, Ask and
Agents; your initials at the top open Settings.

| View | Path | What it shows |
| --- | --- | --- |
| Now | `/now` | what needs you (held drafts, permission questions), what is running, recent projects, and what memory learned today |
| Projects | `/projects` | every project, its threads, and each thread's live output with a box to type into |
| Memory | `/memory` | what memory holds, with its sources; see [Memory](memory.md) |
| Agents | `/agents` | each agent, what it is doing, its threads, usage and computer |
| Chat | `/chat` | sessions as conversations; see [Chat](chat.md) |
| Vault | `/vault` | credentials, never their values; see [Vault](vault.md) |
| Settings | `/settings` | setup, network, notifications, passkeys, modules, appearance |
| Ask | `/ask` | talk to your assistant or any agent (a tab on the phone only) |

A view whose module is not running says which module is missing instead of failing.

![Now in the Deck: two things wait for you, an email to dana@harlowlegal.com and a spend for Northwind Bakery, both held at the Gate, with Send and Discard](shots/deck-now.png)

## Search what was said

Type in the search box at the top (Command-K) to search every session's words, the same search
as `vyre recall`. Pick a hit to open that thread.

## Approve or change a held draft

When an agent wants to send something, the Gate holds it and Now lists it in the Beacon colour.

1. Open it from Now (on a phone, it opens full screen at `/needs/<id>`).
2. Click a field to edit it: To, Subject and Body for an email; for a web request, Method, URL,
   Headers and Body. The fields read as text until you click them.
3. Press Send to send exactly what is on screen, or Discard to drop it.

![A held email opened in the Deck: who it goes to, the subject and body you can edit, and Send or Discard](shots/deck-held.png)

Sending is a person's action, so the box asks for proof that you are there. When it does, the
Deck shows a passkey prompt (see [Add a passkey](#add-a-passkey)). If the send fails, the item goes
back to held with the error shown above the fields ("Held again: ...").

## Answer a permission question

A session that wants to use a tool it has no permission for raises an ask. Now lists it; open it
and choose Allow or Deny.

## Follow and type into a thread

1. Open Projects, then a project, then a thread. Its output streams in as the session works:
   text as it is written, tool calls as lines.
2. Type in the box at the bottom. It types into the session as you.

Only one surface holds a session's keyboard at a time. When another holds it, the box reads
"<surface> is typing"; press **Take the keyboard** to take it.

To start a thread, open a project and press **New thread**. A thread that is in no project opens at
`/threads/<id>` with **Add to a project**.

## Look after an agent

Open Agents, then an agent. You see what it is doing, its threads, and its usage: money spent
against its budget for an agent on an API key, or turns and time for one on a subscription. From
here you can change its instructions and model, stop it, give it a computer or restart that
computer, and open its screen in [Glass](glass.md). **New agent** on the Agents list makes one;
see [Agents](agents.md).

![kit's page in the Deck: its job, the projects it works in, a box to talk to it, what wakes it, its usage and its model](shots/deck-agent.png)

## Finish setup, or change it

Settings starts with Setup: every onboarding step (you, Claude Code, Tailscale, your address,
your history, your devices) and whether it is done. **Finish** beside a skipped step opens the
onboarding at that step. `vyre index` does the history step from a terminal.

![Settings in the Deck: the six setup steps, each marked To do or Done with a Finish or Open button, then your name and address](shots/deck-settings.png)

> [!GAP]
> The command shown beside each step (`vyre up --step ...`) does not exist in the CLI. Finish the step in the Deck or run `vyre up` again. See [known gaps](../known-gaps.md#the-decks-setup-commands-name-a-flag-the-cli-lacks).

Other sections: the assistant's name and instructions, Claude Code, network, history and memory,
lessons, notifications (see [Mobile](mobile.md#turn-on-notifications)), security (add a passkey),
modules, appearance (dark or paper), and this machine. `/settings#security` or
`/settings?section=security` jumps to a section.

## Add a passkey

A passkey proves a person is at the device, for a Gate approval or a Glass take-over
([ADR 0004](../adr/0004-presence.md)).


1. On the box, run `vyre presence code`. It prints a one-time code. The Deck asks for one for
   every passkey it adds.
2. In the Deck, open Settings, Security.
3. Paste the code, name the device, press **Add a passkey**, and follow the browser's prompt.

```output
Passkey added.
```

> [!SNAG] "This browser cannot create or use a passkey."
> The browser must reach the Deck at its real address over your tailnet, in Safari or Chrome. A
> passkey cannot be made on `127.0.0.1` or through an SSH tunnel.

## When the box is out of reach

The Deck's files are cached, so it opens when the box is briefly out of reach. Now shows
"Offline. As of ... ago" with counts from the last visit, never a draft's words. Only two reads,
`projects.list` and `threads.get` for threads you opened, are kept for offline use: the last 20,
for up to a week. Nothing you can send or approve works offline.

## What it will not do

- It never shows a vault value. There is no API for one.
- It never renders text from a thread as HTML. Model output is untrusted.
- It is not reachable from the public internet. Without Tailscale on a device, that device cannot
  open it.

## Next

- [Chat](chat.md), for sessions as conversations.
- [Glass](glass.md), to watch and drive an agent's computer.
- [Mobile](mobile.md), to install the Deck on your phone and get notifications.
- [Security](../security/index.md), for passkeys and what the Deck is allowed to do.
