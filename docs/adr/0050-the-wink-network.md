---
title: "ADR 0050: The Wink network"
summary: Every space owns a network run by Vyre, not by the person. A Headscale on each space's home server, a Vyre-managed open-source Tailscale client core ("Wink") on desktops, Android and servers, the iPhone relay-first, and the relay as the floor. One interface: scan a code, or type one. Supersedes the Tailscale transport of ADR 0046.
audience: builders
owner: tailnet
status: draft
---

# ADR 0050: The Wink network

Status: proposed, 2 Oct 2026 · Workstream: tailnet · Supersedes the Tailscale transport of ADR 0046 ("The relay
introduces, Tailscale carries") · Amends ADR 0002 (network and identity) · Builds on ADR 0014 (tailnet), ADR 0026 (the relay),
ADR 0045 (Wink), ADR 0048 (the setup session and the name directory) and the 0.2.5 Spaces design.

## Context

Until now a person needed a Tailscale account to link their devices to their server, and every feature that crossed machines
(Drive, file send, agent computers, guests) leaned on Tailscale's policy, whois and admin console. The product decision of
2 Oct 2026 is that a person never sees a Tailscale account, app, login, key or policy: "no tailscale, I wanna go full
built in network". The Spaces design already makes a **space** the unit that owns data, members, grants, compute and modules.
This decision gives each space a network of its own and one way in.

## Decision

1. **A space owns its network.** The personal space and each org space has its own **Headscale** control plane on its home
   server. vyred supervises it (configuration, keys, access rules, health, restarts); a person or an org admin never installs
   or sees it. Two spaces never share a network.
2. **The data plane is the open-source Tailscale client core, managed by Vyre and called Wink.** It runs on servers (Linux),
   desktops (Mac, Windows, Linux) and Android. It connects only to the control URL, control key and relay map pinned in the
   sealed pairing record, and hard-disables everything else a control server could ask of it.
3. **Wink is the only interface.** A phone scans a code; a computer types `WINK-NNPP-PPPP`. Every flow ends in a card the
   approver reads and a grant the person can later remove. The typed code is the password of a password-authenticated key
   exchange, with a rendezvous part separate from the password part.
4. **The iPhone is relay-first with no VPN**, and browsers are relay-only. The relay (Cloudflare Workers, or a self-hosted
   container) carries pairing, signalling, push and the encrypted fallback. It is correct without the network and fast with it.
5. **A device talks to its own home server.** The home server is the only thing that joins an org's network, as an isolated
   outbound-only doorway, and it forwards the org's traffic as ciphertext it cannot read. A device never joins an org's network.
6. **Identity is the device's Noise key.** A network node is a path, never an identity. A node reaches nothing until its key is
   bound to a live device row by that device's own proof; the caller is then `device:<id>`. Access rules are generated from
   device rows, never from tags.
7. **Reachability decides only whether a device gets the direct path.** A public address, UPnP, IPv6, a tunnel on the person's
   own account, a small server of their own, or the relay alone. The relay path always exists.
8. **No Tailscale features are used.** Taildrive, Taildrop, SSH, exit nodes and tags as identity are not part of the product.
   VyreDrive, VyreDrop and VyreVault ride Vyre's own channel.
9. **Machines are nodes with capabilities, and work needs three yeses.** A node offers capabilities (client, compute, storage,
   browser, gpu, ingress, always on, presence). Placing work on a node needs the space's grants, the node owner's consent for that
   space, and the space's residency policy, which can forbid member machines even when they are online. A session belongs to a
   space, not to the machine running it. Wink translates roles, consent and policy into network and data grants, and the network
   is replaceable behind one interface.
10. **Version policy.** v0.2.x keeps Tailscale and is not broken. 0.3 migrates installs in a dual mode that the person ends with
   one click; Vyre never touches the person's own Tailscale.

## Consequences

- The control plane is a public surface on every public home (a stock client talks to it directly). Only the key, the control
  upgrade and the DERP paths are exposed; the admin interfaces are private Unix sockets; registration needs a single-use,
  minutes-long key created after the person's confirm; Headscale and the client core are pinned in the signed release with a
  floor on the client.
- ADR 0002's rule that the Tailscale container is the only way in is replaced: a home publishes the control paths and the
  UDP ports, and the names directory gains two rule changes (claim without publishing an address; a second record class for
  the control URL's public address).
- The 45-file `tailnet:<login>` caller seam does not go away at once. New code does not add to it; the signed companion
  envelope and `device:<id>` carry identity, and `tailnet:` is removed after the last migrated install.
- Per-project encrypted folders with key leases and crypto-shred on revoke are proposed alongside (spec section 3.5), owned by
  the vault, and are not binding until reviewed.

## Alternatives considered

- **Userspace nodes in every app (the first plan).** Keeps identity work and cannot give browsers or the iPhone's system
  route; about 830 to 1,290 agent-hours.
- **WebRTC data channels.** Fewer moving parts and browsers join, but it is a new link layer and drops the general network that
  VyreDrive mounts and a system VPN give; kept as the plan B if the iPhone relay path proves too slow.
- **The person's own Tailscale account through the API.** Re-creates the sign-up this decision removes.

## Security conditions

The threat model uses twenty entry conditions from the security review: a peer never shares a listener or trust class with a
local caller; every control surface is a private socket; the public control port exposes only what a client needs, in its own
uid and container; registration only with a single-use key after the confirm; embedded relay only for registered keys; pinned
versions; an unbound node reaches nothing; the client core trusts only its pinned control URL and accepts no route, DNS,
exit node, SSH, file receive or callback; coexistence with another VPN is specified; the typed code's strength is stated in
bits against what an attacker can probe, with the attempt counter on the showing device; the org doorway is isolated; key
leases are enforced by the server withholding the next wrap; every new caller kind is in the boundary test; a fresh home
accepts no registration before the first owner is confirmed at the console; the residuals are listed. They are numbered
EC-1 to EC-20 in the workstream notes and each becomes a test in the phase that builds it.

## Open

Unverified until the spike: whois fields on Headscale, tunnel and forwarder paths for the control upgrade, Headscale's cost on a
small server, the Mac daemon's prompts without a Developer ID, Android's VPN consent and Play declaration, the iOS
AutoFill extension's memory for a Noise client, and the relay's cost per packet.
