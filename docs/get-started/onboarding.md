---
title: Onboarding
summary: Set up Vyre from start to finish, in order: your Mac, the server, the browser steps, your passkey, your Mac's pairing, your phone and the Capsule.
audience: users
owner: integrator
status: stable
---

# Onboarding

Vyre runs Claude Code on a server you own and puts it on your Mac and your phone. You start on
your Mac, Vyre sets up the server over SSH, and you finish in the browser. Setup takes about ten
minutes, plus a few minutes for the first build on the server.

> [!WHY] Why start on the Mac and not on the server?
> The Mac already has your SSH key, your browser and your Tailscale sign-in. Starting there means
> you never copy a link or open a tunnel by hand: the Mac holds the tunnel to the server's setup
> page and opens it for you. The full reasoning is in [ADR 0008](../adr/0008-install-journey.md).

## What you need

- A Mac with Node 22.5 or newer (`node --version`) and Claude Code.
- A Linux server you can SSH into, with sudo. Any small VPS works. Vyre installs Docker there
  if it is missing, after you say yes.
- A Claude subscription (Pro or Max) or an Anthropic API key.
- A Tailscale account. The free plan is enough.

## 1. Start on your Mac

1. Install Tailscale from <https://tailscale.com/download/mac> and sign in. No account? Signing
   in with Google, GitHub, Apple or Microsoft makes one.
2. Install Vyre and run `vyre up`:

   ```
   npm install -g https://vyre.run/box/vyre.tgz
   vyre up
   ```

   Vyre is not on npm yet, so this installs the published tarball. `npm install -g vyre` does
   not work until it is.
3. `vyre up` starts vyred for this Mac and looks for a Vyre box on your tailnet. With none found,
   it asks where Vyre should run. Type `1` and the address you SSH to:

   ```output
     Where should Vyre run?
       1  on a server I can SSH to (recommended)
       2  on this Mac
       3  I already set up a box
     1, 2 or 3? 1
     server (user@host): alex@192.0.2.10
   ```

   That is the same as running `vyre box add alex@192.0.2.10`.

> [!SNAG] Tailscale is not running
> `vyre box add` stops before it touches the server when this Mac is not on a tailnet, and prints
> the Tailscale download link. Open Tailscale, sign in, and run the command again.

## 2. Say yes to the server plan

The Mac connects over SSH, looks at the server, and shows what it will change before it changes
anything:

```output
  alex@192.0.2.10: Ubuntu 24.04 LTS, no Docker yet

  Vyre will, on alex@192.0.2.10:
    install Docker with get.docker.com
    create /srv/vyre and put Vyre's stack in it
    add /usr/local/bin/vyre
    start Vyre, which waits for you to finish setting it up in your browser

  Go ahead? [y/N]
```

Type `y`. What else the plan can say:

- **sudo will ask for your password on this terminal**, when sudo on the server needs one.
- **add alex to the docker group**, when your account cannot reach Docker without sudo. That
  group is root-equivalent on that server; it lets Vyre manage the stack without your password.

The installer is the same one described in [Install on a server](install.md). The first build
takes a few minutes. Then your browser opens and the terminal says:

```output
  Finish in your browser. I'll wait here.

    http://127.0.0.1:7300/onboard?t=...
```

The Mac holds the SSH tunnel to that page open while you work. As you finish each step, the
terminal prints it (`You  done`, `Claude Code  skipped`, and so on).

> [!SNAG] The server is refused before anything changes
> A server that is not Linux is refused. So is one without `/dev/net/tun`, which Tailscale needs:
> run `sudo modprobe tun` on it, or on a VPS turn on TUN in the provider's panel, then run
> `vyre box add alex@192.0.2.10` again.

> [!SNAG] You pressed Ctrl-C, or the link expired
> Run `vyre box add alex@192.0.2.10` again. It carries on from where the server stands and
> opens a fresh link. A link works once, for an hour.

## 3. Finish in the browser

One step a screen. Every step except the last has **Skip for now**; a skipped step can be
finished later from Settings in the Deck.

1. **You.** Your name and your assistant's name (for example `alex` and `juno`). Your name is
   lowercase letters, numbers and hyphens, 3 to 32 long, starting with a letter.
2. **Claude Code.** Choose **Your Claude subscription** and press **Sign in with Claude**:
   Claude's sign-in opens in a new tab, and you paste the code it gives you back on this page.
   Or choose **An Anthropic API key** and press **Save key**. Either goes into Vyre's Vault,
   never into a file.
3. **Tailscale.** Press **Connect**. Tailscale's sign-in opens in a new tab: use the same account
   as your Mac. The page waits until the server is on your tailnet.
4. **Your address.** Press **Get your address**. Vyre gets a certificate for the server's tailnet
   name, `https://vyre.<your-tailnet>.ts.net`. When it is done, press **Switch to** your
   address. The page moves there and asks you to make your passkey (Touch ID, or your phone):
   the passkey approves everything on your box from now on.
5. **Your history.** Vyre reads the Claude Code sessions already on the server. Search them by
   what was said, pick some, and make your first project. Or skip.
6. **Your devices.** Scan the two codes with your phone: the first installs Tailscale, the second
   opens Vyre. The Mac column says **Connected** once your Mac is paired; until then it has a
   **Download for Mac** link, which leads to the Capsule steps below. Press **Open the Deck**.

The last screen says **Vyre is ready.**, your assistant says hello, and **Open Vyre** takes you
to the Deck.

> [!SNAG] "HTTPS certificates are off for your tailnet"
> The first time, Tailscale needs HTTPS turned on for your tailnet. Press **Turn on HTTPS**, flip
> the switch on the Tailscale page that opens, come back and press **Check again**. Turning it on
> publishes the machine's name in public Certificate Transparency logs.

> [!SNAG] "Lowercase letters, numbers and hyphens, 3 to 32 long, starting with a letter."
> Step 1 does not take a display name like `Alex Rivera` yet. Type a short name such as `alex`.

> [!SNAG] "Your address is not set up yet, so this page cannot open the Deck."
> You skipped **Your address**. The Deck is served only at your address, so go back to step 4 and
> finish it. If the terminal already stopped waiting, run `vyre box add alex@192.0.2.10` again.

> [!WHY] What about my own domain?
> The address step has a collapsed **Your own domain** section. A domain of your own, or a
> `<you>.vyre.run` name, needs a Cloudflare API token set in the box's configuration
> (`CLOUDFLARE_VYRE_TOKEN` in `/srv/vyre/vyre.env` for `vyre.run`) until the hosted name
> directory exists. That directory is not built yet. The tailnet name needs nothing.

## 4. Approve your Mac

Once your address works, the terminal takes over. If you have no passkey yet (you skipped the
detour in step 4), it opens the passkey page now. That link works once, for 10 minutes.

Then the Mac asks the box to pair:

```output
  Approve this Mac in your Deck: it names this Mac (alex-mac) and asks for your passkey. Code: 123-456
  vyre link shows when it is done.
```

1. In the Deck, check that the code matches the one on your Mac.
2. Confirm with your passkey.
3. On the Mac, run `vyre link` to see that it is paired.

A terminal on the box cannot approve a Mac on its own: `vyre link approve` there points you to
the Deck. The code lasts 10 minutes; run `vyre up` on the Mac for a fresh one.

> [!GAP]
> There is no Deck screen that approves a pairing yet, so this step may stall. See [known gaps](../known-gaps.md#approving-a-mac-in-the-deck).

The terminal ends with:

```output
  Vyre is ready.

    your box        https://vyre.tail1234.ts.net
    your assistant  juno
    next            vyre      (your projects and threads)
```

Type `vyre` any time for your projects and threads. `vyre up` prints this block again whenever
you want to check. If it starts with `Almost there: your box has no address yet.`, finish **Your
address** (step 3.4 above).

## 5. Your phone and other devices

Your address opens only from your own devices on your tailnet. On the phone:

1. Scan the two codes from the **Your devices** screen, or install Tailscale from
   <https://tailscale.com/download> and sign in with the same account.
2. Open your address.
3. Add it to the home screen to use it like an app.

More in [On your phone](../using/mobile.md).

## 6. The Capsule

The Capsule is the command bar on your Mac: press Control twice, anywhere.

1. Install it:

   ```
   vyre capsule install
   ```

   This downloads `Vyre-mac.zip`, refuses it unless its SHA-256 matches the one published for
   this version, and puts `Vyre.app` in `~/Applications`. From then on `vyre up` and
   `vyre capsule` open it.
2. The app is not signed with a Developer ID or notarized yet, so macOS stops it the first time.
   In Finder, right-click (or Control-click) `~/Applications/Vyre.app` and choose **Open**, then
   **Open** again.
3. Grant Input Monitoring when macOS asks: it needs it to see Control pressed twice. Contacts is
   optional, for contact results.

> [!SNAG] macOS offers only Done, not Open
> Open System Settings, then Privacy & Security, scroll to the note about Vyre, and choose
> **Open Anyway**. Or remove the download mark macOS checks, from the terminal:
> `xattr -dr com.apple.quarantine ~/Applications/Vyre.app`

To use Vyre's tools inside plain `claude` on the Mac:

```
claude --plugin-dir "$(npm root -g)/vyre/harness"
```

The Mac install is about 480 MB, most of it the optional local embedding model that lets search
find things by meaning. Search still works without it, as full text.

## Other ways in

- **Already on the server?** Run `curl -fsSL https://vyre.run/install.sh | sh` there, then open
  the link it prints (it also prints the `ssh -N -L` line to reach it from your laptop). Then
  run `vyre up` on your Mac: it finds the box on your tailnet and asks you to approve the Mac in
  the Deck. Details are in [Install on a server](install.md).
- **A box you already set up?** `vyre up --connect https://vyre.tail1234.ts.net`, or `vyre up`
  and pick `3`.
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

Nothing updates itself yet. `vyre box update` prints `npm i -g vyre@latest` for the Mac, which
fails until Vyre is on npm: use the tarball line above. See
[known gaps](../known-gaps.md#vyre-box-update-does-not-upgrade-the-mac).

If something goes wrong, see [Troubleshooting](troubleshooting.md).
