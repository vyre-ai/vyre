---
title: Install
summary: Put Vyre on a server you own, finish setup at vyre.run/setup, and end at your own address with the Lumen on your Mac and Vyre on your phone, one numbered step at a time.
audience: users, operators
owner: integrator
status: stable
---

# Install

Vyre runs your agents on a server you own. You open Vyre from the Lumen on your Mac, from your
phone and from any browser on your tailnet, and the agents keep working when your Mac is asleep.
Setup starts in your browser at <https://vyre.run/setup>: it gives you one line to paste on the
server, watches the install, and finishes at your own address, such as `https://alex.vyre.run`.
The whole path takes about fifteen minutes. Other ways to install are at the end, in
[Other ways to install](#other-ways-to-install).

> [!WHY] Why a server, and not just my Mac?
> Your assistant and agents keep working when your Mac is asleep or closed, and your phone can
> reach them from anywhere. A small VPS is enough. A Mac that stays on can be the server too
> (step 2), and on a Mac you can also try Vyre with no server at all, in
> [Other ways to install](#other-ways-to-install).

## Before you start

- [ ] A Linux server you can open a terminal on, with an account that can use `sudo`. Docker is
      installed for you if it is missing, after you say yes. It needs a `/dev/net/tun` device,
      which most servers have. Or a Mac that stays on and plugged in.
- [ ] A Tailscale account. Signing in with Google, GitHub, Apple or Microsoft makes one, and the
      free plan is enough. Setup needs it: Vyre reaches your server over Tailscale, and only over
      Tailscale. New to Tailscale? See [Tailscale, from zero](tailscale.md).
- [ ] Tailscale on the computer you set up from, signed in to that same account. Get it from
      <https://tailscale.com/download>. Your address only opens on devices on your tailnet.
- [ ] A Claude, ChatGPT (Codex) or Grok account. One is enough to go on, and you can add the
      others later.
- [ ] A current browser for the setup page: Chrome 133 or newer, Safari 17 or newer, Edge 133 or newer, or Firefox 130 or newer.
- [ ] A phone. You open Vyre on it after setup.

> [!WHY] Why Tailscale?
> Your server never opens a port to the internet. Tailscale puts your server, computer and phone
> on one private network (your tailnet), and Vyre only answers devices on it. Vyre also uses your
> Tailscale login to know it is you, so there is no Vyre password to steal. More in
> [Tailscale, from zero](tailscale.md#what-tailscale-is).

## 1. Start at vyre.run/setup

Open <https://vyre.run/setup>. The page asks where Vyre will live: **A Linux server** or **A Mac
that stays on**. Choose one.

The page makes a one-time key in your browser and shows an install line that holds a one-time
code. The code works for one hour and for one server, and your browser keeps the key, so keep
this tab open until you reach step 8. Vyre does not host your server and does not see what runs
on it.

## 2. Run the line on your server

Open a terminal on the server as yourself, not as root, and paste the line the page shows. On a
Linux server it looks like this:

```sh
curl -fsSL https://vyre.run/i | VYRE_CODE=... sh
```

The installer asks for `sudo` itself, only for what needs it: Docker, the `/srv/vyre` folder and
`/usr/local/bin/vyre`. It asks before it installs anything. If Docker is missing it asks
`Docker is not installed. Install it now with: curl -fsSL https://get.docker.com | sh ?`.

It works through five steps, and the page shows each one as it happens:

1. **Checking Docker**: Docker with Compose 2.24 or newer, and the TUN device.
2. **Downloading and checking Vyre**: every file is checked against a published list of checksums,
   and the Vyre image's signature is checked against Vyre's release workflow before the image is
   pulled by its digest. A failed check stops the install, and nothing skips it.
3. **Setting up /srv/vyre**: Vyre's files go in that folder, owned by your account.
4. **Installing the vyre command**: `/usr/local/bin/vyre`.
5. **Starting Vyre**: two containers start, one for Tailscale and one for Vyre.

Near the end the terminal prints four words:

```output
  Check words: marble tiger lantern ocean
  They should match the four on your screen.
```

and finishes with `Vyre is installed and running.` and `Done. Go back to the vyre.run/setup tab to finish.` The four words are
the ones on your screen in step 3. Yours will differ.

> [!SNAG] "Another server already used this code. Your browser is not connected to this server."
> The code works for one server. Go back to <https://vyre.run/setup> and start again for a new
> line.

> [!SNAG] "that setup code does not look right. Copy the install line from your browser again."
> The code in the line was cut short. Copy the whole line again, with the Copy button.

> [!SNAG] This server has no /dev/net/tun, which the Tailscale container needs
> Nothing was changed. On your own server run `sudo modprobe tun`. On a VPS or an LXC container,
> turn on TUN in the provider's control panel. Then run the line again.

> [!SNAG] "this Docker came from snap", "this Docker runs rootless", or "Podman answering as docker"
> The Tailscale container needs the regular Docker Engine. Install it with
> `curl -fsSL https://get.docker.com | sh`, then run the line again.

> [!SNAG] "Vyre is already running in /srv/vyre, so this installer leaves it alone."
> An earlier install is running here. `vyre update` updates it. To start over, run
> `vyre uninstall --keep-data`, then paste the line again. Your data stays.

> [!SNAG] The page keeps saying "Waiting for your server"
> Check the line finished in the terminal. The code lasts one hour; after that, press **Start
> again** on the page for a fresh line.

::: tabs
::: tab A Mac that stays on
Paste the line in Terminal on that Mac, as yourself, not root. The page says it asks for your Mac
password once, to set Vyre up as a service that starts when the Mac does, with nobody signed in.
The installer downloads a Node and checks it against a pinned checksum, installs Colima (the
small Linux machine your agents' computers run in) and the GitHub command line tool, and checks
the Vyre release's signature before it installs anything. It ends with `Vyre is running. Go back to
the vyre.run/setup tab to finish.`

After a power cut: with FileVault on, the Mac waits for someone to unlock it at the screen, and
Vyre is off until then. With FileVault off, anyone who takes the Mac can read Vyre's files,
notes and conversations; the vault stays locked behind its password. Either way the Mac switches
itself back on only if "Start up automatically after a power failure" is on in System Settings,
under Energy, and it starts off on a Mac mini. Vyre keeps the Mac awake while it runs, so leave
it plugged in. The installer reads these two settings and tells you which applies.
::: tab A Linux server
The steps above are the Linux path.
:::

## 3. Check the four words

The page finds your server and says **Found your server**, with its name. It then shows four
words and asks whether they match the ones your server's terminal printed. Anyone who saw the
install line could answer this page, so the words are how you know it is your server. If they
match, press **These match my server's terminal**. If they differ, press **They don't match**
and start again from step 1.

## 4. Choose your address

Type a name for your server. Its address is that name followed by `.vyre.run`, and it is yours
for good. The page tells you as you type whether the address is free, such as `alex is free`, and
**Claim this address** turns on when it is.

A name is 3 to 32 letters, digits or dashes, starts with a letter, and has no dash at either end
and no double dash. Vyre's own service names, well-known company names and look-alikes of them
are reserved, so `login` and `google-login` are refused.

> [!SNAG] "that name is reserved"
> Pick another name. Names such as `app`, `login`, `vault` and any name with a well-known
> company's name in it are not given out.

The page then shows a **recovery code**. Save it somewhere safe: it is shown once, and if you
ever reinstall, it takes this address back. If you close the page before pressing **I saved
it**, it is gone. Copying it puts it on your clipboard, where a clipboard history tool may keep
it, so clear that afterwards or write it down.

If you ever give the name up with `vyre name release`, it stays reserved: a name that was pointed at a server cannot be claimed again, by you or anyone else.

Below that is **Use a domain of your own too**, which you can skip. To use a domain you own as
well, type it (for example `harlowlegal.com`) and the page shows one DNS record to add, a CNAME,
then looks it up when you press **Check**. DNS can take a few minutes to show it. The address
`alex.vyre.run` keeps working either way.

Press **Continue**.

## 5. Sign in to your AI

Press **Sign in with Claude**, **Sign in with ChatGPT (Codex)** or **Sign in with Grok**. Each
signs in on its own provider's page, in any browser, and Vyre never sees your password. The page
shows a link to the sign-in page, and then either a code to enter there or a server to paste the
code the provider shows you. One signed-in account is enough to go on, and you can add the others
later. Press **Continue**.

> [!SNAG] The sign-in does not finish
> A sign-in nobody finishes ends after a while and the page says so. Press the provider's button
> again for a fresh one.

## 6. Connect Tailscale

Press **Connect my server**. The page shows a link to Tailscale's sign-in page. Sign in there
with the same account as your computer. The page notices when your server joins, says which
tailnet it joined and as whom, then **Publishing your address**, and finally `Your address is
live`. Press **Continue**.

If the tailnet is a work network, the page says so: your company's admins can see and reach this
server, and a personal Tailscale account is usually what you want. If your tailnet asks for
approval of new devices, the page says `Waiting for approval in your Tailscale admin`: approve
the server in the Tailscale admin console, under
[Machines](https://login.tailscale.com/admin/machines).

> [!SNAG] The address could not be published
> The page shows the reason on the same screen. Fix what it names, then press **Connect my
> server** again.

## 7. Add your phone, or skip it

The page offers a ring that you scan with the Vyre app's camera on your phone. The ring works
once, for five minutes, and the page can make only one. The Vyre phone apps for iPhone and
Android are built from the repository today (see [On your phone](../using/mobile.md)), so most
people press **Skip for now** here and add the phone in step 9. You can add phones later from
your server's own page.

## 8. Open your server

The page says your server has its own address. Press **Get my link**, then open
`alex.vyre.run`. The link works once, for two minutes. Open it in the browser you will use with
your server, on a computer that is on your tailnet. It asks for your fingerprint, face or
security key, and that makes you its owner. Nothing else can. A QR code on the page opens the same
link on your phone.

When it works, the page says **You're in**, and you carry on at your address. Now and Agents there
show **Create your assistant**: give it a name such as `juno`, tick **Give it its own computer,
from the pool** if you want it to browse and use apps you can watch in Glass, and press
**Create**. The assistant sees every project and can drive any session.

> [!WHY] Why a fingerprint, face or security key?
> A passkey cannot be typed into a fake page or read by a program on your server. Vyre asks for
> it before anything that matters: approving a new device, taking over a session, releasing a
> secret. A Claude session running on the server can reach its terminal, but it cannot press
> Touch ID.

> [!SNAG] The link expired
> Press **Get a new link** on the setup page.

> [!SNAG] The address does not open in your browser
> The browser must be on your tailnet: open the Tailscale menu on that computer and check it is
> connected, as the same account you used in step 6. If it is, see
> [the address does not load](tailscale.md#the-address-does-not-load-and-no-certificate-error-either).

## 9. Open Vyre on your phone

Your address only opens on your own devices on your tailnet, so the phone needs Tailscale too.

1. Install Tailscale from your app store, sign in with the same account as your computer, and
   turn its switch on ([iPhone and Android steps](tailscale.md#2-install-tailscale-on-each-device)).
2. Open `https://alex.vyre.run/now` in the phone's browser. On an iPhone, use Safari.
3. On an iPhone, tap Share, then **Add to Home Screen**, then **Add**. On Android, use Chrome's
   **Install app**. Open Vyre from the Home Screen: it runs full screen, like an app.

![Now in the Deck on a phone: what needs you, with the tab bar at the bottom](../using/shots/phone-now.png)

Now shows a **Set up this phone** card for notifications and a passkey. More in
[On your phone](../using/mobile.md).

> [!SNAG] The phone says it cannot find the server, or the page never loads
> Open the Tailscale app. Check three things: it is signed in as the same account as your
> computer, the connection switch (the VPN) is on, and your phone is listed in Tailscale. Then
> reload the page. On iPhone, allow the VPN configuration when iOS asks.

## 10. Put the Lumen on your Mac

The Lumen is Vyre's command bar on the Mac: press Control twice, anywhere. It lives on the Mac
you work on, not on the server. It comes with the `vyre` command, so install that first. This
needs Node 22.5 or newer (`node --version`):

```sh
npm install -g https://vyre.run/box/vyre.tgz
vyre --version
```

```output
0.2.0
```

Then pair the Mac with your server and open the Lumen. Give `vyre up` your address:

```sh
vyre up --connect https://alex.vyre.run
```

It asks the server to pair this Mac and shows a code:

```output
  Approve this Mac on your phone at https://alex.vyre.run, or in the Deck on this Mac
  The Deck there names this Mac (alex-mac) and asks for your passkey. Code: 482-913
  vyre link shows when it is done.
```

(The Mac must be on your tailnet. Plain `vyre up` looks for a Vyre server on your tailnet
instead, and asks which one to pair with when it finds more than one.)

Approve it in the Deck. On your phone, Now shows a card, "A Mac wants to pair: alex-mac". Type
the code, press **Approve**, and confirm with Face ID or your fingerprint. The same card is on Now
in the Deck on the Mac itself, where the Mac can approve its own request only with a passkey made
on that Mac, confirmed with Touch ID. Run `vyre up` again afterwards and it ends with the block
that says it is ready (`your assistant` names the assistant once you have made one, and says `none
yet` before that):

```output
  Vyre is ready.

    your server     https://alex.vyre.run
    your assistant  juno
    next            vyre      (your projects and threads)
```

> [!SNAG] "The Mac that is asking can approve itself only with a passkey."
> You approved on the Mac with no passkey, or with one made on another device. Approve again and
> use Touch ID with a passkey made on this Mac, or approve from your phone.

`vyre up` also builds and opens the Lumen. To build it yourself, or when it did not open:

```sh
vyre capsule install
vyre capsule
```

```output
  vyre capsule install builds Lumen on this Mac; nothing is downloaded.
  Building Lumen for this Mac (once, under a minute).
  Lumen built · /Users/alex/.vyre/capsule/Vyre.app · vyre capsule opens it
  Lumen open · ⌥Space, or Control twice once it is allowed · /Users/alex/.vyre/capsule/Vyre.app
```

The app is built on your Mac with Apple's Command Line Tools, so nothing is downloaded and
Gatekeeper has nothing to quarantine. If they are missing, `vyre capsule install` says to run
`xcode-select --install`. The first time, it offers to make a local signing identity so macOS
keeps the Lumen's permissions across updates.

> [!SNAG] "Lumen is built with Apple's Command Line Tools, which are not installed"
> Run `xcode-select --install`, then `vyre capsule install` again.

> [!SNAG] Control twice does nothing
> Grant Input Monitoring to Vyre in System Settings, Privacy & Security, then run `vyre capsule`
> again. Option-Space opens it meanwhile.

> [!SNAG] "the server serves alex@example.com, and this Mac is signed in to Tailscale as ..."
> The Mac and the server are on different Tailscale accounts. Sign the Mac in to Tailscale as the
> account the server names, then run `vyre up`.

That is the whole install. Next: [Your first day](first-day.md).

## A Windows PC

A Windows PC is a device you use Vyre from, not a server: the server is Linux (including inside
WSL2 on a Windows PC), or a Mac that stays on. The Windows app is a tray app. It is not
code-signed at 0.2.0, so Windows says it does not recognize the app: choose **More info**, then
**Run anyway**. Its installer, `VyreSetup.exe`, is on the latest release at
<https://github.com/vyre-ai/vyre/releases>, and it is checked against the release's published
checksums. You can also use your server from any browser on the PC, at your address, once
Tailscale is installed and signed in there. The app, the CLI and WSL2 are in [Windows](../using/windows.md).

## Looking after the server

Updates, logs, moving to a new server and removing Vyre are in [Box care](../using/box-care.md).
How the server and the Mac fit together, and what runs where, is in
[The server and the Mac](../concepts/box-and-mac.md).

### Backup

From the Mac, `vyre server backup` copies the whole server into one file; the server stops while it
copies and starts again after. On the server itself, `vyre backup` writes
`vyre-backup-YYYY-MM-DD.vyre`, one file sealed with a passphrase you type (12 characters or more).
It holds your settings, the store, the sealed vault, watchers, modules, certificates, names and
the artifacts your agents made, plus your project files and session transcripts unless you leave
them out with `--skip-projects` or `--skip-transcripts`. It leaves out the search model, the logs
and your Claude, Codex and Grok sign-ins (you sign in again after a restore). It opens only with
that passphrase: keep the two apart. The steps are in [Box care](../using/box-care.md).

## Other ways to install

::: tabs
::: tab From my Mac over SSH
Use this when you would rather start on the Mac than at vyre.run/setup. It needs the `vyre`
command on the Mac ([step 10](#10-put-the-lumen-on-your-mac)) and Tailscale on the Mac, signed
in. It sets the server up over SSH and holds the SSH tunnel to the server's own setup page for
you.

```sh
vyre server add alex@192.0.2.10
```

```output
  reaching alex@192.0.2.10
  alex@192.0.2.10: Ubuntu 24.04 LTS, no Docker yet

  Vyre will, on alex@192.0.2.10:
    install Docker with get.docker.com
    create /srv/vyre and put Vyre's stack in it
    add /usr/local/bin/vyre
    start Vyre, which waits for you to finish setting it up in your browser

  Go ahead? [y/N]
```

Plain `vyre up` on a Mac that knows no server asks where Vyre should run: pick `1` and type the
account and address you use with `ssh`. The plan is what Vyre found on your server, so yours may
differ. Type `y`. Vyre copies its installer to the server and runs it there, then prints:

```output
  Finish in your browser. I'll wait here.

    http://127.0.0.1:7300/onboard?t=...
```

Your browser opens that link. Leave the terminal open: it holds the tunnel the page runs
through. The page here is the server's own setup, six screens that name you and your assistant,
sign in to Claude and Tailscale, give the server an HTTPS address on your tailnet (such as
`https://vyre.tail1234.ts.net`), read your Claude Code history and put Vyre on your devices.
Each screen is described in [Onboarding](onboarding.md). With this path the address is on
`ts.net`, not `vyre.run`, and Tailscale's HTTPS certificates must be on for your tailnet
([Turn on HTTPS certificates](tailscale.md#5-turn-on-https-certificates)).

When the address works, the terminal opens a tab to make your passkey, asks the server to pair
with this Mac, and prints the ready block. Approve the Mac in the Deck, as in
[step 10](#10-put-the-lumen-on-your-mac).

> [!SNAG] could not reach alex@192.0.2.10
> Vyre uses your Mac's own `ssh`. Check that `ssh alex@192.0.2.10` works in a terminal first. If
> the server has no SSH key for you, Vyre asks for the password once and reuses the connection.

> [!SNAG] The plan says "add alex to the docker group"
> Your account cannot use Docker without sudo, and sudo needs a password, which later steps over
> SSH cannot type. Joining the `docker` group fixes that. It makes the account root-equivalent on
> that server. Say no and nothing changes.

> [!SNAG] You pressed Ctrl-C, or the terminal closed
> Nothing is lost. Run `vyre server add alex@192.0.2.10` again. It looks at what the server has and
> carries on from there.
::: tab I already have a server
Your server is set up (at vyre.run/setup, or from another Mac) and this is a new Mac. Install
Vyre as in [step 10](#10-put-the-lumen-on-your-mac), then:

```sh
vyre up
```

```sh
vyre up --connect https://alex.vyre.run
```

It asks the server to pair this Mac and shows the code to approve in the Deck, as in step 10.
Plain `vyre up` looks for a Vyre server on the Mac's tailnet and takes the one it finds, with a
line such as `Found your server on your tailnet: https://vyre.tail1234.ts.net`; with several it asks
which one. On your own terminal it also offers, once, to show Vyre's line under every Claude Code
session (`vyre statusline install` does it later). Pick `3` at the question `vyre up` asks, if you
would rather type the address there.
::: tab Only on this Mac
No server: this Mac is the server. Your phone reaches it only while the Mac is awake. Pick `2`
at the question `vyre up` asks, or run:

```sh
vyre up --box
```

```output
  Open this link to set up Vyre. It works once, for an hour:

    http://127.0.0.1:7300/onboard?t=...
```

The link opens in your browser. Follow the six screens in [Onboarding](onboarding.md). With this
Mac as the server there is no other Mac to pair: on **Your devices**, use only the phone card.
Running without Docker, and under systemd on Linux, is in [Without Docker](without-docker.md).
::: tab Without the setup page
You are already in a shell on the server and want the server's own setup instead of
vyre.run/setup. Run the installer there without a code:

```sh
curl -fsSL https://vyre.run/install.sh | sh
```

On a terminal it asks `Paste the setup code from your browser (Enter to skip):`. Press Enter. It
ends with the server's own setup link:

```output
  Open this link to set up Vyre. It works once, for an hour:

    http://127.0.0.1:7300/onboard?t=...

  This server has no screen. On your own computer, run this line first, then open the link there:
    ssh -N -L 7300:127.0.0.1:7300 alex@192.0.2.10
```

On your computer, run the `ssh -N -L` line and leave it running (it prints nothing), then open
the link in that computer's browser. The six screens are in [Onboarding](onboarding.md). Then
install Vyre on the Mac as in [step 10](#10-put-the-lumen-on-your-mac).

> [!SNAG] The setup page will not load
> Check the `ssh -N -L` line is still running, and open the link exactly as printed, with
> `127.0.0.1:7300`. Do not change the port: the page answers "Not here." on any other.
:::

## If setup stops partway

> [!SNAG] This code has expired. Start again.
> The code lasts one hour. Open <https://vyre.run/setup> again for a fresh line. If the first
> line already got as far as starting Vyre, the installer answers `Vyre is already running in
> /srv/vyre, so this installer leaves it alone.` and a new line does nothing. Run `vyre uninstall --keep-data`
> on the server, then paste the fresh line. Your data stays.

> [!SNAG] The setup link has expired (the SSH and loopback paths)
> The link works once, for an hour. From the Mac, run `vyre server add alex@192.0.2.10` again. On
> the server, run `vyre up`. Either prints a fresh link, and the page keeps every step you
> already finished.

> [!SNAG] "Almost there: your server has no address yet."
> You skipped the address screen on the SSH path, so there is nothing for your Mac or phone to
> reach yet. Run `vyre server add alex@192.0.2.10` again and finish **Your address** in the browser.

> [!SNAG] your server https://alex.vyre.run did not answer from here
> The reason follows on the same line. "this Mac is not on the tailnet": sign in to Tailscale on
> the Mac. "the server is offline or unreachable": on the server, run `vyre status`.

More failures, and the message each one prints, are in [Troubleshooting](troubleshooting.md).
