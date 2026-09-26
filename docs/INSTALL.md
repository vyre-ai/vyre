# Installing Vyre on a box

How Vyre lays itself out on a Linux server, and why. The network and identity side is in
[ADR 0002](adr/0002-network-and-identity.md).

## The one line

```
curl -fsSL https://vyre.run/install.sh | sh
```

That is `scripts/install-box.sh`. It is safe to run again; every run converges on the same
state. Flags: `--dry-run` prints every change and makes none, `--yes` answers yes to its
questions, `--user NAME` picks the account, `--uninstall [--purge]` reverses it.

What it does, in order:

1. Checks this is Linux with systemd. On a Mac it prints `npm install -g vyre && vyre up` and stops.
2. Picks the account vyred runs as (see [Users](#users)).
3. Checks Node 22.5 or newer, Tailscale and Claude Code. For each one that is missing it asks
   before installing anything, and without a terminal to ask on it prints the command and stops:
   - Node: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs`
     on Debian and Ubuntu;
   - Tailscale: `curl -fsSL https://tailscale.com/install.sh | sh`;
   - Claude Code: `npm install -g @anthropic-ai/claude-code`.
4. `npm install -g vyre`.
5. `vyre up --system --user <account>` as root: the systemd units and the Tailscale operator setting.
6. `vyre up` as the account, which prints the onboarding link, plus the `ssh -L` line when you
   are connected over SSH.

Everything after that happens in the browser (spec section 1).

## Users

**vyred runs as the box owner's own login account, not a dedicated `vyre` system user.**

- Claude Code keeps its sign-in in `~/.claude/` and its transcripts in `~/.claude/projects/`.
  Vyre's history, Recall and projects are built from those. A separate system user would have
  its own `~/.claude`, so the person's `claude` and Vyre's sessions would never see each other.
- The `vyre` CLI finds vyred at `~/.vyre/vyred.sock`, mode 0600. Under one account that just
  works. With a separate user the socket would need a shared group, and anyone in the group
  would be the owner.
- A system user would not isolate Claude from the owner's own files anyway: Claude works on
  those files. Untrusted code (agents' work) runs in containers (spec 7.9), not as a Unix user.

The installer uses `--user`, else the account that ran `sudo`, else the logged-in non-root user.
When it runs as root on a fresh server with no other account, it creates a regular login user
`vyre` and tells you to add your SSH key to it. vyred never runs as root; `vyre up --system`
refuses `--user root`.

## Folders

```
~/.vyre/                     0700, all of it the owner's
  config.json                settings (0600); the onboarding writes name, network, onboard
  vyre.db, -wal, -shm        the store (SQLite, WAL)
  vault/                     sealed vault items
  certs/                     0600 files: acme-production.key, <name>.crt, <name>.key
  names/                     the name directory key, once the hosted directory exists
  modules/                   modules the user installed
  watchers/                  watchers Claude wrote
  models/                    embedding weights (about 23 MB), a cache: safe to delete
  logs/                      YYYY-MM-DD.log from vyred, vyred.out from a detached start
  env                        optional (0600), read by the systemd unit: CLOUDFLARE_VYRE_TOKEN=...
  vyred.sock, vyred.pid
```

Under systemd, vyred's stdout and stderr also go to the journal: `journalctl -u vyre`.

Nothing is written outside `~/.vyre` and the two unit files. The program itself is wherever
`npm install -g` puts it (`/usr/lib/node_modules/vyre` or `/usr/local/lib/node_modules/vyre`).

## Claude Code and its credentials

- The binary is a normal global install (`npm install -g @anthropic-ai/claude-code`), on the PATH
  of the owner's account.
- **Your own `claude` in a terminal** keeps using its own sign-in in `~/.claude/`, which Vyre never
  reads or changes.
- **Sessions Vyre runs headless** (the assistant, agents) use the credential from onboarding
  step 2, which lives in the Vault: `claude-setup-token` (a subscription token from
  `claude setup-token`) or `anthropic-api-key`. The Switchboard hands it to each session in its
  environment at start. It is never written to a file, a log or an event.
- Transcripts from both land in `~/.claude/projects/`, which is how Vyre's history sees them.

## systemd

Two units in `/etc/systemd/system/`, written by `vyre up --system`:

`vyre.socket` owns port 443 on the tailnet interface only, and hands it to vyred as fd 3. vyred
needs no capability to hold port 443, and no child process (Claude, a watcher) can take it first.

```ini
[Unit]
Description=Vyre tailnet listener
After=tailscaled.service
Wants=tailscaled.service

[Socket]
ListenStream=443
BindToDevice=tailscale0
FileDescriptorName=tailnet
NoDelay=true

[Install]
WantedBy=sockets.target
```

`vyre.service` runs vyred as the owner.

```ini
[Unit]
Description=Vyre
After=network-online.target tailscaled.service vyre.socket
Wants=network-online.target

[Service]
Type=simple
User=alex
Group=alex
Environment=VYRE_SUPERVISOR=systemd
Environment=VYRE_HOME=/home/alex/.vyre
EnvironmentFile=-/home/alex/.vyre/env
WorkingDirectory=/home/alex
ExecStart=/usr/bin/node /usr/lib/node_modules/vyre/core/daemon/main.js
Restart=always
RestartSec=2
NoNewPrivileges=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

- `Restart=always` is what upgrades rely on: vyred exits, and systemd starts the new code.
- `NoNewPrivileges=yes` means nothing vyred starts, Claude included, can gain privileges
  through `sudo` or setuid binaries.
- If Tailscale was not installed yet, the socket unit is not enabled (its interface does not
  exist). Run the installer again after installing Tailscale.
- `vyre up --system` also runs `tailscale set --operator=<account>`, so vyred can run
  `tailscale up` and `tailscale cert` from the onboarding page without root.

`vyre down` on a systemd box stops vyred, and systemd starts it again. To stop it for real:
`sudo systemctl stop vyre`.

## Upgrades

```
sudo npm install -g vyre@latest
vyre up
```

`vyre up` sees that the running vyred is older than the installed code, asks it to exit, and
waits for systemd to start the new one. If a new version changes the units, the output says to
run `sudo vyre up --system` too, which rewrites them only when they differ. Data migrations run
at start, per module (spec 7.1). There is no separate upgrade command.

## Uninstall

```
vyre name release                   # frees <you>.vyre.run
sudo vyre uninstall --system        # stops and removes the units
sudo npm rm -g vyre
```

or `curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall`. `~/.vyre` stays, so a
reinstall picks up where it left off. `--purge` also deletes `~/.vyre`, and the vault with it.
The installer never uninstalls Node, Tailscale or Claude Code, and leaves the Tailscale operator
setting alone (`sudo tailscale set --operator=` clears it).

## Backup

```
vyre backup                         # vyre-backup-YYYY-MM-DD.tar.gz, mode 0600
vyre restore <file>                 # with vyred stopped
```

A backup holds `config.json`, a consistent copy of the store (`VACUUM INTO`, taken while vyred
runs), `vault/`, `watchers/`, `modules/`, `certs/` and `names/`. It leaves out `models/` (it
comes back on its own), `logs/`, the socket and the pid file.

The backup contains the sealed vault. Keep it somewhere only you can read, or encrypt it
(`age -r <key> file`). Restore refuses while vyred is running, refuses to overwrite a store
unless `--force`, and rejects archives with absolute paths or `..`.

Claude Code's own `~/.claude/` is not in the backup. Back it up with the rest of your home.
