---
title: Troubleshooting
summary: The failures people actually hit installing and running Vyre, what each message means, and the command that fixes it.
audience: users, operators, agents
owner: e2e
status: stable
---

# Troubleshooting

Most problems show up as one line from `vyre`. Find that line below. If yours is not here, run `vyre doctor` ([First look](#first-look)), and read the log it points to.

## First look

Start with `vyre doctor`, on the Mac or on the server:

```sh
vyre doctor
```

It checks that Vyre is running, that you are signed in to Vyre, the link to your space, the path to your
server and the relay, the server's door, storage, the clock, pairing, a passkey, Claude on the box, the Lumen,
every module, search, that `vyre` is on your PATH and the install size, in under two seconds. Each line is a check that passed, failed (with the one thing to
do next under it), or could not be checked (with why). It only reads: it never signs in, pairs or
opens anything. `vyre doctor --json` gives the same list to a script.

If that does not explain it, these show more:

::: tabs
::: tab On a server
```
vyre status                 # is Vyre running, and what is it running
vyre logs                   # follow Vyre's output
docker compose -p vyre ps   # is the vyre container up
```

`vyre logs`, `docker compose` and `vyre uninstall --keep-data` run through the `vyre` command the installer puts on a Docker server (`/usr/local/bin/vyre`, the `box/vyre` wrapper), not the Mac's own CLI. If your account on the server is not in the `docker` group, every `vyre` command there needs `sudo`.
::: tab On this Mac
```
vyre status
vyre modules                # every module, and whether it started
vyre link                   # paired with the box, and does the box answer
```

Vyre's own output is in `~/.vyre/logs/vyred.out`, and its daily log in `~/.vyre/logs/` (one file a day, such as `2026-09-27.log`).
:::

A healthy `vyre status` says Vyre is running, with its version, its role, how long it has been up
and how many modules are running. A failed module adds `· 1 failed (vyre modules)` to the second
line.

## Setup in the Vyre app

### "That code ran out of time", or "That code was already used"

The pair code in the install line works for one pairing and for 30 minutes. In the app, press **Show the install command** (or go back to **Create a space**) for a new line, and run it on the server. If the earlier line had already started Vyre on the server, the installer prints `Vyre is already running in /srv/vyre, so this installer leaves it alone.` for a new line: run `vyre uninstall --keep-data` on the server first, then paste the line again. Your data stays.

### "Another server answered this install line first"

Two servers used the same install line, and the app does not know which one is yours, so it paired neither. Make a new install line in the app and run it only on your own server. Do not paste an install line into a server you do not own, and do not share one.

### "Your phone cannot reach your Vyre right now"

Check that the server is on and online, and that a work network or a browser extension is not blocking `vyre.run`. Nothing was paired. Run `vyre status` on the server, then try again.

### "that name is reserved", or the name is taken

Pick another name. Service names such as `app`, `login` and `vault`, well-known company names and look-alikes of them are not given out, and a name someone else holds is not free. People and spaces share one set of names, so a space cannot take its owner's name.

### You did not save the recovery code

It is shown once, so nothing can show it again. It is the only way back in if you forget the master password. If you remember the master password, you do not need it: sign in on the new device with your space address, your username and your master password.

### Signing in on a new device by your name

On the new device, open the Vyre app and choose **Sign in**. Type your space address (like `juniper.vyre.run`), your username and your master password. Or press **Sign in with GitHub** and then type the master password, which still unlocks your vault. The password is stretched on the device; the server never sees it. If it says the settings are too weak or too heavy, check the space address: the app refuses a server that asks for that. If it says the password is wrong, try again or use your recovery key.

## The box

### "vyre: no box in /srv/vyre (set VYRE_DIR)"

The host's `vyre` wrapper looks for the stack in `/srv/vyre`. Either the install did not finish, or you installed somewhere else: set `VYRE_DIR` to that folder, or run the installer again.

### "vyre: vyred did not come up; see: vyre logs"

The containers started but Vyre did not answer within a minute. Run `vyre logs` and read the last lines. Fix what it names, then run `vyre up` again.

### Start over, keeping your data

```
vyre uninstall --keep-data
```

Then run the install line again (`curl -fsSL vyre.run/i | sh`). `--keep-data` leaves the volumes, and with them the vault, your AI sign-ins and your projects. `--delete-data` removes them too; without either flag, `vyre uninstall` asks. Before deleting data, `vyre backup` saves everything.

### "the service unit is out of date" (without Docker)

After an upgrade of a systemd install, `vyre up` asks you to rewrite the units. Run the line it prints: `sudo vyre up --system --user alex`.

## The Mac

### "vyred did not start"

`vyre up` or another command could not start Vyre on this Mac. It prints the log file; read it (`~/.vyre/logs/vyred.out`). Node must be 22.5 or newer (`node --version`).

### "your box ... did not answer from here"

The reason follows on the same line:

- **"the box is offline or unreachable"**: the Mac got no answer from the box. Check the box is up (`vyre status` on the box) and that the address is right. `vyre up --connect https://alex.vyre.run` names it directly. `vyre doctor` on the Mac shows the path and the relay.

### The pairing code expired

The code `vyre link pair <address>` shows is good for a short time and for one use. Run the command again for a new one, then approve it in the Vyre app or with `vyre link approve <code>` on the server.

### A Mac's sessions show "offline" on the box

The Vyre app on the box lists the paired Mac's sessions while the Mac is awake and reachable. When it is not, the app shows the box's own sessions. Wake the Mac, check its connection, and run `vyre link` on it. See [The box and the Mac](../concepts/box-and-mac.md#the-box-reads-the-macs-sessions).

## Lumen

### "Lumen is built with Apple's Command Line Tools, which are not installed"

`vyre capsule` builds Lumen on this Mac. Run `xcode-select --install`, then `vyre capsule install`.

### Permissions you grant do not stick

Lumen signed ad hoc is a new identity to macOS after each rebuild (an npm update that changes its source rebuilds it). `vyre capsule` offers once to make a local signing identity ("Vyre Local") in your login keychain; with it, grants survive rebuilds. Without it, turn Vyre off and on again under Input Monitoring after an update.

### Control twice does nothing

Click Lumen's icon in the menu bar. A line starting `Double-Control is off:` says why. Grant Input Monitoring in System Settings, Privacy & Security, then run `vyre capsule` to open it again. Option-Space opens it meanwhile; it needs no permission.

### "Lumen is not installed yet. Build it with vyre capsule install"

`vyre up` found no Lumen source to build on this Mac, or `vyre doctor` found no built app in `~/.vyre/capsule`. Run `vyre capsule install`.

## Everyday

### Recall finds nothing

`vyre recall` with no query prints how many sessions and turns are indexed, and whether indexing is still running:

```output
  212 sessions · 18342 turns indexed · indexing now
```

On a new install the first pass takes a while; run `vyre index` to index new and changed sessions now.

Search by meaning needs a local model of about 130 MB. Vyre fetches it into `~/.vyre` the first time it indexes, and searches by keyword until then; `vyre recall` says so on its last line, for example "downloading the search model (about 128 MB, once); search is by keyword until then · vyre recall --setup". Run `vyre recall --setup` to fetch it now and wait for it. If it fails, it says why: check the network and run it again.

### The vault says it is locked, or asks for presence

`vyre vault` exits with code 4 when the vault is locked and 3 when an action needs you to prove you are there. Human-only actions, like putting a value, ask you to prove you are there: `vyre vault` asks for Touch ID on the Mac, or for the code Vyre writes to your terminal. Without a terminal (from an agent's Bash, say) the command is refused and exits with code 3. In the Vyre app, it is your passkey.

### An agent stopped: budget

An agent on an API key stops when it has spent its budget, and its thread says so. Raise it:

```
vyre agents update kit --budget 40
```

`vyre agents usage kit` shows what it has spent.

### An agent is waiting on you

A thread that needs permission stops and asks. `vyre agents` shows it as waiting. Answer with the line it printed, `vyre threads answer <id> allow` or `deny`, or answer it in Lumen or the Vyre app.

## Where to go next

- [Install](install.md), the steps in order
- [Looking after the box](../using/box-care.md): updates, backups, logs
- [CLI reference](../reference/cli.md)
