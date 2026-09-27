---
title: Glossary
summary: The words Vyre uses for its own pieces, and the ones it retired.
audience: users, builders, operators, agents
owner: docs
status: stable
---

# Glossary

The short definitions. Every other page links here instead of redefining these.

## Server

The Linux machine that runs Vyre's core: vyred, the tools registry, storage, everything that
keeps running whether or not a device is open. Linux only. "Your Vyre server" in conversation,
`vyre server <sub>` on the command line. A server you haven't paired anything to yet is "a
server"; the one you use is "your server".

## Device

A Mac, Windows PC or phone that pairs with a server. Its local modules (Capsule, screen and
hands, voice, the CLI) run in the device role: they talk to a server over the tailnet, they don't
run a core of their own. Every device you've paired shows up the same way, whatever it is.

Use "device" in user-facing text. "Client" means the same thing but is for technical docs
(architecture pages, API references, ADRs) where "device" would be confusable with a network
client in the same sentence.

## Retired: "box"

"Box" used to mean the Linux server, and in places, inconsistently, a Mac running its own
standalone core. Both senses are gone: see [ADR 0038](/adr/0038-terminology-server-and-devices)
for the decision and the migration. `vyre box <sub>` still works as an alias for
`vyre server <sub>` through 0.1.1; existing config files with `role: "box"` or `role: "local"`
keep working. New text everywhere uses "server" and "device".

## Capsule

The native app on a device (today: the Mac) that gives an agent eyes and hands on that device's
screen. See [Using the Capsule](/using/capsule).

## Deck

The web app a device opens to talk to your server: chat, agents, settings. See
[Using Deck](/using/deck).

## Vault

Where your server keeps credentials for the services you've connected, encrypted at rest, read
only when a tool needs one. See [Using the vault](/using/vault).

## Tailnet

The private network (built on Tailscale) that only your paired devices and server can reach. See
[Tailnet](/concepts/tailnet).
