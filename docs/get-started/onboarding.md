---
title: Onboarding
summary: Set up Vyre from start to finish, in order: your Mac, the server, the browser steps, your devices and the Capsule.
audience: users
owner: integrator
status: stable
---

# Onboarding

Vyre runs Claude Code on a server you own and puts it on your Mac and your phone. You start on
your Mac, Vyre sets up the server over SSH, and you finish in the browser. Setup takes about ten
minutes. Why it works this way is in [ADR 0008](../adr/0008-install-journey.md).

> [!GAP]
> The start page on vyre.run is older than this page. Where they differ, follow this one. See [known gaps](../known-gaps.md#the-vyrerunstart-page-is-older-than-these-docs).

## What you need

- A Mac with Node 22.5 or newer (`node --version`) and Claude Code.
- A Linux server you can SSH into, with sudo. Any small VPS works. Docker is installed for you
  if it is missing, after you say yes.
- A Claude subscription (Pro or Max) or an Anthropic API key.
- A Tailscale account. The free plan is enough.

## 1. Start on your Mac

Install Tailscale from <https://tailscale.com/download/mac> and sign in. No account? Signing in
with Google, GitHub, Apple or Microsoft makes one. Then install Vyre and run `vyre up`:

```
npm install -g https://vyre.run/box/vyre.tgz
vyre up
```

Vyre is not on npm yet, so the first line installs the published tarball. Once it is on npm,
the line becomes `npm install -g vyre`.

`vyre up` starts vyred for this Mac and looks for a Vyre box on your tailnet. With none found,
it asks where Vyre should run. Pick a server and give it the address you SSH to:

```
  Where should Vyre run?
    1  on a server I can SSH to (recommended)
    2  on this Mac
    3  I already set up a box
  1, 2 or 3? 1
  server (user@host): alex@203.0.113.4
```

That is the same as typing `vyre box add alex@203.0.113.4`.

## 2. Vyre sets up the server

The Mac connects over SSH, looks at the server, and tells you what it will change before it
changes anything:

```
  alex@203.0.113.4: Ubuntu 24.04 LTS, no Docker yet

  Vyre will, on alex@203.0.113.4:
    install Docker with get.docker.com
    create /srv/vyre and put Vyre's stack in it
    add /usr/local/bin/vyre
    start Vyre, which waits for you to finish setting it up in your browser

  Go ahead? [y/N]
```

If sudo on the server needs your password, it asks on this terminal. When your account cannot
reach Docker without sudo, the plan also offers to add it to the `docker` group, which is
root-equivalent on that server. A server that is not Linux, or has no `/dev/net/tun`, is refused
before anything changes.

The installer is the same one-line installer described in [Install on a server](install.md).
The first build takes a few minutes. Then your browser opens and the terminal says:

```
  Finish in your browser. I'll wait here.
```

The Mac holds the SSH tunnel to the server's setup page open for you. If you stop with Ctrl-C,
run `vyre box add alex@203.0.113.4` again: it carries on from where the server stands.

## 3. Finish in the browser

One step a screen. Every step can be skipped and finished later from Settings, or with a `vyre`
command.

1. **You.** Your name, and a name for your assistant.
2. **Claude Code.** Choose **Sign in with Claude** to use your subscription: Claude's sign-in
   opens in a new tab, and you paste the code it gives you. Or paste an Anthropic API key. Either
   goes into Vyre's Vault, never into a file.
3. **Tailscale.** **Connect** opens Tailscale's sign-in for the server. Use the same account as
   your Mac. The page waits until the server is on your tailnet.
4. **Your address.** Vyre gets a certificate for the server's tailnet name,
   `https://vyre.<your-tailnet>.ts.net`. The first time, Tailscale needs HTTPS turned on for your
   tailnet: press **Turn on HTTPS**, flip the switch on the page that opens, come back and press
   **Check again**. The page then moves to your new address. Your own domain is an option on
   this screen.
5. **Your history.** Vyre reads your earlier Claude Code sessions with a progress bar. Search
   them by what was said, pick some, and make your first project. Or skip.
6. **Your devices.** Scan the two codes with your phone: the first installs Tailscale, the
   second opens Vyre. Your Mac is already connected. This screen also has the Capsule download.

Your assistant says hello on the last screen. Press **Open Vyre**.

A `<you>.vyre.run` address instead of the ts.net name needs a Cloudflare token for the
`vyre.run` zone (`CLOUDFLARE_VYRE_TOKEN` in `/srv/vyre/vyre.env`) until the hosted name
directory exists. It is not built yet.

## 4. Your passkey, and your Mac

Back in the terminal, Vyre opens one more page to make your passkey (Touch ID, or your phone).
The link works once, for 10 minutes. The passkey approves everything on your box from now on.

Then the Mac asks the box to pair:

```
  Approve this Mac in your Deck: it names this Mac (alex-mac) and asks for your passkey. Code: 123-456
  vyre link shows when it is done.
```

Approve it in the Deck, check the code matches, and confirm with your passkey. A terminal on the
box cannot approve a Mac on its own: `vyre link approve` there points you to the Deck. `vyre link`
on the Mac says when it is paired.

> [!GAP]
> There is no Deck screen that approves a pairing yet, so this step may stall. See [known gaps](../known-gaps.md#approving-a-mac-in-the-deck).

The terminal ends with:

```
  Vyre is ready.

    your box        https://vyre.tail1234.ts.net
    your assistant  juno
    next            vyre      (your projects and threads)
```

Type `vyre` any time for your projects and threads. `vyre up` prints this block again whenever
you want to check.

## 5. Your phone and other devices

Your address opens only from your own devices on your tailnet. On the phone, scan the two codes
from the **Your devices** screen, or install Tailscale from <https://tailscale.com/download>,
sign in with the same account, and open your address. Add it to the home screen to use it like
an app.

## 6. The Capsule

The Capsule is the command bar on your Mac: press Control twice, anywhere. Install it with:

```
vyre capsule install
```

That downloads `Vyre-mac.zip`, refuses it unless its SHA-256 matches the published one, and puts
`Vyre.app` in `~/Applications`. `vyre up` opens it from then on.

The app is not signed with a Developer ID or notarized yet, so macOS stops it the first time:

1. In Finder, right-click (or Control-click) `Vyre.app` and choose **Open**.
2. macOS says it cannot check the app for malicious software. Choose **Open** again. On recent
   macOS the dialog may offer only **Done**. If so, open System Settings, then Privacy &
   Security, scroll to the note about Vyre, and choose **Open Anyway**. From the terminal, this
   does the same (it removes the download mark macOS checks):
   `xattr -dr com.apple.quarantine ~/Applications/Vyre.app`
3. Grant Input Monitoring when it asks: macOS needs it to see Control pressed twice. Contacts is
   optional, for contact results.

After the first open it starts normally. `vyre capsule` opens it wired to this Mac's vyred.

To use Vyre's tools inside plain `claude` on the Mac:

```
claude --plugin-dir "$(npm root -g)/vyre/harness"
```

The Mac install is about 480 MB, most of it the optional local embedding model that lets search
find things by meaning. Search still works without it, as full text.

## Other ways in

- **Already on the server?** Run `curl -fsSL https://vyre.run/install.sh | sh` there, then open
  the link it prints (it also prints the `ssh -L` line to reach it from your laptop). Afterwards,
  `vyre up` on your Mac finds the box on your tailnet by itself and asks you to approve the Mac
  in the Deck. Details are in [Install on a server](install.md).
- **A box you already set up?** `vyre up --connect https://vyre.tail1234.ts.net`.
- **No server?** `vyre up --box` makes this Mac the box. It has to stay awake for your phone to
  reach it. See [Without Docker](without-docker.md).

## Later

| You want to | Run on your Mac |
|---|---|
| see the box | `vyre box` |
| update | `vyre box update`, then `npm install -g https://vyre.run/box/vyre.tgz && vyre up` for the Mac |
| back up | `vyre box backup` (one file, keep it private: it holds your vault) |
| move to a new server | `vyre box move user@newhost` (your address comes with it) |
| remove it | `vyre box remove` (your data stays on the server unless you add `--purge`) |

Nothing updates itself yet.

## If something goes wrong

- **The setup link expired or was used.** Run `vyre box add alex@203.0.113.4` again from the
  Mac, or `vyre up` on the server, for a new one. It works once, for an hour.
- **The page will not load** (when you set up from the server). Check the `ssh -N -L` line is
  still running, and that you opened `127.0.0.1:7300`, not `localhost:7300`.
- **The box did not answer from the Mac.** The Mac must be on your tailnet, signed in to the same
  Tailscale account as the box. `vyre up` says which is wrong.
- **On the server:** `vyre status`, `vyre logs`, and `docker compose -p vyre ps`.

More is in [Troubleshooting](troubleshooting.md).
