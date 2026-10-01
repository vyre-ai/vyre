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
is not running, waits up to a minute for Vyre, then prints the setup link or your address;
`vyre update` upgrades (below); `vyre logs` follows Vyre's output.

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
vyre logs      # follow Vyre's output (docker compose logs -f vyre)
```

Vyre also writes a log file per day, `~/.vyre/logs/YYYY-MM-DD.log`. On a Docker box that is
`/home/vyre/.vyre/logs/` inside the `vyre_vyre-home` volume.

## Cap what it spends

Vyre keeps one ledger of what sessions, agents and memory spend, per provider and per day (UTC).
Some figures are estimates, which the list marks, because they are tokens times a price rather
than a cost the provider reported. A daily cap per provider stops the spending without asking you
on every call.

```
vyre spend                      # today's spend per provider against its cap
vyre spend raise claude 20      # cap Claude at $20 a day
vyre spend raise claude +5      # add $5 to the cap
vyre spend raise all 50         # one cap over every provider together
vyre spend raise claude off     # no cap
```

At the cap, the thread that was spending is paused with one line that says what happened and the
command to raise the cap, and memory answers from facts and search until the next UTC day or until
you raise it. A provider with no cap has none. The Deck shows the same list under Settings, Spend,
with a way to change each cap.

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

`vyre update` brings the box to the newest release. It asks GitHub Releases for `vyre-ai/vyre`:
`stable` (the default) is the newest release that is not a prerelease, and `beta` is the newest of
either. A stable box never takes a prerelease, such as `0.2.0-rc.1`: only a box you set to `beta`
would. Pick one with `vyre update --channel beta` or `VYRE_CHANNEL=beta`, or a release by version
with `--to 0.2.0`. While GitHub has no release yet, or when you set `VYRE_BOX_URL` yourself, it
uses the site instead (`https://vyre.run/box/` by default), as it always has.

Vyre looks for a newer release once a day and keeps the answer, so Settings can say "Update available" and show what changed. On a server set up by the install line, Settings also has an **Update to 0.x** button. It does not run anything itself: it drops a one-line request into `/var/lib/vyre-update/request`, a folder that only Vyre can write to and that root owns along with every folder above it, and a small systemd unit on the host (`vyre-update.path`, owned by root) runs `vyre update` for it. That update never accepts `--allow-unsigned`, never goes back to an older version than the newest this server has had (a version the host keeps in a file only root writes), waits at least ten minutes between updates, backs up your data first, and puts the old version back on its own if the new one does not start. The card shows each step and the result. The command above always works too, and a server with no systemd shows only the command.

Turn on **Update automatically** in Settings (off by default) and Vyre asks for a new release by itself between 2 and 5 in the morning, once per version, the same way. The channel is the host's own: set `VYRE_CHANNEL=beta` in the server's `.env`, or leave it on stable. Set `auto` to `"off"` inside the `update` object in `config.json` to stop the daily look. On a Mac there is no update button: run `vyre update` (see Update Vyre on a Mac, below).

Updates are signed. Every file comes from the release and is checked against its `SHA256SUMS`
before anything on the box changes. The `SHA256SUMS` list itself is checked against its Ed25519
signature (`SHA256SUMS.sig`) from Vyre's release key, which is built into the `vyre` command. An
unsigned or badly signed release is refused, and `vyre update --allow-unsigned` installs it anyway
after a plain warning that nothing proves it came from Vyre. The same holds for `vyre update` on
a Mac. A box that pulls its image instead of building it also checks every Vyre image of the
release with cosign against the release workflow's identity, and refuses to pull one it cannot
check. Then, in order:

1. It backs up the database with `vyre backup`, into `/home/vyre/.vyre/backups/pre-<version>.tar.gz`
   in the container, with a copy in `/srv/vyre/backups/` that only you can read. It holds the
   sealed vault, so treat it like the vault.
2. It tags the image that runs now as `vyre:prev`, and keeps the box files as they are in
   `/srv/vyre/box.prev/`.
3. It refreshes the box files (`compose.yml`, `compose.build.yml`, `vyre.env.example`, `Dockerfile`,
   `dockerignore`) from the release. `.env` and `vyre.env` are never touched.
4. When `/srv/vyre/.env` lists `compose.build.yml` in `COMPOSE_FILE` and `VYRE_SOURCE` is
   `/srv/vyre/src`, it swaps in the new `vyre.tgz` and keeps the old one as `/srv/vyre/src.prev`,
   then rebuilds the image with fresh base images. Otherwise it pulls the new image.
5. It recreates what changed and waits up to a minute for Vyre.

If Vyre does not come up in that minute, the update undoes itself: the old source, the old image,
the old box files and the database from step 1 all go back, and `vyre update` exits 1 saying it
rolled back. Store migrations only go forward, which is why the database comes back from the
backup. Once an update has come up healthy, nothing restores the database on its own, so nothing
you write after that is lost.

After a healthy update, when the release carries an Android build, it brings the phone app along:
it checks the APK and `android.json` against `SHA256SUMS`, copies the APK into `/home/vyre/.vyre/releases/android/`,
then `android.json` last (the old one stays as `android.json.prev`), and runs
`vyre call releases.sign`. If signing refuses (`no_release` or `release_mismatch`), the update
says so and still succeeds. A release without an Android build leaves the folder alone. Last, it
replaces the `vyre` command itself with the release's copy, and prints what `vyre up` prints.

Your volumes carry over, and each module migrates its own data at start
([Specification](../architecture/spec.md#71-store-config-events-modules-daemon), Section 7.1).

To go back by hand:

```
vyre update --rollback
```

It puts the previous source, image, box files and phone app manifest back, and keeps the database
as it is now. Run it again to go forward. To put the database from before the update back too:

```
vyre update --rollback --restore-data
```

That drops everything written since the update, so it says what it would drop and asks you to
type `restore`. Off a terminal, pass `--yes` instead.

The image carries the Claude Agent SDK that Vyre's own sessions run on, with the Claude Code it
bundles, in `/opt/vyre-sessions-sdk` ([ADR 0030](../adr/0030-sessions.md)). The box never
downloads it at runtime. Its version is pinned as `VERSION` in `core/sessions/sdk-pin.js`: a bump there
rebuilds the image, and `vyre update` brings it in like any other change.

`vyre update` refreshes the box files and the wrapper. Running the installer again does too, and
it also leaves `.env` and `vyre.env` alone:

```
curl -fsSL https://vyre.run/install.sh | sh
```

## Update Vyre on a Mac

On a Mac, or any machine where you installed Vyre with npm, `vyre update` updates Vyre itself:

```
vyre update --check    # is a newer release out? exit 0 when current, 1 when one waits
vyre update            # show what changed, then install it
```

```output
  0.1.0 → 0.2.0 · stable

  0.2.0
    what 0.2.0 changed

  Update to 0.2.0 now? (y/N) y
  updated 0.1.0 → 0.2.0 · vyred answering
```

It reads the releases of `vyre-ai/vyre` on GitHub and shows the notes of every release between
the version you run and the new one. When you say yes it:

1. backs up your data into `~/.vyre/backups/pre-<version>/`;
2. downloads the release into `~/.vyre/releases/<version>/` and checks every file against the
   release's `SHA256SUMS`, so a damaged or wrong download stops it before anything changes;
3. installs it with `npm install -g`, restarts Vyre the way `vyre up` does after an upgrade, and
   waits for Vyre to report the new version.

If Vyre does not come back on the new version, `vyre update` puts the previous version back,
restores the backup, and says it rolled back. Once the new version has answered, it never touches
your data again on its own.

| Option | Does |
|---|---|
| `--channel stable` or `--channel beta` | which releases to follow; the default is `stable`, or `channel` inside the `update` object in `config.json` |
| `--to <version>` | a given release, when an update says to step through one first |
| `--yes` | installs without asking; needed when there is no terminal to ask on |
| `--rollback` | puts the previous release back and keeps your current data |
| `--rollback --restore-data` | also puts back the data from before the last update |
| `--json` | one line of JSON; `--check --json` prints `{ current, latest, channel }` |

`--restore-data` drops everything written since that backup, so it says the backup's date and
asks you to type `restore`. With `--json`, or with no terminal, it needs `--yes` instead.
`~/.vyre/releases` keeps the two newest releases and the one you run.

> [!SNAG] "this vyre runs from a checkout; update it with git"
> You run Vyre from a clone of the repository, not an npm install. Run `git pull`, then
> `vyre up`.

> [!SNAG] "0.3.0 updates only from 0.2.0 or newer"
> A release sometimes needs an older one in between. Run the command it names, for example
> `vyre update --to 0.2.0`, then `vyre update` again.

On a box, the host's `vyre update` (above) does the job; inside the box's container,
`vyre update` says so and stops.

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

**Vyre's own data**, taken while Vyre runs, on the box:

```
vyre backup                  # vyre-backup-YYYY-MM-DD.tar.gz in /home/vyre, mode 0600
```

It holds `config.json`, a consistent copy of the store (taken with SQLite's `VACUUM INTO` while
Vyre writes), `vault/`, `watchers/`, `modules/`, `certs/` and `names/`. It leaves out
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

A `vyre backup` file goes back with Vyre stopped. Vyre is the container's main process, so
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

The backup carries the artifacts your agents made (`data/artifacts`: every version, a dashboard's
data, a deck's images, and the archive and 30-day undo state). A restore swaps them in by moving the
box's current artifacts folder aside first and deleting it only once the new one is in place, so a
failed restore keeps what was there. If the power fails between those two steps, a folder named
`.artifacts.old-<number>` is left under `data/`; it is safe to delete once you have checked that
your artifacts are there. Public links come back as they were when the backup was made: a link that
was on then is on again.

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

If you claimed a `vyre.run` name, run `vyre name release` on the box first to give it up. A name that was pointed at a server stays reserved afterwards, so nobody, you included, can claim it again.

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

## What root runs, and what it reads

Updates that run as root (the automatic path from Settings and `sudo vyre update`) never read a file you or an agent on your account can write as configuration. Root starts compose from its own copies of the released compose.yml, in a folder only root can write, with a root-written env file and every file, project and folder named explicitly. It refuses an override file or a COMPOSE_* setting, takes how the box is built (pulled, built from the released source, or from your own checkout) from a record it made when the updater was installed, and checks every ghcr.io/vyre-ai image of a release with cosign before pulling. `sudo vyre up` and the other root commands use the same copies once the updater is installed. A host with no updater (no systemd) keeps the stack folder's files, as the installer laid them down.

One thing no script can fix: if your account may run `sudo` without a password, anything running as you can already become root, and none of this protects you from it. Keep `sudo` asking for a password on a box where agents run as your account.

Being in the docker group is equivalent to root on that host, so only the owner should be in it. The installer's own first `vyre up` runs as you, straight after it lays down the files it just verified; root's copies exist from the next step, when the updater is installed.
