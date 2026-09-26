---
title: Troubleshooting
summary: The failures people actually hit installing and running Vyre, what each message means, and the command that fixes it.
audience: users, operators, agents
owner: e2e
status: stable
---

# Troubleshooting

Most problems show up as one line from `vyre`. Find that line below. If yours is not here, start with the three commands in [First look](#first-look), and read the log they point to.

## First look

On the box (the server):

```
vyre status                 # is vyred running, and what is it running
vyre logs                   # follow vyred's output
docker compose -p vyre ps   # are the tailscale and vyre containers up
```

On the Mac:

```
vyre status
vyre modules                # every module, and whether it started
vyre link                   # paired with the box, and does the box answer
```

On the Mac, `vyred`'s own output is in `~/.vyre/logs/vyred.out`, and its daily log in `~/.vyre/logs/`. There is no `vyre doctor` command.

If your account on the server is not in the `docker` group, every `vyre` command there needs `sudo`.

## Onboarding

### "This onboarding link has already been used or has expired"

The link works once, for an hour. Run `vyre up` on the box for a new one. The page keeps what you already did and resumes from there.

### The onboarding page will not load

The page listens only on the box's loopback, so from your Mac you reach it through an SSH tunnel.

1. Check that the `ssh -N -L 7300:127.0.0.1:7300 alex@192.0.2.10` line `vyre up` printed is still running in a Terminal tab. It prints nothing while it works.
2. Open the link exactly as printed, with `127.0.0.1:7300`. Do not change the port: the page checks that it is reached on the port it listens on, and answers "Not here." otherwise.
3. If port 7300 is busy on your Mac, stop whatever holds it rather than forwarding a different port.

### The name step says the name is not free, or "no Cloudflare token"

A `<you>.vyre.run` name needs a Cloudflare token for the `vyre.run` zone until the hosted name directory exists. Either give `vyred` the token:

```
cp /srv/vyre/vyre.env.example /srv/vyre/vyre.env
chmod 600 /srv/vyre/vyre.env
nano /srv/vyre/vyre.env      # uncomment CLOUDFLARE_VYRE_TOKEN= and paste the token
vyre update                  # recreates the vyre container so it reads the file
```

or use your tailnet's own name instead, `https://vyre.<tailnet>.ts.net`, with `vyre name ts.net` on the box. Without Docker, the token goes in `~/.vyre/env`.

### Your address does not open

`https://<you>.vyre.run` opens only from your own devices on your tailnet. Install Tailscale on the device and sign in with the same account as the box. Once the address works, the `127.0.0.1:7300` link stops working; that is expected, and you can close the tunnel.

## The box

### "vyre: no box in /srv/vyre (set VYRE_DIR)"

The host's `vyre` wrapper looks for the stack in `/srv/vyre`. Either the install did not finish, or you installed somewhere else: set `VYRE_DIR` to that folder, or run the installer again.

### "vyred did not come up; see: vyre logs"

The containers started but `vyred` did not answer within a minute. Run `vyre logs` and read the last lines. Fix what it names, then run `vyre up` again.

### Start over, keeping your data

```
curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall
curl -fsSL https://vyre.run/install.sh | sh
```

The volumes, and with them the vault, Claude's sign-in and your projects, stay. Add `--purge` to the uninstall to delete them too; it lists them and asks first.

### "the service unit is out of date" (without Docker)

After an upgrade of a systemd install, `vyre up` asks you to rewrite the units. Run the line it prints: `sudo vyre up --system --user <you>`.

## The Mac

### "vyred did not start"

`vyre up` or another command could not start this Mac's `vyred`. It prints the log file; read it (`~/.vyre/logs/vyred.out`). Node must be 22.5 or newer (`node --version`).

### "your box ... did not answer from here"

The reason follows on the same line:

- **"this Mac is not on the tailnet"**, followed in brackets by "Tailscale is not installed", "Tailscale is signed out: open Tailscale and sign in", or Tailscale's own state: install Tailscale on the Mac and sign in with the same account as the box.
- **"the box is offline or unreachable"**: the Mac is on the tailnet but the box did not answer. Check the box is up (`vyre status` on the box) and that the address is right. `vyre up --connect https://vyre.tail1234.ts.net` names it directly.

### "more than one Vyre box answers on your tailnet"

`vyre up` found several boxes and will not guess. Pick one: `vyre up --connect <address>`.

### The pairing code expired

The code `vyre up` prints lasts a few minutes. Run `vyre up` again for a fresh one. `vyre link` on the Mac says when pairing is done. On the box, `vyre link approve <code>` needs your passkey; if it has none it says to approve in the Deck.

## The Capsule

- **macOS says it cannot check the app for malicious software.** The app is not signed yet. Right-click `Vyre.app`, choose **Open**, then **Open** again. If the dialog offers only **Done**, open System Settings, then Privacy & Security, and choose **Open Anyway**.
- **Permissions you grant do not stick.** Move `Vyre.app` to Applications before opening it. Opened from Downloads, macOS runs it from a temporary copy.
- **Control twice does nothing.** Grant Input Monitoring in System Settings, Privacy & Security. Then run `vyre capsule` so it opens wired to this Mac's `vyred`.
- **"The packaged app is older than its source."** You updated the npm package but not the app. Download the zip again, or build it with `vyre capsule build` (needs the Xcode command line tools) and run `vyre capsule --dev`.

## Everyday

### Recall finds nothing

`vyre recall` with no query prints how many sessions and turns are indexed, and whether indexing is still running. On a new install the first pass takes a while; run `vyre index` to index new and changed sessions now. Search by meaning needs the optional embedding model; without it, recall still works as full text.

### The vault says it is locked, or asks for presence

`vyre vault` exits with code 4 when the vault is locked and 3 when an action needs you to prove you are there. With the passphrase keystore, `vyre vault unlock`. For your personal vault account, `vyre vault account unlock`. Human-only actions, like putting a value, ask for Touch ID on the Mac or a passkey in the Deck.

### An agent stopped: budget

An agent on an API key stops when it has spent its budget, and its thread says so. Raise it:

```
vyre agents update kit --budget 40
```

`vyre agents usage kit` shows what it has spent.

### An agent is waiting on you

A thread that needs permission stops and asks. `vyre agents` shows it as waiting. Answer with the line it printed, `vyre threads answer <id> allow` or `deny`, or answer it in the Capsule or the Deck.

## Where to go next

- [Install](install.md) and [Onboarding](onboarding.md), the steps in order
- [Looking after the box](../using/box-care.md): updates, backups, logs
- [CLI reference](../reference/cli.md)
