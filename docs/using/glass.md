---
title: Glass
summary: Watch an agent's computer live from the Deck, take the keyboard and hand it back, sign in to a site without the agent seeing, and move files on the agent's computer and the box.
audience: users
owner: polish-surfaces
status: draft
---

# Glass

Glass is how you see and touch an agent's computer. An agent that has a computer works in its
own container on your box, with a desktop, Chrome and a terminal. Glass shows that screen live in
the [Deck](deck.md), lets you take the keyboard and give it back, lets you sign in to a site for
the agent without the agent seeing the page, and gives you a file browser for the agent's home
and for the box. It runs on the box as the `glass` module. The design is in
[ADR 0005](../adr/0005-glass.md), and how the screen is streamed in
[ADR 0003](../adr/0003-glass-stream.md).

## Before you start

- Agents' computers must be on. On a Docker box that is the `computers` profile: add
  `COMPOSE_PROFILES=computers` to `/srv/vyre/.env`, then run `vyre up`. See
  [Box care](box-care.md).
- The agent needs a computer. In the Deck, open Agents, then the agent, and give it one.
- Taking the keyboard needs a passkey on this device (see [Deck](deck.md#add-a-passkey)).

## Open an agent's screen

Any of these opens the same page:

- In the Deck, Agents, then the agent, then Open Glass. The path is `/agents/<name>/glass`, or
  `/glass/<name>`.
- In the [Capsule](capsule.md), type `glass juno`, or pick Open Glass on one of juno's threads.
- `/glass/box` opens the box itself, which has files and no screen.

The Screen tab shows the agent's desktop live. While you only watch, nothing you type or click
reaches it. A computer nobody is watching is frozen and uses almost nothing; opening Glass wakes it.

## Take the keyboard, then hand it back

1. Press Take over (or `T`). Confirm with your passkey if asked.
2. The agent's hands stop. You type and click; everyone else watching is read-only. The bar
   counts how long you have held it.
3. Press Hand back (or Control+Enter when focus is outside the screen). You can leave a note for
   the agent's thread about what you changed.

If you close the tab, or the hold lapses on the box, the keyboard goes back to the agent on its
own.

## Sign in to a site for the agent

Take over leaves the agent's link to Chrome open, so it could read the page. For a password, use
Sign in privately instead:

1. Press Sign in privately, then Start.
2. The agent can no longer see the page. Sign in to the site in its Chrome.
3. Hand back. The agent sees the page again and can use the signed-in session.

## Move files

The Files tab browses the agent's home, or on `/glass/box` the box's folders. You can list,
preview text and images, download, upload, make folders, move and trash. Every change says what
happened. Downloads and uploads use a one-time ticket, so a link cannot be reused.

Secret places are hidden and refused at any depth: `.vyre`, `.claude`, `.ssh`, `.gnupg`, `.aws`,
`.env` and `.env.*`, `*.pem`, `*.key`, `id_*`, browser cookie and login stores, and any file whose
first bytes are a private key.

## On a phone

Below 600 px wide, or on a touch screen, Glass lays out for the phone: the screen fits the width,
with the same Take over and Hand back. See [Mobile](mobile.md).

## What it will not do

- An agent cannot open Glass, take or release a keyboard. Those are for people.
- It does not show your Mac's screen. Glass is for agents' computers and the box.
- It never lets two people type at once.

Coming: an idle hand-back after five minutes, a cap of four viewers per computer, and filling a
login from your vault into the agent's Chrome.

## Next

- [Agents](agents.md), to give an agent a computer.
- [Vault](vault.md), for credentials an agent uses without seeing.
- [ADR 0005](../adr/0005-glass.md), for why take-over and sign-in work this way.
