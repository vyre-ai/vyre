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

It checks vyred, Tailscale on both ends (signed in, the same account, MagicDNS and HTTPS on), your
phone on the tailnet, the box's address, a passkey for that address, pairing, Claude on the box and
the Capsule, in under two seconds. Each line is a check that passed, failed (with the one thing to
do next under it), or could not be checked (with why). It only reads: it never signs in, pairs or
opens anything. `vyre doctor --json` gives the same list to a script.

If that does not explain it, these show more:

::: tabs
::: tab On a server
```
vyre status                 # is vyred running, and what is it running
vyre logs                   # follow vyred's output
docker compose -p vyre ps   # are the tailscale and vyre containers up
```

If your account on the server is not in the `docker` group, every `vyre` command there needs `sudo`.
::: tab On this Mac
```
vyre status
vyre modules                # every module, and whether it started
vyre link                   # paired with the box, and does the box answer
```

`vyred`'s own output is in `~/.vyre/logs/vyred.out`, and its daily log in `~/.vyre/logs/` (one file a day, such as `2026-09-27.log`).
:::

A healthy `vyre status` looks like this:

```output
  vyred running · 0.0.1 · box · pid 4242 · up 380s
  17 modules running
```

A failed module adds `· 1 failed (vyre modules)` to the second line.

## Setting up the server from the Mac

### "Tailscale is not running"

`vyre box add` (and `vyre up`, when it sets up a server) checks this Mac's Tailscale first and changes nothing on the server until it is up. Open Tailscale on the Mac, sign in, and run the command again. If Tailscale is not installed, the line is followed by its download link. New to Tailscale? See [Tailscale, from zero](tailscale.md).

### "... is not Linux" or "this server has no /dev/net/tun"

A Vyre box runs on Linux with Docker, and Tailscale needs `/dev/net/tun`. Nothing changed on the server. For the second one, run `sudo modprobe tun` on the server, or turn on TUN in your VPS provider's panel, then run `vyre box add alex@192.0.2.10` again.

### "nothing changed. Run it in a terminal to answer, or add --yes."

`vyre box add` shows its plan and asks before it changes anything. Without a terminal to ask on (in a script, say), it stops. Run it in a terminal, or add `--yes` once you have read the plan.

### "The setup link has expired."

The Mac waited more than an hour for the browser steps. Your box is as you left it: run `vyre box add alex@192.0.2.10` again for a fresh link. The page keeps every step you already finished.

## Onboarding in the browser

### "This onboarding link has already been used or has expired"

The link works once, for an hour. Run `vyre up` on the box for a new one, or `vyre box add` again from the Mac. The page keeps what you already did and resumes from there.

### The onboarding page will not load

This matters when you set up from the server itself (`curl ... | sh`). The page listens only on the box's loopback, so from your Mac you reach it through an SSH tunnel.

1. Check that the `ssh -N -L 7300:127.0.0.1:7300 alex@192.0.2.10` line `vyre up` printed is still running in a Terminal tab. It prints nothing while it works.
2. Open the link exactly as printed. Do not change the port: the page checks that it is reached on the port it listens on, and answers "Not here." otherwise.
3. If port 7300 is busy on your Mac, stop whatever holds it rather than forwarding a different port.

### "HTTPS certificates are off for your tailnet"

Tailscale certificates are off for a new tailnet. On the **Your address** step, press **Turn on HTTPS**, flip the switch on the Tailscale page that opens, come back and press **Check again**. Step by step: [Turn on HTTPS certificates](tailscale.md#5-turn-on-https-certificates).

### "Tailscale runs in userspace networking mode"

The Tailscale step stops when Tailscale on the server has no network interface. Vyre needs `tailscale0`. Run Tailscale in its default mode, not `--tun=userspace-networking`, and press **Check again**.

### "Your address is not set up yet, so this page cannot open the Deck."

You skipped **Your address**. The Deck is served only at your address, never on the loopback link. Go back to that step and finish it.

### Step 1 will not take your name

"Lowercase letters, numbers and hyphens, 3 to 32 long, starting with a letter." A display name such as `Alex Rivera` is refused. Type a short name such as `alex`.

### You want a `<you>.vyre.run` address

The default address is your tailnet's name, `https://vyre.<tailnet>.ts.net`, and needs nothing extra. A `<you>.vyre.run` name needs a Cloudflare token for the `vyre.run` zone until the hosted name directory exists; without one, `vyre name claim` says "no Cloudflare token for the vyre.run zone". To give `vyred` the token on a Docker box:

```
cp /srv/vyre/vyre.env.example /srv/vyre/vyre.env
chmod 600 /srv/vyre/vyre.env
nano /srv/vyre/vyre.env      # uncomment CLOUDFLARE_VYRE_TOKEN= and paste the token
vyre update                  # recreates the vyre container so it reads the file
```

Without Docker, the token goes in `~/.vyre/env`. To go back to the tailnet name, run `vyre name ts.net` on the box.

### Your address does not open

Your address opens only from your own devices on your tailnet. Install Tailscale on the device and sign in with the same account as the box. Once the address works, the `127.0.0.1:7300` link stops working; that is expected, and you can close the tunnel. If the device is on the tailnet and the address still does not load, check MagicDNS: see [the address does not load](tailscale.md#the-address-does-not-load-and-no-certificate-error-either).

## The box

### "vyre: no box in /srv/vyre (set VYRE_DIR)"

The host's `vyre` wrapper looks for the stack in `/srv/vyre`. Either the install did not finish, or you installed somewhere else: set `VYRE_DIR` to that folder, or run the installer again.

### "vyre: vyred did not come up; see: vyre logs"

The containers started but `vyred` did not answer within a minute. Run `vyre logs` and read the last lines. Fix what it names, then run `vyre up` again.

### Start over, keeping your data

```
curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall
curl -fsSL https://vyre.run/install.sh | sh
```

The volumes, and with them the vault, Claude's sign-in and your projects, stay. Add `--purge` to the uninstall to delete them too; it asks first.

### "the service unit is out of date" (without Docker)

After an upgrade of a systemd install, `vyre up` asks you to rewrite the units. Run the line it prints: `sudo vyre up --system --user alex`.

## The Mac

### "vyred did not start"

`vyre up` or another command could not start this Mac's `vyred`. It prints the log file; read it (`~/.vyre/logs/vyred.out`). Node must be 22.5 or newer (`node --version`).

### "your box ... did not answer from here"

The reason follows on the same line:

- **"this Mac is not on the tailnet"**, followed in brackets by "Tailscale is not installed", "Tailscale is signed out: open Tailscale and sign in", or Tailscale's own state: install Tailscale on the Mac and sign in with the same account as the box.
- **"the box is offline or unreachable"**: the Mac is on the tailnet but the box did not answer. Check the box is up (`vyre status` on the box) and that the address is right. `vyre up --connect https://vyre.tail1234.ts.net` names it directly.

### "the box serves ... and this Mac is signed in to Tailscale as ..."

The Mac and the box are on different Tailscale accounts. Sign the Mac in to Tailscale as the box's owner, then run `vyre up`. See [Sign every device into the same account](tailscale.md#3-sign-every-device-into-the-same-account).

### "more than one Vyre box answers on your tailnet"

`vyre up` found several boxes and will not guess. In a terminal it asks which one; otherwise pick with `vyre up --connect <address>`.

### The pairing code expired

The code `vyre up` prints lasts 10 minutes; after that `vyre link` says "the pairing code expired; start again". Run `vyre up` again for a fresh one. On the box, `vyre link approve <code>` needs your passkey, which only the Deck can give, so it says to approve in the Deck.

### "The Mac that is asking cannot approve itself."

You approved the pairing in the Deck on the Mac you are pairing. The box takes the approval only from another of your devices. Open Vyre on your phone: Now shows the request as "A Mac wants to pair:" and the Mac's name. Type the code the Mac shows, press **Approve**, and confirm with your passkey. A passkey you made on the Mac is on your iPhone when iCloud Keychain is on.

> [!GAP]
> The Deck approves a pairing, but not from the Mac being paired. Approve it from your phone
> (or another device on your tailnet) with your passkey. See
> [known gaps](../known-gaps.md#approving-a-mac-in-the-deck).

### "That code does not match. Check the code on the Mac and try again."

Type the code as the Mac shows it in `vyre up` or `vyre link`, such as `482-913`. After too many wrong codes the box cancels every request ("Too many wrong codes, so every request was cancelled. Start again on the Mac."): run `vyre up` on the Mac again.

### A Mac's sessions show "offline" on the box

The Deck on the box lists the paired Mac's sessions while the Mac is awake and on the tailnet. When it is not, the Deck shows the box's own sessions and a chip such as "alex-mac offline". Wake the Mac, check Tailscale is connected, and run `vyre link` on it. See [The box and the Mac](../concepts/box-and-mac.md#the-box-reads-the-macs-sessions).

## The Capsule

### "The Capsule is built with Apple's Command Line Tools, which are not installed"

`vyre capsule` builds the Capsule on this Mac. Run `xcode-select --install`, then `vyre capsule install`.

### Permissions you grant do not stick

A Capsule signed ad hoc is a new identity to macOS after each rebuild (an npm update that changes its source rebuilds it). `vyre capsule` offers once to make a local signing identity ("Vyre Local") in your login keychain; with it, grants survive rebuilds. Without it, turn Vyre off and on again under Input Monitoring after an update.

### Control twice does nothing

Click the Capsule's icon in the menu bar. A line starting `Double-Control is off:` says why. Grant Input Monitoring in System Settings, Privacy & Security, then run `vyre capsule` so it opens wired to this Mac's `vyred`. Option-Space opens it meanwhile; it needs no permission.

### "the Capsule is not installed: vyre capsule install"

`vyre up` found no Capsule source to build on this Mac, or `vyre doctor` found no built app in `~/.vyre/capsule`. Run `vyre capsule install`.

## Everyday

### Recall finds nothing

`vyre recall` with no query prints how many sessions and turns are indexed, and whether indexing is still running:

```output
  212 sessions · 18342 turns indexed · indexing now
```

On a new install the first pass takes a while; run `vyre index` to index new and changed sessions now.

Search by meaning needs a local model of about 130 MB. Vyre fetches it into `~/.vyre` the first time it indexes, and searches by keyword until then; `vyre recall` says so on its last line, for example "downloading the search model (about 128 MB, once); search is by keyword until then · vyre recall --setup". Run `vyre recall --setup` to fetch it now and wait for it. If it fails, it says why: check the network and run it again.

### The vault says it is locked, or asks for presence

`vyre vault` exits with code 4 when the vault is locked and 3 when an action needs you to prove you are there. Human-only actions, like putting a value, ask you to prove you are there: `vyre vault` asks for Touch ID on the Mac, or for the code vyred writes to your terminal. Without a terminal (from an agent's Bash, say) the command is refused and exits with code 3. In the Deck, it is your passkey.

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
- [Tailscale, from zero](tailscale.md#when-something-is-wrong): tailnet snags, device by device
- [CLI reference](../reference/cli.md)
