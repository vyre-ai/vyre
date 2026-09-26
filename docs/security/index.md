---
title: Security
summary: The security model in one page: the floor that cannot be switched off, how the vault seals values, who can reach the box, how agents' containers are locked down, and how to report a problem.
audience: operators, builders, users
owner: integrator
status: stable
---

# Security

Vyre runs Claude Code, and agents, on a machine you own, with your credentials within reach. The model rests on four things: a floor of rules enforced outside the model, a vault that keeps values off every screen, a network that only your own devices can reach, and containers for agents that cannot become root on the box. Each has a decision record with the full threat model; this page is the summary and the index.

## The floor

Nine rules, enforced by the Harness's Rules hook, presence checks in `vyred`, the Gate and the event log, not by asking the model. None can be configured away. The one that matters most for credentials is rule 8: no vault value appears on any screen, log or event, except to a person who has just proved presence on their own device, for that one value. Never to a model, an agent, a log or an event.

Read them all, with what each means in practice, in [The security floor](../concepts/floor.md). The source is [Section 11 of the spec](../architecture/spec.md#11-the-security-floor).

Presence is how Vyre knows a person, not a process, is asking: a passkey or Touch ID check, made by `vyred`, before a human-only action such as revealing a value. A tailnet identity is not presence. See [Presence](../concepts/presence.md) and [ADR 0004](../adr/0004-presence.md).

## The vault

- **Only `node:crypto`.** AES-256-GCM, HKDF-SHA256, HMAC-SHA256, Argon2id (scrypt where Node has no Argon2id), Ed25519 and X25519. No dependency can read what the vault encrypts.
- **A device key, kept out of the data folder.** On a Mac it is in the login keychain, written by a small helper that is the only app allowed to read it (only for the real `~/.vyre`). On Linux it is `vault/key`, mode 0600, owned by the account `vyred` runs as. With the `passphrase` keystore it is nowhere at rest: it is wrapped by a key derived from your passphrase, and the vault stays locked until `vyre vault unlock`.
- **Two vaults.** The device key opens the agents' vault, which holds what agents and modules may be granted. Your personal vault, once you create an account (`vyre vault account create`), opens only with your password and Secret Key, or with Touch ID on a Mac you enrolled. The device key alone does not open it.
- **A key per item version.** Each item version is sealed under its own random key, which is wrapped under its vault's key. The vault, the item's id, its version and its name are bound into the authenticated data, and each row in `vyre.db` carries an HMAC, so a sealed file moved into another slot, or an older version put back, fails to open.
- **Names are listable, values are sealed.** The store holds names, kinds, field names and hosts. Every field value is in `vault/items/`, which the Rules deny to any tool.
- **Release by grant.** A module gets a value only with a grant for exactly that module. When Claude asks for a grant or a pass, it waits as pending until you run `vyre vault approve <id>`.
- **Sharing without handing over.** A pass is relayed by default: the other person's calls go through your box, which adds the credential on the way out, bound to the hosts it may be sent to. Revoking ends access at once. `vyre vault offboard <person>` revokes everything a person holds and lists the sealed items to rotate.

What it does not defend, stated plainly in the ADR: code running as the `vyred` user can read the key the same way `vyred` does; a module you granted an item to is trusted with it; and a process started by `vyre vault run` receives the values in its environment by design (its output is scrubbed of them, which stops accidents, not a determined program).

Details: [ADR 0001](../adr/0001-vault-crypto.md), the key hierarchy in [ADR 0006](../adr/0006-vault-next.md), and autofill in [ADR 0010](../adr/0010-vault-autofill.md). How to use it: [The vault](../using/vault.md).

## Network and identity

- **Only your devices reach the box.** Your address resolves to the box's Tailscale address. On a Docker box the `tailscale` container is the only way in, and it publishes one port to the host: 7300, on `127.0.0.1`, for onboarding.
- **Callers are identified by `tailscale whois` of the WireGuard source address,** never by a header. A process on the host or in another container cannot produce a tailnet source address, so it cannot pose as you.
- **One owner.** The box serves one Tailscale login, set at onboarding (`vyre owner` changes it).
- **Onboarding is loopback only.** Before an owner exists, `vyred` serves one route: the onboarding page, on loopback, behind a one-time token that expires after an hour. It checks the `Host` header, so a page on another site cannot reach it through DNS rebinding.
- **No root.** `vyred` runs as uid 1000 in the container, or as your own login account without Docker, never root. On Linux without Docker, systemd owns port 443 on `tailscale0` and hands it to `vyred`, so `vyred` needs no capability.
- **Vyre keeps nothing about you on its own servers.** The one public trace is the DNS record of a `vyre.run` name, if you claim one: the name and your box's tailnet address, which nothing off your tailnet can reach. (Claude Code and Tailscale talk to their own services as they always do.)

Details: [ADR 0002](../adr/0002-network-and-identity.md), [The tailnet](../concepts/tailnet.md).

## Agents' computers

An agent's computer is a Docker container. The Docker socket is root on the host, so `vyred` never touches it. The `docker-api` service (`core/dockerproxy`, on only with `COMPOSE_PROFILES=computers`) holds the socket and allows only the calls agents' computers use. It checks request bodies too, with the same policy (`core/computers/driver/policy.js`) that builds them:

- `Privileged` is never true, and nothing is bind-mounted: the only mount is the agent's own named volume at `/home/agent`.
- Never the host network or process namespace.
- `CapDrop: ["ALL"]`, no host devices, a read-only root filesystem with small tmpfs mounts, `no-new-privileges`, and Docker's default seccomp profile.
- Every container and volume is labelled, and every per-container call is checked against the labels the Docker Engine itself reports.

One residual is known and recorded: labels tell an agent's computer apart from everything else on the box, but not from another agent's computer, so a caller that reaches the proxy directly can act on any agent's computer. Closing it needs Claude's own sessions to run in a separate container, off that network. That container is not built yet.

Chrome's debugging port inside a computer is never exposed without authentication ([ADR 0012](../adr/0012-cdp-proxy.md)). Details: [ADR 0009](../adr/0009-container-hardening.md), and Glass's stream in [ADR 0003](../adr/0003-glass-stream.md).

## Backups

`vyre backup` writes config, the store, the sealed vault, watchers, modules, certificates and names into one file, mode 0600. It contains the sealed vault. Keep it somewhere only you can read, or encrypt it. `vyre vault backup <file>` seals the whole vault to a passphrase of its own. See [Looking after the box](../using/box-care.md).

## Report a problem

If you find a security problem, report it privately to the maintainers. Do not open a public issue, and do not include a working exploit against someone else's box.

Email security@vyre.run. Include what you found, the commit or version (`vyre version`), and the steps to see it.

## Where to go next

- [The security floor](../concepts/floor.md)
- [The vault](../using/vault.md)
- [Architecture](../architecture/index.md)
