---
title: Box care
summary: Keep your box healthy by checking it, upgrading it, backing it up and restoring it, reading its logs, moving it to another server, and removing it.
audience: users, operators
owner: integrator
status: draft
---

# Box care

Your box is the always-on server that runs Vyre. On a Linux server it is a Docker Compose stack in
`/srv/vyre` with two containers, `tailscale` and `vyre`, and its data in Docker volumes. You look
after it from your Mac with `vyre box ...`, which runs each step over SSH so you never open a shell
on the server, or on the server itself with the host's `vyre` command. This page covers the care
tasks. What each folder and volume holds, and who can reach the box, is in
[The box and the Mac](../concepts/box-and-mac.md#folders-and-volumes).

## Check on it

::: tabs
::: tab On this Mac
```
vyre box       # the box's address and SSH target, and whether it answers from here
```

```output
  your box  https://vyre.tail1234.ts.net · alex@192.0.2.10
  answering · 0.0.1
```
::: tab On a server
```
vyre status    # running or not, version, role, how many modules started
vyre modules   # each module, and the error of any that failed
```

```output
  vyred running · 0.0.1 · box · pid 7 · up 5312s
  17 modules running
```
:::

On the server, the host's `vyre` is a small shell script, `/usr/local/bin/vyre`. It runs every
command in the `vyre` container, except three it handles itself: `vyre up` starts the stack if it
is not running, waits up to a minute for vyred, then prints the setup link or your address;
`vyre update` upgrades (below); `vyre logs` follows vyred's output.

> [!SNAG] `vyre box` says "no box yet: vyre box add <user@host>"
> The `vyre box` commands work only for a box this Mac knows the SSH target of. If you installed
> the box with the curl installer on the server, run `vyre box add alex@192.0.2.10` once: it finds
> Vyre already there and carries on from where it stands.

> [!SNAG] `vyre box` says "not answering from here"
> This Mac is not on your tailnet, or the box is down. Open Tailscale on the Mac, then check the
> box with `vyre status` on the server. See [Tailscale](tailscale.md).

## Read its logs

On the box:

```
vyre logs      # follow vyred's output (docker compose logs -f vyre)
```

vyred also writes a log file per day, `~/.vyre/logs/YYYY-MM-DD.log`. On a Docker box that is
`/home/vyre/.vyre/logs/` inside the `vyre_vyre-home` volume. On a Mac, the Capsule logs to
`~/.vyre/logs/capsule.out`.

## Upgrade

::: tabs
::: tab On this Mac
1. Run:

   ```
   vyre box update
   ```

   It runs `vyre update` on the server over SSH, then compares versions.

2. If the box is now newer than your Mac, it says so and prints the command that upgrades the
   Mac:

   ```output
     the box runs 0.0.2, newer than this Mac's 0.0.1: npm install -g https://vyre.run/box/vyre.tgz && vyre up
   ```
::: tab On a server
```
vyre update
```
:::

`vyre update` pulls new images. When `/srv/vyre/.env` lists `compose.build.yml` in `COMPOSE_FILE`,
it rebuilds the image from `VYRE_SOURCE` with fresh base images instead; and when `VYRE_SOURCE` is
`/srv/vyre/src`, it first downloads a new `vyre.tgz` from `VYRE_BOX_URL`, checks it against
`SHA256SUMS` and swaps it in, so a box built from source updates without git. Then it recreates
what changed, waits up to a minute for vyred, and prints what `vyre up` prints. Your volumes carry
over, and each module migrates its own data at start
([Specification](../architecture/spec.md#71-store-config-events-modules-daemon), Section 7.1).

To update the box files themselves (`compose.yml`, the wrapper and the rest), run the installer
again. It rewrites them and leaves `.env` and `vyre.env` alone:

```
curl -fsSL https://vyre.run/install.sh | sh
```

## Run the installer by hand

`vyre box add` from the Mac runs the installer for you. On the server you can run it yourself:

```
curl -fsSL https://vyre.run/install.sh | sh
```

It is `scripts/install-box.sh`. It is safe to run again: every run converges on the same state.
Pass options after `sh -s --`, for example `curl -fsSL https://vyre.run/install.sh | sh -s -- --dry-run`.

| Option | Does |
|---|---|
| `--dry-run` | prints every change and makes none (read-only checks still run) |
| `--yes`, `-y` | answers yes to every question |
| `--from DIR` | uses the box files in a local checkout and builds the image from it |
| `--print-link` | ends with only two lines on stdout for a program to read, VYRE_LINK with the setup link and, when there is one, VYRE_SSH with the `ssh -L` line; everything else goes to stderr |
| `--uninstall` | stops the stack and removes `/usr/local/bin/vyre`; the volumes stay |
| `--purge` | with `--uninstall`: also deletes the volumes, after listing them and asking |

| Variable | Default | Does |
|---|---|---|
| `VYRE_DIR` | `/srv/vyre` | where the stack goes |
| `VYRE_BOX_URL` | `https://vyre.run/box/` | where the box files come from |
| `VYRE_IMAGE` | `ghcr.io/vyre-ai/vyre:latest` | the image to pull |
| `VYRE_BUILD=tgz` | | builds from `vyre.tgz` even when the image can be pulled |
| `VYRE_LINK_ONLY=1` | | the same as `--print-link` |
| `VYRE_NO_UP=1` | | installs everything but does not start it |

What it does, in order:

1. Checks this is Linux. On a Mac it prints a hint and stops.
2. Checks for Docker with Compose 2.24 or newer. If Docker is missing it asks before running
   `curl -fsSL https://get.docker.com | sh`; with no terminal to ask on, or a no, it prints the
   command and stops. An old Compose gets the same kind of message and a stop.
3. Checks `/dev/net/tun`, which the Tailscale container needs.
4. Picks how to get the image: it pulls `VYRE_IMAGE` when the registry has it, and otherwise
   builds from `vyre.tgz`.
5. Downloads `SHA256SUMS`, then `compose.yml`, `compose.build.yml`, `vyre.env.example`, the host
   wrapper and, for a build, `vyre.tgz`, and checks each against its line. A missing line or a
   different hash stops the install before anything is written. With `--from DIR` the files come
   from the checkout instead.
6. Creates `/srv/vyre`, owned by you (the account that ran `sudo`, if you did), writes the box
   files into it, and unpacks `vyre.tgz` into `/srv/vyre/src` for a build.
7. Writes `/srv/vyre/.env` (mode 0600) with `COMPOSE_PROJECT_NAME=vyre`, `COMPOSE_FILE`
   (plus `VYRE_SOURCE` for a build) and `DOCKER_GID`, the group that owns the Docker socket. It
   writes the file only if it is not there. The one change it makes to an existing `.env` is to
   add `DOCKER_GID` when the line is missing.
8. Installs the host wrapper to `/usr/local/bin/vyre`. If something else already has that name,
   it asks first.
9. Runs `vyre up`, or `vyre up --print-link` with `--print-link`.

sudo is used only for Docker's own install, for `/srv/vyre` when `/srv` is root's, and for
`/usr/local/bin/vyre`. If your account cannot reach Docker, the installer runs the stack through
sudo and says so; from then on the host's commands need `sudo vyre`.

> [!WHY] Why not just add me to the docker group?
> Membership of the `docker` group saves typing `sudo vyre`, and makes your account
> root-equivalent on that server: anyone who can talk to Docker can start a container that mounts
> `/`. The installer leaves that choice to you. `vyre box add` offers it in its plan, because
> later steps over SSH cannot type a sudo password.

> [!SNAG] "Docker is installed but not running."
> Start it with `sudo systemctl start docker`, then run the installer again.

> [!SNAG] "checksum mismatch for ..." or "SHA256SUMS is not a checksum list"
> Nothing was installed. The download was damaged, or `VYRE_BOX_URL` points somewhere that is
> not a Vyre release. Unset `VYRE_BOX_URL` and try again.

## Back up

There are two kinds of backup.

**Vyre's own data**, taken while vyred runs, on the box:

```
vyre backup                  # vyre-backup-YYYY-MM-DD.tar.gz in /home/vyre, mode 0600
```

It holds `config.json`, a consistent copy of the store (taken with SQLite's `VACUUM INTO` while
vyred writes), `vault/`, `watchers/`, `modules/`, `certs/` and `names/`. It leaves out
`models/`, `logs/`, the socket and the pid file. The file lands in `/home/vyre`, inside the
`vyre_vyre-home` volume. Copy it off the box:

```
cd /srv/vyre && docker compose cp vyre:/home/vyre/vyre-backup-2026-09-27.tar.gz .
```

**Everything**, Claude Code's sign-in and transcripts, your projects in `/work` and the box's
Tailscale identity included, from the Mac:

```
vyre box backup                         # vyre-box-backup-YYYY-MM-DD.tar.gz here
vyre box backup ~/Backups/box.tar.gz
```

This stops the stack, copies the `vyre-home`, `vyre-work` and `tailscale-state` volumes into one
file on your Mac (mode 0600), and starts the stack again, even if the copy fails or you press
Control-C. `--force` replaces an existing file.

Both files contain your sealed vault. Keep them somewhere only you can read, or encrypt them
(`age -r <key> file`).

## Restore

A `vyre backup` file goes back with vyred stopped. vyred is the container's main process, so
restore runs in a one-off container:

```
cd /srv/vyre
docker compose cp vyre-backup-2026-09-27.tar.gz vyre:/home/vyre/
docker compose stop vyre
docker compose run --rm vyre vyre restore /home/vyre/vyre-backup-2026-09-27.tar.gz --force
vyre up
```

Without `--force`, restore refuses to replace a store the box already has. It also refuses an
archive with paths outside the known folders, or with links in it.

A `vyre box backup` file holds the three volumes as folders (`vyre-home/`, `vyre-work/`,
`tailscale-state/`). To put it on a server that has no Vyre volumes yet, install without starting,
create the volumes the way Compose would, unpack into them, then start:

```
curl -fsSL https://vyre.run/install.sh | VYRE_NO_UP=1 sh
for v in vyre-home vyre-work tailscale-state; do
  docker volume create --label run.vyre=1 --label com.docker.compose.project=vyre \
    --label com.docker.compose.volume=$v vyre_$v
done
docker run --rm -i -v vyre_vyre-home:/b/vyre-home -v vyre_vyre-work:/b/vyre-work \
  -v vyre_tailscale-state:/b/tailscale-state alpine tar xzf - -C /b < vyre-box-backup-2026-09-27.tar.gz
vyre up
```

Because `tailscale-state` comes back too, the box returns with the same Tailscale name and
address. Start the old server's stack again only after you have taken Vyre off it: two nodes with
one identity fight over it. To go from one live server to another, `vyre box move` (next) does all
of this for you.

## Move to another server

From the Mac:

```
vyre box move alex@192.0.2.20
```

It installs Vyre on the new server, stops the old stack, streams the three volumes from old to
new through your Mac, starts the new one, and waits for it to answer at the same address. Because
`tailscale-state` moves too, the box keeps its Tailscale name, address and certificate. Once the
new box answers, Vyre is taken off the old server, whose volumes stay until you delete them.

The new server must not already hold a box or Vyre volumes. If anything fails after the old stack
stops, the move stops the new one and starts the old one again, and says which.

## Turn on agents' computers

Agents' computers run as their own containers through Vyre's Docker proxy, which is off by
default. On the box, add to `/srv/vyre/.env`:

```
COMPOSE_PROFILES=computers
```

then run `vyre up`. What the proxy allows is in
[The box and the Mac](../concepts/box-and-mac.md#the-agents-computers). See [Glass](glass.md) for
using the computers.

## Remove it

If you claimed a `vyre.run` name, run `vyre name release` on the box first to free it.

::: tabs
::: tab On this Mac
```
vyre box remove           # stop the stack, remove /usr/local/bin/vyre, keep the volumes
vyre box remove --purge   # also delete the volumes, after the server asks
```

It lists what it will do and asks first. Afterwards this Mac forgets the box.
::: tab On a server
```
curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall
curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall --purge
```
:::

Both run `docker compose down` in `/srv/vyre` and remove `/usr/local/bin/vyre`. Without `--purge`,
the volumes and `/srv/vyre` stay, so a reinstall picks up where it left off. `--purge` lists every
volume labelled `run.vyre=1` in project `vyre` and, after you say yes, deletes them: the vault,
Claude's sign-in, the store and `/work`. `/srv/vyre` stays either way, with its `.env`; remove it
with `sudo rm -rf /srv/vyre`. The installer never removes Docker, and leaves the images
(`docker image rm` them if you like).

On the Mac, `vyre down && npm rm -g vyre` removes Vyre and leaves `~/.vyre`.

## A box without Docker

A Linux box installed from npm with systemd units is upgraded with
`sudo npm install -g https://vyre.run/box/vyre.tgz && vyre up`, and removed with
`sudo vyre uninstall --system && sudo npm rm -g vyre` (`--purge` also deletes the data). See
[Without Docker](../get-started/without-docker.md).

## Next

- [The box and the Mac](../concepts/box-and-mac.md): what runs where, the folders and volumes, and
  who can reach the box.
- [Troubleshooting](../get-started/troubleshooting.md), when something does not start.
- [CLI reference](../reference/cli.md#vyre-box), every `vyre box` form.
