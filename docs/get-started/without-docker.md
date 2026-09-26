---
title: Without Docker
summary: Run Vyre from npm on a Mac, or on a Linux server under systemd, with no containers.
audience: users, operators
owner: integrator
status: stable
---

# Without Docker

A Mac, or a Linux server without Docker, runs Vyre straight from the npm package. There is one
process, vyred, running as your own login account (never root), with its data in `~/.vyre` in
that account's home. Vyre's history reads the same `~/.claude/` as your own `claude`. The
Docker install on a server is in [Install on a server](install.md); this page is everything
else.

## What you need

- Node 22.5 or newer (`node --version`).
- Claude Code: `npm install -g @anthropic-ai/claude-code`.
- Tailscale on the machine itself, from <https://tailscale.com/download>. On Linux it must use
  its network interface (`tailscale0`); in userspace networking mode the onboarding stops at the
  Tailscale step and says so.
- On Linux: systemd.

## Install the package

```
npm install -g vyre
```

Vyre is not on npm yet. Until it is, install the same tarball the Docker box builds from:

```
npm install -g https://vyre.run/box/vyre.tgz
```

## On a Mac

```
vyre up                  # role local: this Mac talks to your box
vyre up --box            # or: this Mac is the box
vyre up --connect https://vyre.tail1234.ts.net   # a box you already set up
```

A Mac's role is `local` by default. `vyre up` starts vyred for this Mac, finds your box on the
tailnet (or asks where Vyre should run), pairs the Mac with it and opens the Capsule. The full
walk-through is [Onboarding](onboarding.md).

`vyre up --box` sets the role to `box` and prints the onboarding link. On a Mac it also opens
the link in your browser. The Mac then serves your phone, so it has to stay awake for the
phone to reach it.

There is no login item. Any `vyre` command starts vyred when it is not running; `vyre up` also
restarts it when the installed version or the role has changed. The rest:

```
vyre status              # is it running, and what is it running
vyre down                # stop it
vyre modules             # every module and whether it started
```

vyred's own output goes to `~/.vyre/logs/vyred.out`, and its log to `~/.vyre/logs/`, one file
per day.

## On Linux, under systemd

```
npm install -g https://vyre.run/box/vyre.tgz
sudo vyre up --system --user alex
vyre up
```

`--user` names the account vyred runs as; it can never be root. Under sudo it defaults to the
account that ran sudo. Add `--dry-run` to see every change without making one.

`vyre up --system` does this, and running it again changes only what differs:

1. Creates `~/.vyre` for that account, mode 0700.
2. Writes two units in `/etc/systemd/system/`:
   - `vyre.socket` owns port 443 on `tailscale0` only (`ListenStream=443`,
     `BindToDevice=tailscale0`) and hands it to vyred as fd 3. vyred needs no capability for
     443, and no child process can take the port first.
   - `vyre.service` runs vyred as the account with `Restart=always` and `NoNewPrivileges=yes`,
     `VYRE_HOME` set to `~/.vyre`, and optional environment from `~/.vyre/env`.
3. Runs `tailscale set --operator=alex`, so vyred can run `tailscale up` and `tailscale cert`
   from the onboarding page without root.
4. Enables `vyre.socket`. If `tailscale0` does not exist yet it says so and skips this; run
   `sudo vyre up --system --user alex` again once Tailscale is up. Until then vyred serves only
   its local socket.
5. Enables and restarts `vyre.service`.

Then plain `vyre up`, as that account, prints the onboarding link and, over SSH, the `ssh -L`
line to reach it from your own computer. The steps from there are in
[Onboarding](onboarding.md).

Without systemd, `vyre up --system` stops and says so. Run `vyre daemon` (vyred in the
foreground) as the account under your own supervisor, with `VYRE_HOME` set, and restart it
when it exits.

### Upgrade

```
sudo npm install -g vyre@latest && vyre up
```

`vyre up` sees vyred running an older version, stops it, and systemd starts the new one. If an
upgrade changed the units, `vyre up` prints the line to rewrite them:
`sudo vyre up --system --user alex`.

### Remove

```
vyre name release        # only if you claimed a vyre.run name
sudo vyre uninstall --system
sudo npm rm -g vyre
```

`vyre uninstall --system` disables and removes both units. `~/.vyre` (the vault, memory and
config) stays unless you add `--purge`, which deletes it and cannot be undone. `--dry-run`
works here too.

## Back up and restore

The same two commands as on a Docker box, run as the account itself:

```
vyre backup                        # vyre-backup-YYYY-MM-DD.tar.gz, in this folder
vyre down                          # restore needs vyred stopped
vyre restore vyre-backup-2026-09-27.tar.gz --force
vyre up
```

Under systemd, stop it with `sudo systemctl stop vyre` instead of `vyre down`. What a backup
holds is in [Install on a server](install.md#backup).

## Where to go next

- [Onboarding](onboarding.md): the browser steps, your Mac and your phone.
- [CLI reference](../reference/cli.md): every `vyre` command.
- [Configuration reference](../reference/config.md): `role`, `network.port` and the rest.
