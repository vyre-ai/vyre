---
title: The tailnet
summary: How Vyre uses your Tailscale network for reachability and identity, what your address is, and why there is no login screen.
audience: users, builders, operators
owner: tailnet
status: stable
---

# The tailnet

Your box is reachable only from your own devices, over your Tailscale network (your tailnet). Tailscale does two jobs for Vyre: it carries the traffic, and it tells vyred who is on the other end. That second job replaces a login screen. The decision and its reasons are [ADR 0002](../adr/0002-network-and-identity.md).

## Your address

The Deck is served at one HTTPS address on the tailnet:

| Address | When | Certificate |
|---|---|---|
| `https://vyre.tail1234.ts.net` | the default; your box's Tailscale name | `tailscale cert`; needs HTTPS turned on for your tailnet in the Tailscale admin console ([how](../get-started/tailscale.md#5-turn-on-https-certificates)) |
| `https://alex.vyre.run` | when you claim a `vyre.run` name | Let's Encrypt, by DNS challenge |

A `vyre.run` name is an A record pointing at the box's tailnet IPv4 address (a `100.x` address). It resolves on the public internet, but nothing off your tailnet can reach it. Today the record is written with your own Cloudflare token for the zone (`CLOUDFLARE_vyre_token` in `~/.vyre/env`, or the vault item `cloudflare-vyre-token`). The hosted name directory at `api.vyre.run` is not built yet.

```
vyre name                 # this box's address, its phase and its owner
vyre name check alex      # is alex.vyre.run free?
vyre name claim alex
vyre name ts.net          # use the box's ts.net name instead
vyre name release
```

vyred renews certificates itself, 30 days before they expire, and swaps them into the running listener without a restart. A failing renewal raises `certificate.failed` once fewer than 14 days remain.

## Identity: who is calling

vyred terminates TLS itself on the tailnet interface and runs `tailscale whois` on the source address of each connection. It serves the connection only when all of these hold:

- the peer address is a Tailscale address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`);
- whois names a node other than the box itself;
- the node is not tagged, and its login equals `network.owner`.

Anything else gets `403 not_owner`. A served request reaches tools as the caller `tailnet:<login>`.

No identity header is read. `Tailscale-User-*`, `X-Forwarded-*` and `x-vyre-caller` from the network change nothing.

> [!WHY] Why not trust the headers `tailscale serve` adds?
> Any process on the box can connect to a local port and write any header it likes, including one that names you. The WireGuard source address of a connection is the one thing a local, unprivileged process cannot fake. So vyred terminates TLS itself and asks `tailscale whois` about that address, and Vyre does not use `tailscale serve`.

The browser is not trusted blindly either. `Host` must be the box's name or tailnet address (otherwise `421 misdirected`). Any request other than GET or HEAD must be `application/json`, and if it carries an `Origin`, that must be the box's own address (otherwise `403 denied`). This stops another site open in your browser from sending a form to your box.

## The owner

The box serves one Tailscale login, `network.owner`. When the box joins your tailnet during onboarding, the owner becomes the login that owns the node. A node signed in with an auth key is tagged and has no user; the onboarding page then shows a one-time claim link on the tailnet address, and the first login to open it becomes the owner.

```
vyre owner                        # who the owner is
vyre owner alex@example.com       # change it (on the box's own terminal)
```

## Tailnet identity is not presence

`tailnet:alex@example.com` proves which device and login sent a request. It does not prove that alex is at that device: Claude Code on alex's Mac is on the same tailnet as the same login. So a tailnet caller gets no pass on tools that need a person. The Deck proves [presence](presence.md) with a passkey like every other surface.

## The network settings

These live under `network` in `~/.vyre/config.json`. See [config](../reference/config.md) for the full list.

| Key | Meaning |
|---|---|
| `address` | the HTTPS address the Deck is served at |
| `owner` | the one Tailscale login this box serves |
| `via` | `vyre.run` or `ts.net` |
| `domain` | the zone for names, default `vyre.run` |
| `port` | the tailnet listener's port, default 443 |
| `acme` | `production` or `staging` (development) |
| `box` | on a Mac: the box's address |
| `onboardPort` | on a box: the loopback port of the onboarding page, default 7300 |

## What it will not do

- No passwords, no login screen, no sessions on the tailnet address.
- A connection from the box's own tailnet address is refused: it is a local process, not one of your devices. On a headless box nobody browses locally; on a Mac box, use the Capsule and the CLI.
- Kernel Tailscale is required on the box. In userspace networking mode there is no interface to bind: the onboarding page marks the Tailscale step blocked and says why.
- Root on the box, and anyone who can reach its Docker socket, are out of scope.

## Next

- [Tailscale](../using/tailscale.md): getting your devices onto the tailnet.
- [Tailscale, from zero](../get-started/tailscale.md): an account, MagicDNS, HTTPS and the optional features, step by step.
- [The box and the Mac](box-and-mac.md): how the Mac reaches the box.
- [Presence](presence.md): proving a person is there.
