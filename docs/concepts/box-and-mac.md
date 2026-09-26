---
title: The box and the Mac
summary: What runs on your server and what runs on your Mac, why each machine runs one vyred, and how the two talk over your tailnet.
audience: users, builders, operators, agents
owner: integrator
status: stable
---

# The box and the Mac

Vyre runs on two kinds of machine. The **box** is a server you own (or a Mac you choose to use as one): Claude Code sessions, agents, watchers and the Deck live there. The **Mac** is the computer you sit at: it runs the Capsule and your own terminal sessions, and reaches the box over your private [tailnet](tailnet.md). Each machine runs one `vyred`, the Vyre daemon, with a different set of [modules](modules.md) switched on.

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
| Box only | `names` (address, certificates, the tailnet listener), `network`, `onboard`, `hooks`, `computers`, `glass`, `chrome`, `hands-desktop` |
| Mac only | `capsule`, `hands` (computer use on macOS) |
| Both | `projects`, `recall`, `memory`, `vault`, `watchers`, `threads` (the Switchboard), `agents`, `gate`, `learn`, `harness`, `presence`, `link`, `files`, `push`, `system`, `mcp`, `google`, `statusline` |

A module that runs on both machines works on that machine's own data: recall on the Mac searches the Mac's Claude Code transcripts, recall on the box searches the box's. The one exception is reading: on the box, you see the paired Mac's sessions beside the box's own, read through the link (see [The box reads the Mac's sessions](#the-box-reads-the-macs-sessions)). `vyre modules` lists what started on the machine you run it on, and why anything failed.

You can move a module on or off with `modules.enable` and `modules.disable` in `config.json`. `enable` starts a module even when its roles do not include this machine's role.

## What runs where on a Linux box

A Linux box runs Vyre in Docker Compose, from `/srv/vyre`. The stack is `box/compose.yml`:

- `tailscale`: the official Tailscale image with kernel networking, so `tailscale0` is a real interface. It is the only way in.
- `vyre`: vyred and Claude Code, as uid 1000, inside the `tailscale` container's network namespace (`network_mode: service:tailscale`). vyred binds the tailnet addresses on port 443 itself.
- `docker-api`: a filtered Docker API for the agents' computers, under the `computers` profile.

The only published port is the onboarding page, on the host's `127.0.0.1:7300`. The host needs Docker and nothing else. A small `vyre` wrapper in `/usr/local/bin` runs commands inside the container, so `vyre status` on the host works as it does on a Mac.

> [!WHY] Why does vyred share the tailscale container's network?
> vyred identifies every caller by the WireGuard source address of the connection (`tailscale whois`), never by a header. To see that address it must terminate the connection itself on the real `tailscale0` interface, which lives in the `tailscale` container. Sharing that container's network namespace gives vyred the interface, so there is no `tailscale serve` in front of it and no proxy that could pass on a forged identity. The `vyre` service has no network of its own, so nothing on the host or in another container reaches vyred's tailnet listener except over WireGuard.

The alternative without Docker is a systemd unit, installed with `sudo vyre up --system --user <account>` (the account vyred runs as, never root). See [without Docker](../get-started/without-docker.md).

### Who can reach the box

- **The `tailscale` container is the only way in.** It runs the official image with kernel networking and publishes one port: 7300, on the host's `127.0.0.1`, for the onboarding page.
- **vyred has no network of its own.** It binds the tailnet addresses on 443 and serves them with its own certificate: `tailscale cert` for the box's ts.net name, or an ACME certificate for a `vyre.run` name. There is no `tailscale serve` in the path.
- **Callers are identified by `tailscale whois` of the WireGuard source address**, never by a header. A process on the host, or in another container, cannot produce a tailnet source address, so it cannot pose as you.
- **The onboarding listener binds only the `vyred` alias on the `vyre` network**, where Docker delivers the published port, never `0.0.0.0`, which would include `tailscale0`. It also needs the one-time token in the link, and answers "Not here." to any `Host` other than its loopback address and port. That is why the tunnel uses port 7300 on both ends.
- **vyred runs as uid 1000 (`vyre`), not root.** It is Tailscale's operator, so it can run `tailscale up` and `tailscale cert` from the onboarding page.

The reasoning is in [ADR 0002](../adr/0002-network-and-identity.md).

### Folders and volumes

The installer puts the stack in `/srv/vyre` (`VYRE_DIR` moves it), owned by you, not root:

```
/srv/vyre/
  compose.yml          the stack: tailscale, vyre, and docker-api under the computers profile
  compose.build.yml    used when COMPOSE_FILE lists it: build the image from VYRE_SOURCE
  src/                 the unpacked vyre.tgz, when the image is built from it
  vyre.env.example     copy to vyre.env for CLOUDFLARE_VYRE_TOKEN and similar
  vyre.env             optional, yours, read by the vyre container
  .env                 COMPOSE_PROJECT_NAME, COMPOSE_FILE, VYRE_SOURCE, DOCKER_GID; yours to add TS_AUTHKEY, COMPOSE_PROFILES
/usr/local/bin/vyre    the host wrapper
```

The data lives in Docker volumes, all labelled `run.vyre=1`:

| Volume | Mounted at | Holds |
|---|---|---|
| `vyre_vyre-home` | `/home/vyre` | `.vyre/` (Vyre's home folder, below) and `.claude/`, `.claude.json` (Claude Code's own state and transcripts) |
| `vyre_vyre-work` | `/work` | projects |
| `vyre_tailscale-state` | `/var/lib/tailscale` | the node's identity; delete it and the box is a new node |
| `vyre_tailscale-sock` | `/var/run/tailscale` | tailscaled's socket, shared with the `vyre` container |

A container can be recreated at any time: nothing in it matters but the volumes. Backing them up and moving them is in [Box care](../using/box-care.md).

### Vyre's home folder

Every vyred keeps its state in one folder, `~/.vyre` (mode 0700), with the same layout on every machine:

::: tabs
::: tab On a server
On a Docker box it is `/home/vyre/.vyre`, inside the `vyre_vyre-home` volume.

```
/home/vyre/.vyre/
  config.json             settings (0600); onboarding writes name, network, onboard
  vyre.db, -wal, -shm     the store (SQLite, WAL)
  vault/                  sealed vault items
  certs/                  acme-production.key, <name>.crt, <name>.key
  names/                  the name directory key, once the hosted directory exists
  modules/, watchers/     what you installed and what Claude wrote
  embedder/               the search model's library (about 105 MB), fetched on first use: safe to delete
  models/                 the search model's weights (about 23 MB), a cache: safe to delete
  logs/                   YYYY-MM-DD.log from vyred
  vyred.sock, vyred.pid
```
::: tab On this Mac
On the Mac it is `~/.vyre` in your own home folder. It has the same store, vault, search model and logs, and no `certs/` or `names/`, because the Mac serves nothing on the tailnet. It also holds `link.json` (0600), the key that pairs this Mac with its box, and `logs/capsule.out`, the Capsule's log.
:::

### Claude Code on the box

- Claude Code is installed in the image (`npm install -g @anthropic-ai/claude-code` at build). Its state, `~/.claude/` and `~/.claude.json`, lives in `vyre_vyre-home`, so a new image keeps it.
- **Sessions Vyre runs headless** (the assistant, agents) use the credential from the onboarding's Claude Code step, which lives in the Vault as `claude-setup-token` (a subscription token) or `anthropic-api-key`. Each session gets it in its environment at start (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), never in a file.
- To run `claude` by hand on the box, run it in the container:

  ```
  cd /srv/vyre && docker compose exec vyre claude
  ```

  Its transcripts land in the same `~/.claude/projects/`, which is how Vyre's history sees them.

### The agents' computers

Agents get their own containers ([Specification](../architecture/spec.md#79-computers--workstream), Section 7.9) through `docker-api`, Vyre's own Docker proxy (`core/dockerproxy`, run from the same image). It is off until the `computers` profile is on; turning it on is in [Box care](../using/box-care.md#turn-on-agents-computers).

- The host's Docker socket is mounted into the proxy and nowhere else. vyred reaches it at `http://docker-api:2375` on an internal network.
- The proxy allows only what agents' computers use (create, start, stop, pause, unpause, inspect, list, remove, exec on a computer, volume inspect) and refuses every other endpoint.
- It checks request bodies too: a create must match `core/computers/driver/policy.js` and the box's `VYRE_COMPUTERS_*` settings, and every per-container call is checked against the labels the Docker Engine itself reports.
- It runs as uid 1000 with a read-only root, no capabilities, and the socket's group, `DOCKER_GID` in `/srv/vyre/.env`, which the installer fills in from the socket.

> [!WHY] Why a proxy, and not the Docker socket?
> Whoever holds the Docker socket is root on the host. The proxy keeps the socket in one small container and lets vyred ask only for the calls a computer needs, so a mistake or a prompt injection in a session cannot turn into a privileged container.

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

- **Pairing.** On the Mac, `vyre link pair <address>` (or `vyre up`) asks the box and shows a code. The Deck shows the request on Now, and on onboarding's **Your devices** step: type the code, press **Approve**, and confirm with your passkey (see [presence](presence.md)). The approval must come from another of your devices, such as your phone: the box refuses one from the Mac that is asking. The Mac keeps a link key in `~/.vyre/link.json` (mode 0600) and pins the box's Tailscale node, so a different node at that address is refused.
- **Box tools from the Mac.** A module on the Mac calls `ctx.remote(tool, input)`; a surface calls `link.call`. Both reach `POST /v1/tools/<tool>` on the box.
- **Box events on the Mac.** The Mac proxies the box's event stream at `/v1/link/events`, so the Capsule sees box threads as they happen.
- **The Mac's sessions on the box.** The box reads the paired Mac's sessions through the link. See the next section.

> [!GAP]
> The Deck open on the Mac being paired cannot approve that Mac. Approve it from your phone or another device. See [known gaps](../known-gaps.md#approving-a-mac-in-the-deck).

```
vyre link                 # on the Mac: paired or not, and whether the box answers
vyre link pair https://vyre.tail1234.ts.net
vyre link unpair          # forget the box
```

## The box reads the Mac's sessions

Your Claude Code history stays on the Mac. The box reads it through the link when you ask, so the Deck on the box, and your phone, list the Mac's sessions beside the box's own ([ADR 0021](../adr/0021-box-reads-the-mac.md)).

- **No port on the Mac.** While paired, the Mac holds one request open to the box (`link.serve`). The box answers it with a question, or with nothing after 60 seconds; the Mac runs the question and sends the answer back (`link.reply`), then asks again. An idle Mac costs one request a minute.
- **Six read tools, nothing else.** Only `projects.catalog`, `projects.list`, `recall.search`, `recall.sessions`, `recall.thread` and `threads.list` cross, and both ends check the list (`core/link/allow.js`). The Mac runs them as `module:link`.
- **Only for you.** On the box these tools take `machines: "all"` or `"local"`. They ask the Mac when you call them from the Deck, the CLI, the Capsule or your own device on the tailnet, or when a module passes `machines: "all"`. Agents, MCP and guests get the box's rows alone. Each row the Mac sends is labelled `source: "mac"` and `machine` (the Mac's paired name); the box's rows say `source: "box"`.
- **Nothing is copied.** Nothing the Mac answers is written to the box's store. Only `recall.thread` carries a conversation, and only when you open a session the box does not have.
- **Read-only on the box.** The Deck shows a Mac session with the Mac's name on a chip and the note "On alex-mac. Open it there to continue.": no composer, no **Take**. You can add a Mac session to a box project; the project's thread list reads it from the Mac.
- **An absent Mac is an answer.** A Mac that is not polling answers `mac_offline` at once and the box shows its own rows, with an "alex-mac offline" chip read from `link.macs`. A slow Mac delays a read by at most 5 seconds. A Mac that dropped off in the middle of a request looks online for up to a minute, and a read in that window ends in `timeout`.

The box cannot search the Mac's files: files are not on the list.

## When the box is away

The Mac keeps working without the box (floor rule 9, see [the security floor](floor.md)). Once a call to the box fails, the next ones fail fast with `box_unreachable` and are retried with a growing pause, up to 30 seconds. The link emits `link.lost` and, when the box answers again, `link.connected`. A module that asked the box for something gets the error at once and can fall back to what the Mac has.

## What it will not do

- The Mac never serves the Deck on the tailnet. The Deck lives on the box.
- The box never trusts the Mac because of a header or a shared secret alone: every connection is identified by its tailnet source address first.
- Link tools on the box (`link.*`) cannot be driven through `ctx.remote` or `link.call`.
- The box never runs a tool on the Mac outside the six reads above, and never sends into a Mac session.

## Next

- [The tailnet](tailnet.md): addresses, identity and certificates.
- [Presence](presence.md): why approving a pairing needs you, not a model.
- [Box care](../using/box-care.md): updating, backing up and moving the box.
