---
title: Relay and networking
summary: How a server and its devices find each other through an always-working encrypted relay, a name directory, the built-in Wink network and optional direct paths.
audience: builders, agents
owner: docs
status: stable
---

# Relay and networking

## What it is

A server dials out to the relay, and a device meets it there over an end-to-end encrypted channel. This path always works. Around it sit the name directory (`<name>.vyre.run`), the built-in Wink network that pairs devices and tries a direct path, and `vyre doctor`, which says which path is in use.

## What a person sees

- **Devices** screen (`apps/app/app/devices.tsx` with `apps/app/screens/devices/DevicesScreen.tsx`, headed "Devices"): each paired device with "This device" or "This browser", whether it is connected through the relay or direct, and its round trip. Adding a device is "Add a device".
- **Sign in by name**: a new device types the person's name and asks to sign in. Devices already signed in are asked "Sign in on [device]? These words should match", the new device shows the same three words, and one Approve adds it. A request lasts 2 minutes.
- **Address**: `vyre name` prints the name the server serves and its phase; `vyre name check alex` says whether `alex.vyre.run` is free.
- **`vyre doctor`** shows four network lines: **Path to your server** ("direct", or "through the relay ... (no direct path yet)"), **Relay** ("answering"), **Server door** and **Clock**. Each failure names one thing to do next (`core/cli/commands/doctor.js`).
- A device that types a code instead of scanning uses `apps/app/screens/devices/TypeCode.tsx`.
- Settings, Devices group: "Web links through the relay last (days)" (default 30) and "Public address for signing pages and shared links" (`relay.tunnel_url`).

## How it works

**Relay channel.** The box holds two keys in `~/.vyre/relay/keys.json` (mode 0600): `box.key`, the Noise static key, and `route.key`, which proves the route to the relay (`core/relay/keys.js`). `core/relay/link.js` keeps one signed control socket and one data socket per device connection the relay announces; a text ping every 60 s, two missed pings end the socket, reconnect backoff runs from 1 s to 5 minutes. Each data socket runs Noise `Noise_IK_25519_AESGCM_SHA256` (`core/relay/noise.js`, `core/relay/channel.js`): the device is the initiator, so the relay sees ciphertext only. Frames are head, data, end, reset, ping, pong over numbered streams. `core/relay/bridge.js` turns each stream into a real HTTP request to the daemon's own router, with the caller the relay established, so every route and check works as on a local socket.

**Admission.** `admit` decides who gets in. A device is named `device:<id>`. `core/relay/chain-admit.js` admits a device that a person's identity chain lists, for an identity that already has a role on this server, with a signed hello bound to the box id, a 2 minute window and a replay set. A device that is not an owner's or not on a chain cannot reach the owner's powers: a browser paired from the hosted web app is limited until trusted from another device and expires after `relay.web_expiry_days` unused. The classic pairing code is removed; `relay.join` and the old `vyre relay pair` are refused with words naming the next step (`core/relay/classic-removed.test.js`).

**Pairing as grants (Wink).** `core/wink/` makes every way in a Wink: a QR or pasted long code (`wink.phone.open`, `wink.phone.scan`), a typed two-sided code (`wink.code.open`, `wink.code.redeem`), an invite (`wink.invite`), lending a computer (`wink.share`), and storage devices (`wink.storage.*`). Both sides show the same three words and a person says yes (`wink.phone.pair.answer`). Devices belong to the identity and are enrolled per Space (`core/wink/pairing.js`, registry `wink_devices`). One removal (`wink.remove`) undoes the grant. Events include `wink.offered`, `wink.joined`, `wink.removed`, `wink.pair-done`, `wink.signin-asked`, `wink.network-changed`; the relay emits `relay.connected`, `relay.disconnected`, `device.paired`, `device.removed`, `pairing.requested`, `relay.signin-asked`.

**Built-in network.** `core/wink/netd.js` starts, on a server home, one Headscale per Space on loopback, a gate in front of it, a Wink node and the node host's door, with states `off`, `no-binary`, `starting`, `up`, `failed`; on any failure the relay still carries everything. `network.wink.status`, `network.wink.whois`, `network.wink.join`, `network.wink.leave` (`core/network/wink.js`) are the public names; join and leave need the owner and presence. Whois answers from the identity list and sessions the door admitted, never from tags a peer could set. The gate carries only `POST /hooks/<route>` and `GET` or `HEAD /s/<token>` from the internet.

**Tailscale is optional.** Vyre never installs, signs in to or asks for Tailscale. `core/network/other-vpn.js` runs `tailscale status --json` and, if another VPN client is running, Wink does not start a node and the link stays on the relay.

**Direct paths vs relay.** `core/wink/reach.js` tries, in the background and in order, IPv6, UPnP and NAT-PMP. A path is called direct only after `verify` reached it from outside (the relay dials the address back, `POST /v1/reach/check` in `relay/node/server.js`); otherwise the state stays "relay" and `tried` says why. A router that reports a private or carrier-grade external address is said not to be reachable. `relay.devices.path` lets a paired device report which way it reaches the box and its round trip.

**Names.** `core/names` holds `<name>.vyre.run`: `names.status`, `names.check`, `names.domain.check` (anyone), `names.serve`, `names.unserve` (person). A server never holds a name; it serves a Space's name and asks the hosted directory (signed with the relay route key through `relay.route.id` and `relay.route.sign`) to point it at the server and write the certificate challenge. Events: `name.claimed`, `name.moved`, `name.released`. Backup and sealing helpers are in `core/names/backup.js` and `core/names/seal.js`.

**Relay server.** `relay/worker/index.js` is the Cloudflare Worker with a Durable Object per route; `relay/node/server.js` is the same protocol in plain Node for self-hosting (`relay/README.md`, `relay/compose.yml`). Routes: `GET /v1/box`, `GET /v1/device`, `POST /v1/wink/code`, `POST /v1/pair`, `POST /v1/setup/mbx`, `GET /health`. The relay keeps nothing on disk. `relay/app/` serves the web app at app.vyre.run from static assets; `relay/wink/` is the camera page for scanning a ring; `relay/client/` is the device side.

## Where the code lives

- `core/relay/`: box side (`index.js`, `link.js`, `channel.js`, `noise.js`, `bridge.js`, `chain-admit.js`, `peers.js`, `setup.js`, `keys.js`).
- `core/wink/`: pairing, grants, storage devices, `netd.js`, `reach.js`, and `control/` and `node/` for the built-in network.
- `core/network/`: public `network.wink.*` names and `other-vpn.js`.
- `core/names/`: `<name>.vyre.run` service and directory client.
- `relay/worker/`, `relay/node/`, `relay/app/`, `relay/wink/`, `relay/client/`, `relay/deploy/`: relay servers, web app host, camera page, device client, deploy files.
- `core/cli/commands/doctor.js`: the checks; `lib/publish/tunnel.js`: the tunnel end for public sites.

## How agents use it

- Open to models: `relay.status`, `relay.setup.status`, `names.status`, `names.check`, `names.domain.check`, `network.wink.status`, `network.wink.whois` (reads, no secrets).
- Person-only: `relay.enable`, `relay.disable`, `relay.devices.list`, `relay.devices.remove`, `relay.devices.trust`, `network.wink.join`, `network.wink.leave`, `names.serve`, `names.unserve`, and nearly every `wink.*` act, which needs presence. Module-only tools (`relay.ticket.mint`, `relay.devices.all`, `relay.route.sign`) are not reachable by a model.
- An agent adds, removes and pairs no device. The person approves on a device. See authority (agent doc "authority") and tools (agent doc "tools").

## Extend it

- In 0.5 the relay carries every connection. Direct paths (IPv6, UPnP, NAT-PMP) were tried on servers with public addresses, not behind a home router, so a connection may stay on the relay. `vyre doctor` shows whether the path is direct.
- Pairing runs by signing in with the person's name and approving on a device already signed in. Continue with GitHub needs the relay Worker and the escrow Worker deployed, and every server updated first.
- If the person runs another VPN, Wink starts no node and the link stays on the relay. A team server does not accept the key of a Windows PC with no Hello ([Identity and devices](./identity-and-devices.md)). The phone apps are not yet walked on real devices.
- To add another way in or another kind of path, write a custom module. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related

- [Identity and devices](./identity-and-devices.md), [Spaces and members](./spaces-and-members.md), [Kernel](./kernel.md), [Sites and publishing](./sites-and-publishing.md), [Vault](./vault.md), [MCP and engineer](./mcp-and-engineer.md)
- [Map](../map.md), [Overview](../overview.md)
- [Your private network](../../concepts/network.md), [Box and Mac](../../concepts/box-and-mac.md), [Presence](../../concepts/presence.md), [Windows](../../using/windows.md)
- [Known gaps](../../known-gaps.md), [CLI reference](../../reference/cli.md)
