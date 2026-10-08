---
title: "ADR 0050: The built-in network"
summary: Vyre carries its own traffic. Each server runs Headscale, desktops and Android run a Vyre-managed open-source client core, the iPhone goes through the relay, and the person only ever sees Wink. This replaces ADR 0046's Tailscale transport.
audience: builders
owner: network
status: stable
---

# ADR 0050: The built-in network

Status: accepted, 2 Oct 2026 (the user's decision), built for 0.3.0 · Workstream: network · Supersedes ADR 0046 (the relay introduces, Tailscale carries) and the transport of ADR 0014 (tailnet) · Builds on ADR 0026 (the relay), ADR 0045 (Wink tickets), ADR 0051 (the identity chain).

## Context

Through 0.2.12 a server signed in to Tailscale once at setup, and every device joined that tailnet. ADR 0046 made the relay introduce devices and Tailscale carry the traffic. That meant a second product's account, app, login and policy in the person's way, and a tree full of files that name it.

The user's decision on 2 Oct 2026: no Tailscale for the person. "I wanna go full built in network."

## Decision

1. **A person never sees another VPN product.** No account, app, login, key or policy.
2. **The network is Headscale per home, with an open-source client core underneath, managed by Vyre.** A server runs Headscale (pinned by hash in the server image), a gate and a forwarder, started by the Wink module (`core/wink/netd.js`). Desktops (Mac, Windows, Linux) and Android run the client core. The product name for all of it is **Wink**.
3. **Wink is the only interface.** A device joins by scanning a code, or by typing a short code and typing the other device's answer back (ADR 0045). The join key is sealed inside the pairing. There is nothing else to configure.
4. **The iPhone is relay-first with no VPN.** An iOS VPN app needs an organisation Apple account, and an embedded node in the app is unproven.
5. **The relay is always the first working path and the fallback.** It carries pairing, signalling, push and the encrypted fallback, and sees ciphertext and timing only. It is hosted on Cloudflare Workers (the hosted relay), or self-hosted as one container.
6. **A direct path is tried and proven.** The server reports IPv6, then asks the router for a port with UPnP, then NAT-PMP. A path is called direct only after the relay dials the address back from outside. Without that proof it stays "relay".
7. **Identity does not come from the network.** The old rule "who is on the tailnet is who they are" is gone. A peer is a device paired to the person's identity chain (ADR 0051), proved by its signed hello. Code that read `tailscale whois` or decided by a login or a tag moves to `device:<id>`, the signed envelope or a presence proof.
8. **A public gate, for the few things that must be public.** A server may publish an address through the names directory. The gate terminates TLS (ACME, port 7443) and admits only exact shapes: `POST /hooks/<route>` and `GET /s/<token>`.
9. **Tagged nodes, guests and exit nodes are not carried over.** Agent nodes, guests and Taildrop and Taildrive are gone. Files move over Vyre's own stream transfer. Glass egress over Wink is 0.3.1.

## What this changes

- ADR 0046 and the transport of ADR 0014 are superseded. They stay as history, with a note at the top.
- `docs/concepts/network.md` is the plain account for a person.
- `test/no-tailscale.test.js` walks the tree for the other product's name. A file may name it only if it is permanent (the engine that is built from the open-source client, history and decisions, redactors that exist to catch the product's strings) or is on the ratchet list `test/no-tailscale.ratchet.json`. The ratchet only shrinks: a file that gains the word fails, and a file on the list that has lost it must come off. Each merge that cleans a file takes the count down.
- A server that already has Tailscale installed is left alone. Vyre does not use it and does not remove it.

## Consequences

- Nothing a person installs or signs in to is a second product.
- Direct paths through home routers (UPnP, NAT-PMP, IPv6) are tried on servers with public addresses and not yet on real routers. The relay carries everything until a direct path is proven, so nothing waits on it.
- The Mac installer carries Headscale and the forwarder. Where there is no Docker, the network reports itself as unavailable and the relay carries the traffic (see [Without Docker](../get-started/without-docker.md)).
- Installs from 0.2.x migrate on the person's click. Nothing is removed from their machine without it.
