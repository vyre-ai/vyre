# Installing Vyre on a box

How Vyre lays itself out on a Linux server, and why. The network and identity side is in
[ADR 0002](adr/0002-network-and-identity.md).

A box runs Vyre in Docker Compose: two containers, `tailscale` and `vyre`, and nothing else
unless you add it. The host needs Docker and nothing more. Tailscale, Node and Claude Code all
live in the containers.

## The one line

```
curl -fsSL https://vyre.run/install.sh | sh
```

That is `scripts/install-box.sh`. It is safe to run again; every run converges on the same
state. Flags: `--dry-run` prints every change and makes none, `--yes` answers yes to its
questions, `--from DIR` builds from a local checkout, `--uninstall [--purge]` reverses it.
`VYRE_DIR` moves the stack folder (default `/srv/vyre`), `VYRE_BOX_URL` the place the box files
come from (default `https://vyre.run/box/`).

What it does, in order:

1. Checks this is Linux. On a Mac it prints `npm install -g vyre && vyre up` and stops.
2. Checks Docker with Compose 2.24 or newer. If Docker is missing it asks before running
   `curl -fsSL https://get.docker.com | sh`; without a terminal to ask on, or with a no, it
   prints the command and stops. An old Compose gets the same message and a stop.
3. Checks `/dev/net/tun`, which the Tailscale container needs. On a VPS or an LXC container
   without it, enable TUN in the provider's panel.
4. Creates `/srv/vyre`, owned by you (the account that ran `sudo`, if you did), and writes the
   box files into it: `compose.yml`, `compose.build.yml` and `vyre.env.example`. It downloads
   `SHA256SUMS` first and checks every other file against its line there; a missing line or a
   different hash stops the install. With `--from DIR` the files are copied from the checkout
   instead.
5. Picks how to get the image. It pulls `ghcr.io/vyre-ai/vyre` when the registry has it (or
   `VYRE_IMAGE`). When it cannot, or with `VYRE_BUILD=tgz`, it downloads `vyre.tgz`, checks it the
   same way, unpacks it into `/srv/vyre/src` and builds from there. `--from DIR` builds from DIR.
6. Writes `/srv/vyre/.env` (mode 0600) with `COMPOSE_PROJECT_NAME=vyre` and `COMPOSE_FILE` (plus
   `compose.build.yml` and `VYRE_SOURCE` for a build), only if it is not there. It never
   overwrites it: that file is yours.
7. Installs the host wrapper to `/usr/local/bin/vyre`. If something else already has that name
   it asks first.
8. Runs `vyre up`. With `--print-link` (or `VYRE_LINK_ONLY=1`) it runs `vyre up --print-link`
   instead, which prints only `VYRE_LINK=<url>`, and `VYRE_SSH=<ssh -L line>` when there is one,
   for a program to read; everything else goes to stderr.

sudo is used only for Docker's own install, for `/srv/vyre` when `/srv` is root's, and for
`/usr/local/bin/vyre`. If your account is not in the `docker` group the installer runs the stack
through sudo and says so. Joining that group saves typing `sudo vyre`, and makes your account
root-equivalent on the box.

## What `vyre up` prints

The host's `vyre` is a small shell script. `vyre up` starts the stack if it is not running,
waits for vyred to answer, then runs `vyre up` inside the container. Before onboarding that
prints a one-time link and, when you are connected over SSH, the line to reach it:

```
  Open this link to set up Vyre (it works once, for an hour):

    http://127.0.0.1:7300/onboard?t=...

  This box is headless. On your own computer, run this first, then open the link there:
    ssh -N -L 7300:127.0.0.1:7300 alex@203.0.113.4
```

The onboarding page listens only on the box's loopback, so a headless box needs the tunnel. Run
the `ssh` line on your laptop, leave it open, and open the link there. Port 7300 is the same on
both ends on purpose: the page checks its `Host` header against the port it binds. Everything
after that happens in the browser (spec section 1): Claude's credential, Tailscale sign-in, the
name, the certificate.

After onboarding, `vyre up` prints the address instead: `your address: https://alex.vyre.run`.

Any other `vyre` command (`vyre status`, `vyre name`, `vyre backup`) runs the CLI inside the
container. `vyre logs` follows vyred's output.

## Who can reach it

- **The `tailscale` container is the only way in.** It runs the official image with kernel
  networking and publishes one port: 7300, on the host's `127.0.0.1`.
- **vyred has no network of its own.** The `vyre` container shares the `tailscale` container's
  network namespace, so vyred sees the real `tailscale0` interface. It binds the tailnet
  addresses on 443 itself and serves them with its own `vyre.run` certificate. There is no
  `tailscale serve` in the path.
- **Callers are identified by `tailscale whois` of the WireGuard source address**, never a
  header. A process on the host, or in another container, cannot produce a tailnet source
  address, so it cannot pose as the owner on a phone.
- **The onboarding listener binds only a container address that Docker publishes on the host's
  loopback**, never `0.0.0.0`, which would include `tailscale0`. It needs the one-time token
  besides.
- **vyred runs as uid 1000 (`vyre`), not root.** It is Tailscale's operator, so it can run
  `tailscale up` and `tailscale cert` from the onboarding page.

The reasoning is in [ADR 0002](adr/0002-network-and-identity.md).

## Folders and volumes

```
/srv/vyre/                    yours, not root's
  compose.yml                 the stack: tailscale, vyre, docker-api (profile computers)
  compose.build.yml           used when COMPOSE_FILE lists it: build the image from VYRE_SOURCE
  src/                        the unpacked vyre.tgz, when the image is built from it
  vyre.env.example            copy to vyre.env for CLOUDFLARE_VYRE_TOKEN and similar
  vyre.env                    optional, yours, read by the vyre container
  .env                        COMPOSE_PROJECT_NAME, COMPOSE_FILE, VYRE_SOURCE, TS_AUTHKEY
/usr/local/bin/vyre           the host wrapper
```

The data lives in Docker volumes, all labeled `run.vyre=1`:

| Volume | Mounted at | Holds |
|---|---|---|
| `vyre_vyre-home` | `/home/vyre` | `.vyre/` (config, store, vault, certs, names, modules, watchers, logs) and `.claude/`, `.claude.json` (Claude Code's own state and transcripts) |
| `vyre_vyre-work` | `/work` | projects |
| `vyre_tailscale-state` | `/var/lib/tailscale` | the node's identity; delete it and the box is a new node |
| `vyre_tailscale-sock` | `/var/run/tailscale` | tailscaled's socket, shared with the vyre container |

A container can be recreated at any time; nothing in it matters but the volumes.

`~/.vyre` inside the volume has the same layout as on any other install:

```
/home/vyre/.vyre/             0700
  config.json                 settings (0600); the onboarding writes name, network, onboard
  vyre.db, -wal, -shm         the store (SQLite, WAL)
  vault/                      sealed vault items
  certs/                      0600 files: acme-production.key, <name>.crt, <name>.key
  names/                      the name directory key, once the hosted directory exists
  modules/, watchers/         what the user installed and what Claude wrote
  models/                     embedding weights (about 23 MB), a cache: safe to delete
  embedder/                   the library that runs them (about 105 MB), fetched on first use: safe to delete
  logs/                       YYYY-MM-DD.log from vyred
  vyred.sock, vyred.pid
```

## Claude Code and its credentials

- Claude Code is installed in the image (`npm install -g @anthropic-ai/claude-code` at build).
  Its state, `~/.claude/` and `~/.claude.json`, lives in `vyre_vyre-home`, so a new image keeps it.
- **Sessions Vyre runs headless** (the assistant, agents) use the credential from onboarding
  step 2, which lives in the Vault: `claude-setup-token` (a subscription token from
  `claude setup-token`) or `anthropic-api-key`. The Switchboard hands it to each session in its
  environment at start. It is never written to a file, a log or an event.
- To use `claude` by hand on the box, run it in the container:
  `docker compose -f /srv/vyre/compose.yml exec vyre claude`, or `cd /srv/vyre && docker compose
  exec vyre claude`. Its transcripts land in the same `~/.claude/projects/`, which is how Vyre's
  history sees them.

## Upgrades

```
vyre update
```

That pulls new images (or, with `compose.build.yml` in `COMPOSE_FILE`, rebuilds from
`VYRE_SOURCE` with fresh base images), recreates what changed, waits for vyred and prints what
`vyre up` prints. When `VYRE_SOURCE` is `/srv/vyre/src`, it first downloads a new `vyre.tgz` from
`VYRE_BOX_URL`, checks it against `SHA256SUMS` and swaps it in, so a from-source box updates
without git. The volumes carry over. Data migrations run at start, per module (spec 7.1).
To update the box files themselves, run the installer again: it rewrites them and leaves `.env`
and `vyre.env` alone.

## Backup

```
vyre backup                   # vyre-backup-YYYY-MM-DD.tar.gz, mode 0600, in /home/vyre
```

The file lands in `/home/vyre`, inside the `vyre_vyre-home` volume. Copy it out with
`cd /srv/vyre && docker compose cp vyre:/home/vyre/<file> .`. Restore needs vyred stopped, and
vyred is the container's main process, so restore runs in a one-off container. `--force` lets it
replace the store the box already has; without it restore refuses:

```
cd /srv/vyre
docker compose cp <file> vyre:/home/vyre/
docker compose stop vyre
docker compose run --rm vyre vyre restore /home/vyre/<file> --force
vyre up
```

A backup holds `config.json`, a consistent copy of the store (`VACUUM INTO`, taken while vyred
runs), `vault/`, `watchers/`, `modules/`, `certs/` and `names/`. It leaves out `models/`,
`logs/`, the socket and the pid file. It contains the sealed vault. Keep it somewhere only you
can read, or encrypt it (`age -r <key> file`).

To back up everything, Claude's state and `/work` included, copy the volumes with the stack
stopped:

```
cd /srv/vyre && docker compose stop
for v in vyre-home vyre-work tailscale-state; do
  docker run --rm -v vyre_$v:/v:ro -v "$PWD":/out alpine tar czf /out/vyre_$v.tgz -C /v .
done
docker compose start
```

Restore is the same with `tar xzf` into a fresh volume of the same name.

## Uninstall

```
vyre name release             # frees <you>.vyre.run
curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall
```

That runs `docker compose down` in `/srv/vyre` and removes `/usr/local/bin/vyre`. The volumes
and `/srv/vyre` stay, so a reinstall picks up where it left off. `--purge` also deletes every
volume labeled `run.vyre=1` in project `vyre`, after listing them and asking: that is the vault,
Claude's sign-in and `/work`. The installer never uninstalls Docker, and leaves the images
(`docker image rm` them if you like).

## The agents' computers

Agents get their own containers (spec 7.9) through `docker-api`, Vyre's own Docker proxy
(`core/dockerproxy`, run from the same image). It is off until the `computers` profile is on; add
to `.env`:

```
COMPOSE_PROFILES=computers
```

then `vyre up`. The host's Docker socket is mounted into the proxy and nowhere else, and vyred
reaches it at `http://docker-api:2375` on an internal network. The proxy allows only what agents'
computers use (create, start, stop, pause, unpause, inspect, list, remove, exec, volume inspect)
and refuses every other endpoint. It checks request bodies too: a create must match
`core/computers/driver/policy.js` and the box's `VYRE_COMPUTERS_*` settings, and every
per-container op is checked against the labels the Engine itself reports. It runs as uid 1000 in
the socket's group, `DOCKER_GID` in `.env`, which the installer fills in from the socket.

## Without Docker

A Mac, or a Linux box without Docker, installs from npm:

```
npm install -g vyre
vyre up                       # on a Mac: role local, or --box to make the Mac the box
sudo vyre up --system --user alex   # Linux without Docker: systemd units
```

This needs Node 22.5 or newer, Tailscale on the host and Claude Code
(`npm install -g @anthropic-ai/claude-code`). vyred runs as the owner's own login account, never
root, with `~/.vyre` in that account's home, and Vyre's history reads the same `~/.claude/` as
the person's own `claude`.

On Linux, `vyre up --system` writes two units in `/etc/systemd/system/`. `vyre.socket` owns port
443 on `tailscale0` only (`ListenStream=443`, `BindToDevice=tailscale0`) and hands it to vyred as
fd 3, so vyred needs no capability for 443 and no child process can take the port first.
`vyre.service` runs vyred as the owner with `Restart=always` and `NoNewPrivileges=yes`, reading
optional environment from `~/.vyre/env`. `vyre up --system` also runs
`tailscale set --operator=<account>`. Upgrade with `sudo npm install -g vyre@latest && vyre up`;
remove with `sudo vyre uninstall --system && sudo npm rm -g vyre`.
