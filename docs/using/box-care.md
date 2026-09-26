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
tasks. How the box was installed, and what each folder and volume holds, is in
[Install](../get-started/install.md).

## Check on it

From the Mac:

```
vyre box       # the box's address and SSH target, and whether it answers from here
```

On the box, or on any machine running vyred:

```
vyre status    # running or not, version, role, how many modules started
vyre modules   # each module, and the error of any that failed
```

## Read its logs

On the box:

```
vyre logs      # follow vyred's output (docker compose logs -f vyre)
```

vyred also writes a log file per day, `~/.vyre/logs/YYYY-MM-DD.log`. On a Docker box that is
`/home/vyre/.vyre/logs/` inside the `vyre_vyre-home` volume. On a Mac, the Capsule logs to
`~/.vyre/logs/capsule.out`.

## Upgrade

From the Mac:

```
vyre box update
```

That runs `vyre update` on the server, then compares versions. If the box is newer than your Mac,
it tells you to upgrade the Mac too:

> [!GAP]
> ADR 0008 says `vyre box update` also upgrades the Mac. It does not: run the command it prints. See [known gaps](../known-gaps.md#vyre-box-update-does-not-upgrade-the-mac).

```
npm install -g vyre@latest && vyre up
```

On the server, `vyre update` does the same by hand. It pulls new images, or, when the image is
built from source, rebuilds it (a box installed from `vyre.tgz` downloads the new one and checks
it against `SHA256SUMS` first). Then it recreates what changed and waits for vyred. Your volumes
carry over, and each module migrates its own data at start.

To update the box files themselves (`compose.yml` and the rest), run the installer again. It
rewrites them and leaves `.env` and `vyre.env` alone:

```
curl -fsSL https://vyre.run/install.sh | sh
```

## Back up

There are two kinds of backup.

**Vyre's own data**, taken while vyred runs, on the box:

```
vyre backup                  # vyre-backup-YYYY-MM-DD.tar.gz in /home/vyre, mode 0600
```

It holds `config.json`, a consistent copy of the store, the sealed vault, watchers, modules,
certificates and names. It leaves out the embedding model cache, logs, the socket and the pid
file. Copy it off the box:

```
cd /srv/vyre && docker compose cp vyre:/home/vyre/vyre-backup-2026-09-27.tar.gz .
```

**Everything**, from the Mac:

```
vyre box backup                         # vyre-box-backup-YYYY-MM-DD.tar.gz here
vyre box backup ~/Backups/box.tar.gz
```

This stops the stack, copies the `vyre-home`, `vyre-work` and `tailscale-state` volumes into one
file on your Mac (mode 0600), and starts the stack again, even if the copy fails or you press
Control-C. It includes Claude Code's sign-in and transcripts, your projects in `/work`, and the
box's Tailscale identity. `--force` replaces an existing file.

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

Without `--force`, restore refuses to replace a store the box already has.

To restore whole volumes, unpack each into a fresh volume of the same name with the stack
stopped. The steps are in [Install](../get-started/install.md).

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

then run `vyre up`. See [Glass](glass.md) for using them.

## Remove it

From the Mac:

```
vyre box remove           # stop the stack, remove /usr/local/bin/vyre, keep the volumes
vyre box remove --purge   # also delete the volumes, after the server asks
```

On the server:

```
curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall [--purge]
```

Without `--purge`, the volumes and `/srv/vyre` stay, so a reinstall picks up where it left off.
`--purge` deletes every Vyre volume: the vault, Claude's sign-in and `/work`. The installer never
removes Docker, and leaves the images.

If you claimed a `vyre.run` name, run `vyre name release` first to free it.

On the Mac, `vyre down && npm rm -g vyre` removes Vyre and leaves `~/.vyre`.

## A box without Docker

A Linux box installed from npm with systemd units is upgraded with
`sudo npm install -g vyre@latest && vyre up`, and removed with
`sudo vyre uninstall --system && sudo npm rm -g vyre` (`--purge` also deletes the data). See
[Without Docker](../get-started/without-docker.md).

## Next

- [Install](../get-started/install.md), the layout of `/srv/vyre` and the volumes.
- [Troubleshooting](../get-started/troubleshooting.md), when something does not start.
- [CLI reference](../reference/cli.md#vyre-box), every `vyre box` form.
