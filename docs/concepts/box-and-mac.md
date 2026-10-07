---
title: The box and the Mac
summary: What runs on your server and what runs on your Mac, why each machine runs one vyred, and how the two talk over your private network.
audience: users, builders, operators, agents
owner: integrator
status: stable
---

# The box and the Mac

Vyre runs on two kinds of machine. The **box** is a server you own: a Linux machine, or a Mac that stays on. Your sessions, agents and watchers live there, and the Vyre app talks to it. The **Mac** is the computer you sit at: it runs Lumen and your own terminal sessions, and reaches the box over your private [network](network.md). A Windows PC is a device in the same way as the Mac, with an app instead of Lumen (see [Windows](../using/windows.md)). Each machine runs one `vyred`, the Vyre daemon, with a different set of [modules](modules.md) switched on.

## One process per machine

`vyred` is the same program everywhere. The machine's kind, `machine` in `~/.vyre/config.json`, decides what it starts:

| Machine | Where | What it starts |
|---|---|---|
| `server` | a Linux server, or a Mac you chose as the server | the whole set, including the address the Vyre app connects to and the relay |
| `solo` | a Mac with nobody else to connect (the default on macOS) | the full local set, Lumen included, and nothing that serves other devices |
| `device` | a computer that joins a server (the default on Windows) | the local set that reaches the server |

A Linux machine defaults to `server`. A Mac starts as `solo`, and becomes a server when you choose to make it the server for My Cloud, or run the Mac server installer. Older configs that say `"role": "box"` or `"role": "local"` still work and are read as server and as solo. See [config](../reference/config.md).

Every module declares the machines it runs on (`"roles"` in its `module.json`: `box`, `local`, or both when omitted). What that means today:

| Runs on | Modules |
|---|---|
| Server only | `names` (address and certificates), `network`, `hooks`, `computers`, `glass`, `artifacts`, `releases`, `hands-desktop`, and the box's side of `chrome` |
| Mac only | `capsule` (Lumen), `hands` (computer use on macOS), `screen`, `sideview`, `voice`, `apps`, and the Mac's side of `chrome` |
| Both | most of the rest, including `projects`, `recall`, `memory`, `vault`, `watchers`, `threads`, `sessions`, `agents`, `gate`, `learn`, `harness`, `presence`, `link`, `relay`, `onboard`, `github`, `team`, `spend`, `files`, `push`, `settings` and `update` |

[Modules](../reference/modules.md) has the full list with each module's machines. A Mac chosen as the server runs the Mac-only modules too, so Lumen stays on it.

A module that runs on both machines works on that machine's own data: recall on the Mac searches the Mac's Claude Code transcripts, recall on the box searches the box's. The one exception is reading and messaging a session: on the box, you see the paired Mac's sessions beside the box's own and can message them, through the link (see [The box reads the Mac's sessions](#the-box-reads-the-macs-sessions)). `vyre modules` lists what started on the machine you run it on, and why anything failed.

You can move a module on or off with `modules.enable` and `modules.disable` in `config.json`. `enable` starts a module even when its roles do not include this machine's kind.

## What runs where on a Linux box

A Linux box runs Vyre in Docker Compose, from `/srv/vyre`. The stack is `box/compose.yml`:

- `vyre`: vyred and the sessions it runs. A small spawner starts vyred as uid 1000 (`vyre`) and the sessions Vyre runs itself as a second user, `vyre-agent` (uid 1001), which cannot open vyred's socket. vyred reaches your other devices over Wink, Vyre's own network core, which it runs itself: there is no sidecar container, no TUN device and no extra capability.
- `docker-api`: a filtered Docker API for the agents' computers, under the `computers` profile.

The container publishes no port on the host. The host needs Docker and nothing else. A small `vyre` wrapper in `/usr/local/bin` runs commands inside the container, so `vyre status` on the host works as it does on a Mac.

The alternative without Docker is a systemd unit, installed with `sudo vyre up --system --user <account>` (the account vyred runs as, never root). See [without Docker](../get-started/without-docker.md).

### Who can reach the box

- **No port is published on the host.** A server has no first-run page: you pair it from your Vyre app.
- **The built-in network and the relay carry every connection.** Your devices reach vyred through them, not through a port on the host. See [your private network](network.md).
- **Callers are identified from the identity list**, never by a header. A device that reaches the box arrives as `device:<id>`, and the entry on your identity list says who it is.
- **vyred runs as uid 1000 (`vyre`), not root.** Only the spawner is root in the container, with every capability dropped except the few it needs to start a process as another user.

The reasoning is in [ADR 0002](../adr/0002-network-and-identity.md).

### Folders and volumes

The installer puts the stack in `/srv/vyre` (`VYRE_DIR` moves it), owned by you, not root:

```
/srv/vyre/
  compose.yml          the stack: vyre, and docker-api under the computers profile
  compose.build.yml    used when COMPOSE_FILE lists it: build the image from VYRE_SOURCE
  src/                 the unpacked vyre.tgz, when the image is built from it
  vyre.env.example     copy to vyre.env for CLOUDFLARE_VYRE_TOKEN and similar
  vyre.env             optional, yours, read by the vyre container
  .env                 COMPOSE_PROJECT_NAME, COMPOSE_FILE, VYRE_SOURCE, DOCKER_GID; yours to add COMPOSE_PROFILES
/usr/local/bin/vyre    the host wrapper
```

The data lives in Docker volumes, all labelled `run.vyre=1`:

| Volume | Mounted at | Holds |
|---|---|---|
| `vyre_vyre-home` | `/home/vyre` | `.vyre/` (Vyre's home folder, below) and `.claude/`, `.claude.json` (Claude Code's own state and transcripts) |
| `vyre_vyre-work` | `/work` | projects |
| `vyre_vyre-agent-home` | `/home/vyre-agent` | the home of the sessions Vyre runs (their own `~/.claude` and transcripts) |
| `vyre_vyre-accounts` | `/home/acct` | one private home per signed-in AI account (uids 2000 to 2063), holding that account's own login |
| `vyre_docker-api-bearer` | `/var/lib/vyre-secrets` | the secret vyred uses to talk to the computers' Docker proxy |

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
On the Mac it is `~/.vyre` in your own home folder. It has the same store, vault, search model and logs, and no `certs/` or `names/`, because the Mac serves nothing to other devices. It also holds `link.json` (0600), the key that pairs this Mac with its box, and `capsule/Vyre.app`, Lumen as built on this Mac.
:::

### AI accounts and Claude Code on the box

- **Your accounts.** Sessions run on your own accounts: Claude (through the Claude Agent SDK), Codex and Grok (through the Agent Client Protocol), and OpenRouter. A login account (Claude, Codex, Grok) is signed in once, by asking your assistant to start the provider's own sign-in (Claude's is also part of setup), and its login lives in that account's own private home on the box (`vyre_vyre-accounts`). A key (an Anthropic or OpenRouter API key) lives in the Vault. Either way the secret reaches the session's process at start and is never shown to a model.
- **Claude Code itself** is installed in the image, and its state, `~/.claude/` and `~/.claude.json`, lives in `vyre_vyre-home`, so a new image keeps it.
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

On the Mac, `vyre up` starts vyred in the background with the local set of modules. It opens no listener for other devices. It serves its API on `~/.vyre/vyred.sock` to the CLI, the Harness hooks in your terminal sessions, and Lumen. A Mac you chose as the server is different: it also keeps itself awake while it runs.

## How the Mac finds the box

`vyre up` on a Mac with no box configured asks for your server's pairing code. It shows three words, and you confirm they match on both screens and approve with your passkey. You can also give it the address:

```
vyre box add alex@192.0.2.10                     # put the box on a server you can SSH to
vyre up --box                                    # make this Mac the box
vyre up --connect https://alex.vyre.run            # a box you already set up
```

## How they talk

The Mac's vyred is a client of the box, at `network.box`. The box sees the Mac as `device:<id>`, like any of your devices, because it identifies callers from the entry on your identity list and never by a header ([ADR 0002](../adr/0002-network-and-identity.md)).

The `link` module turns the two machines into one system:

- **Pairing.** On the Mac, `vyre link pair <address>` (or `vyre up --connect <address>`, or a yes to `vyre up`'s question) asks the box and shows a code. Starting Vyre never asks a box on its own, and a home other than `~/.vyre` never talks to a real box unless `VYRE_ALLOW_REAL_BOX=1` is set. Approve the request in the Vyre app and confirm with your passkey (see [presence](presence.md)). You can approve from the Mac that is asking or from your phone. From the asking Mac the box asks for a fresh passkey proof and checks the typed code, so a model on the Mac cannot approve for you. The Mac keeps a link key in `~/.vyre/link.json` (mode 0600) and pins the box's key, so a different box at that address is refused.
- **Box tools from the Mac.** A module on the Mac calls `ctx.remote(tool, input)`; a surface calls `link.call`. Both reach `POST /v1/tools/<tool>` on the box.
- **Box events on the Mac.** The Mac proxies the box's event stream at `/v1/link/events`, so Lumen sees box threads as they happen.
- **The Mac's sessions on the box.** The box reads the paired Mac's sessions through the link. See the next section.

```
vyre link                 # on the Mac: paired or not, and whether the box answers
vyre link pair https://alex.vyre.run
vyre link unpair          # forget the box
```

## The box reads the Mac's sessions

Your Claude Code history stays on the Mac. The box reads it through the link when you ask, so the Vyre app lists the Mac's sessions beside the box's own (the app reads them and does not act on them; [ADR 0021](../adr/0021-box-reads-the-mac.md)).

- **No port on the Mac.** While paired, the Mac holds one request open to the box (`link.serve`). The box answers it with a question, or with nothing after 60 seconds; the Mac runs the question and sends the answer back (`link.reply`), then asks again. An idle Mac costs one request a minute.
- **A short list of reads.** Only `projects.catalog`, `projects.list`, `recall.search`, `recall.sessions`, `recall.thread`, `recall.transcript`, `threads.list` and `threads.asks` cross, and both ends check the list (`core/link/allow.js`). The Mac runs them as `module:link`.
- **Two writes, yours only.** `threads.send` types into a Mac session, and `threads.answer` answers one of its questions. Both cross only when you make the call from your own surface, never an agent, MCP, a guest or a module, and the Mac checks that again before it runs one. An answer also carries a one-use proof, signed by the box and tied to that question and those exact words, that the Mac checks. If a terminal or Lumen holds the session, your message waits until it is free and says so ("alex-mac is busy in your terminal").
- **Only for you.** On the box these tools take `machines: "all"` or `"local"`. They ask the Mac when you call them from the Vyre app, the CLI, Lumen or your own device, or when a module passes `machines: "all"`. Agents, MCP and guests get the box's rows alone. Each row the Mac sends is labelled `source: "mac"` and `machine` (the Mac's paired name); the box's rows say `source: "box"`.
- **Nothing is copied.** Nothing the Mac answers is written to the box's store. Only `recall.thread` and `recall.transcript` carry a conversation, and only when you open a session the box does not have.
- **Marked as the Mac's.** A Mac session carries the Mac's name. You can add a Mac session to a box project; the project's thread list reads it from the Mac.
- **An absent Mac is an answer.** A Mac that is not polling answers `mac_offline` at once and the box shows its own rows, with an "alex-mac offline" chip read from `link.macs`, and a message to it is not sent. A slow Mac delays a read by at most 5 seconds. A Mac that dropped off in the middle of a request looks online for up to a minute, and a read in that window ends in `timeout`.

The box cannot search the Mac's files: files are not on the list.

## When the box is away

The Mac keeps working without the box (floor rule 9, see [the security floor](floor.md)). Once a call to the box fails, the next ones fail fast with `box_unreachable` and are retried with a growing pause, up to 30 seconds. The link emits `link.lost` and, when the box answers again, `link.connected`. A module that asked the box for something gets the error at once and can fall back to what the Mac has.

## What it will not do

- The Mac does not serve the Vyre app. The app talks to the box.
- The box never trusts the Mac because of a header or a shared secret alone: every connection is identified from the identity list first.
- Link tools on the box (`link.*`) cannot be driven through `ctx.remote` or `link.call`.
- The box never runs a tool on the Mac outside the reads and the two writes above, and never as an agent or a module.

## Next

- [Your private network](network.md): addresses, identity and certificates.
- [Presence](presence.md): why approving a pairing needs you, not a model.
- [Box care](../using/box-care.md): updating, backing up and moving the box.
