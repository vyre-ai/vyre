---
title: The box and the Mac
summary: What runs on your server and what runs on your Mac, why each machine runs one vyred, and how the two talk over your tailnet.
audience: users, builders, operators, agents
owner: integrator
status: stable
---

# The box and the Mac

Vyre runs on two kinds of machine. The **box** is a server you own (or a Mac you choose to use as one): Claude Code sessions, agents, watchers and the Deck live there. The **Mac** is the computer you sit at: it runs the Capsule and your own terminal sessions, and reaches the box over your private [tailnet](tailnet.md). Each machine runs exactly one Vyre process, `vyred`, with a different set of [modules](modules.md) switched on.

## One process per machine

`vyred` is the same program everywhere. Its `role` decides what it starts:

| Role | Where | Set by |
|---|---|---|
| `box` | a Linux server (the default off macOS), or a Mac after `vyre up --box` | `vyre box add`, the box installer, `vyre up --box` |
| `local` | your Mac (the default on macOS) | `vyre up`, `vyre up --connect <address>` |

The role lives in `~/.vyre/config.json` as `"role": "box"` or `"role": "local"`. See [config](../reference/config.md).

Every module declares the roles it runs in (`"roles"` in its `module.json`; both when omitted). What that means today:

| Runs on | Modules |
|---|---|
| Box only | `names` (address, certificates, the tailnet listener), `onboard`, `computers`, `glass`, `chrome`, `hands-desktop` |
| Mac only | `capsule`, `hands` (computer use on macOS) |
| Both | `projects`, `recall`, `memory`, `vault`, `watchers`, `threads` (the Switchboard), `agents`, `gate`, `learn`, `harness`, `presence`, `link`, `files`, `push`, `system` |

A module that runs on both machines works on that machine's own data: recall on the Mac searches the Mac's Claude Code transcripts, recall on the box searches the box's. `vyre modules` lists what started on the machine you run it on, and why anything failed.

You can move a module on or off with `modules.enable` and `modules.disable` in `config.json`. `enable` starts a module even when its roles do not include this machine's role.

## What runs where on a Linux box

A Linux box runs Vyre in Docker Compose, from `/srv/vyre`. The stack is `box/compose.yml`:

- `tailscale`: the official Tailscale image with kernel networking, so `tailscale0` is a real interface. It is the only way in.
- `vyre`: vyred and Claude Code, as uid 1000, inside the `tailscale` container's network namespace (`network_mode: service:tailscale`). vyred binds the tailnet addresses on port 443 itself.
- `docker-api`: a filtered Docker API for the agents' computers, under the `computers` profile.

The only published port is the onboarding page, on the host's `127.0.0.1:7300`. The host needs Docker and nothing else. A small `vyre` wrapper in `/usr/local/bin` runs commands inside the container.

The no-Docker alternative is a systemd unit (`sudo vyre up --system`); see [without Docker](../get-started/without-docker.md).

## What runs on the Mac

On the Mac, `vyre up` starts vyred in the background with role `local`. It opens no tailnet listener. It serves its API on `~/.vyre/vyred.sock` to the CLI, the Harness hooks in your terminal sessions, and the Capsule.

## How the Mac finds the box

`vyre up` on a Mac with no box configured calls `link.find`, which looks for a Vyre box on your tailnet:

- One box answers: its address is saved as `network.box`.
- Several answer: you pick one, or run `vyre up --connect <address>`.
- None answer: you choose where the box runs.

```
vyre box add alex@192.0.2.10                     # put the box on a server you can SSH to
vyre up --box                                    # make this Mac the box
vyre up --connect https://vyre.tail1234.ts.net   # a box you already set up
```

## How they talk

The Mac's vyred is a client of the box's tailnet listener, at `network.box`. The box sees the Mac as `tailnet:<login>`, like any of your devices, because it identifies callers by `tailscale whois` of the WireGuard source address and never by a header ([ADR 0002](../adr/0002-network-and-identity.md)).

The `link` module turns the two machines into one system:

- **Pairing.** On the Mac, `vyre link pair <address>` asks the box and shows a code. You approve it in the Deck on the box, which asks for your passkey (see [presence](presence.md)). The Mac keeps a link key in `~/.vyre/link.json` (mode 0600) and pins the box's Tailscale node, so a different node at that address is refused.
- **Box tools from the Mac.** A module on the Mac calls `ctx.remote(tool, input)`; a surface calls `link.call`. Both reach `POST /v1/tools/<tool>` on the box.
- **Box events on the Mac.** The Mac proxies the box's event stream at `/v1/link/events`, so the Capsule sees box threads as they happen.

```
vyre link                 # on the Mac: paired or not, and whether the box answers
vyre link pair https://vyre.tail1234.ts.net
vyre link unpair          # forget the box
```

## When the box is away

The Mac keeps working without the box (floor rule 9, see [the security floor](floor.md)). Once a call to the box fails, the next ones fail fast with `box_unreachable` and are retried with a growing pause, up to 30 seconds. The link emits `link.lost` and, when the box answers again, `link.connected`. A module that asked the box for something gets the error at once and can fall back to what the Mac has.

## What it will not do

- The Mac never serves the Deck on the tailnet. The Deck lives on the box.
- The box never trusts the Mac because of a header or a shared secret alone: every connection is identified by its tailnet source address first.
- Link tools on the box (`link.*`) cannot be driven through `ctx.remote` or `link.call`.

## Next

- [The tailnet](tailnet.md): addresses, identity and certificates.
- [Presence](presence.md): why approving a pairing needs you, not a model.
- [Box care](../using/box-care.md): updating, backing up and moving the box.
