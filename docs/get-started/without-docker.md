---
title: Without Docker
summary: Run Vyre from npm on a Mac, or on a Linux server under systemd, with no containers.
audience: users, operators
owner: integrator
status: stable
---

# Without Docker

A Mac, or a Linux server without Docker, runs Vyre straight from the npm package. There is one
background process, running as your own login account (never root), with its data in `~/.vyre`
in that account's home. Vyre's history reads the same `~/.claude/` as your own `claude`. The
setup page at vyre.run/setup installs a Linux server with Docker, or a Mac that stays on as a
service, as in [Install](install.md); this page is for running Vyre from the package instead,
and you finish setup with the server's own six screens, in [Onboarding](onboarding.md).

## What you need

- Node 22.5 or newer (`node --version`).
- Claude Code: `npm install -g @anthropic-ai/claude-code`.
- Tailscale on the machine itself, from <https://tailscale.com/download>. On Linux it must use
  its network interface (`tailscale0`); in userspace networking mode the onboarding stops at the
  Tailscale step and says so. New to Tailscale? See [Tailscale, from zero](tailscale.md); MagicDNS
  and HTTPS certificates must be on ([step 4](tailscale.md#4-turn-on-magicdns) and
  [step 5](tailscale.md#5-turn-on-https-certificates)).
- On Linux: systemd.

## Install the package

Vyre is not on npm yet, so install the same tarball the Docker box builds from:

```
npm install -g https://vyre.run/box/vyre.tgz
```

Once Vyre is published, this becomes `npm install -g vyre`.

The package is about 6 MB. Search by meaning uses a local model of about 130 MB, which Vyre
fetches into `~/.vyre` (`embedder/` and `models/`) the first time it indexes; until then search
matches keywords. `vyre recall --setup` fetches it now.

## Run it

::: tabs
::: tab On this Mac

```
vyre up                  # role local: this Mac talks to your box
vyre up --box            # or: this Mac is the box
vyre up --connect https://alex.vyre.run   # a box you already set up
```

A Mac's role is `local` by default. `vyre up` starts Vyre on this Mac, finds your box on the
tailnet (or asks where Vyre should run), asks the box to pair this Mac (you approve it in the
Deck on your phone), offers once to add Vyre's line to Claude Code's status line, and builds and
opens the Lumen (`--no-capsule` skips that). The full walk-through is
[Install, step 10](install.md#10-put-the-lumen-on-your-mac).

`vyre up --box` sets the role to `box` and prints the onboarding link. On a Mac it also opens
the link in your browser. The Mac then serves your phone, so it has to stay awake for the
phone to reach it. For a Mac that is the always-on server, use the setup page and choose **A
Mac that stays on** ([Install](install.md#2-run-the-line-on-your-server)): it installs Vyre as a
service that starts when the Mac does, which `vyre up --box` does not.

There is no login item. `vyre up` starts Vyre, and restarts it when the installed version or
the role has changed. Some commands, such as `vyre recall`, `vyre start` and `vyre capsule`, also
start it when it is not running; others, such as `vyre status`, only report. The rest:

```
vyre status              # is it running, and what is it running
vyre down                # stop it
vyre modules             # every module and whether it started
```

Its output goes to `~/.vyre/logs/vyred.out`, and its log to `~/.vyre/logs/`, one file
per day (`2026-09-27.log`).

::: tab On a server

```
npm install -g https://vyre.run/box/vyre.tgz
sudo vyre up --system --user alex
vyre up
```

This installs Vyre under systemd. `--user` names the account it runs as; it can never be root. Under sudo it defaults to the
account that ran sudo. Add `--dry-run` to see every change without making one.

`vyre up --system` does this, and running it again changes only what differs:

1. Creates `~/.vyre` for that account, mode 0700.
2. Writes two units in `/etc/systemd/system/`:
   - `vyre.socket` owns port 443 on `tailscale0` only (`ListenStream=443`,
     `BindToDevice=tailscale0`) and hands it to Vyre as fd 3. Vyre needs no capability for
     443, and no child process can take the port first.
   - `vyre.service` runs Vyre as the account with `Restart=always` and `NoNewPrivileges=yes`,
     `VYRE_HOME` set to `~/.vyre`, and optional environment from `~/.vyre/env`.
3. Runs `tailscale set --operator=alex`, so Vyre can run `tailscale up` and `tailscale cert`
   from the onboarding page without root.
4. Enables `vyre.socket`. If `tailscale0` does not exist yet it says so and skips this; run
   `sudo vyre up --system --user alex` again once Tailscale is up. Until then Vyre serves only
   its local socket.
5. Enables and restarts `vyre.service`.

Then plain `vyre up`, as that account, prints the onboarding link and, over SSH, the `ssh -L`
line to reach it from your own computer. The steps from there are in
[Onboarding](onboarding.md).

> [!SNAG] vyre up --system says systemd is required
> Without systemd there is no system install. Run `vyre daemon` (Vyre in the foreground) as the
> account under your own supervisor, with `VYRE_HOME` set, and restart it when it exits.

> [!SNAG] The onboarding stops at the Tailscale step
> "Tailscale runs in userspace networking mode; Vyre needs its network interface." Run Tailscale
> with its `tailscale0` interface (the default on Linux), not with `--tun=userspace-networking`.

### Upgrade

```
sudo npm install -g https://vyre.run/box/vyre.tgz && vyre up
```

`vyre up` sees an older version running, stops it, and systemd starts the new one. If an
upgrade changed the units, `vyre up` prints the line to rewrite them:
`sudo vyre up --system --user alex`.

### Remove

```
vyre name release        # only if you claimed a vyre.run name; it cannot be claimed again
sudo vyre uninstall --system
sudo npm rm -g vyre
```

`vyre uninstall --system` disables and removes both units. `~/.vyre` (the vault, memory and
config) stays unless you add `--purge`, which deletes it and cannot be undone. `--dry-run`
works here too.

:::

## Back up and restore

The same two commands as on a Docker box, run as the account itself:

```
vyre backup                        # vyre-backup-YYYY-MM-DD.vyre, in this folder; asks for a passphrase
vyre down                          # restore needs Vyre stopped
vyre restore vyre-backup-2026-09-27.vyre --force
vyre up
```

Under systemd, stop it with `sudo systemctl stop vyre` instead of `vyre down`. The backup
holds your settings, the store (`vyre.db`), the sealed vault, watchers, module data,
certificates, names, artifacts, project files and session transcripts, sealed with the
passphrase you typed. Keep the file somewhere only you can read, and the passphrase apart from it.

## Where to go next

- [Onboarding](onboarding.md): the browser steps, your Mac and your phone.
- [CLI reference](../reference/cli.md): every `vyre` command.
- [Configuration reference](../reference/config.md): `role`, `network.port` and the rest.
