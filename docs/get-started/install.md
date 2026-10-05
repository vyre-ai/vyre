---
title: Install
summary: Put Vyre on a server you own, finish setup at vyre.run/setup, and end at your own address with the Lumen on your Mac and Vyre on your phone, one numbered step at a time.
audience: users, operators
owner: integrator
status: stable
---

# Install

Vyre runs your agents on a server you own. You open Vyre from the Lumen on your Mac, from your
phone and from any browser, and the agents keep working when your Mac is asleep.
Setup starts in your browser at <https://vyre.run/setup>: it gives you one line to paste on the
server, watches the install, and finishes at your own address, such as `https://alex.vyre.run`.
The whole path takes about fifteen minutes. Other ways to install are at the end, in
[Other ways to install](#other-ways-to-install).

> [!WHY] Why a server, and not just my Mac?
> Your assistant and agents keep working when your Mac is asleep or closed, and your phone can
> reach them from anywhere. A small VPS is enough. A Mac that stays on can be the server too
> (step 2).

## Before you start

- [ ] A Linux server you can open a terminal on, with an account that can use `sudo`. Docker is
      installed for you if it is missing, after you say yes. Or a Mac that stays on and plugged in.
- [ ] Size: run one space per server. A space's Records need about 3 GB of memory (3,212 MB is what
      `REQUIRE` in `stores/twenty/space-store.js` checks), so an 8 GB server is comfortable for one
      space with automations. You can host more spaces on one server if it is big enough; Vyre checks
      before it adds one.
- [ ] A Claude, ChatGPT (Codex) or Grok account. One is enough to go on, and you can add the
      others later.
- [ ] A current browser for the setup page: Chrome 133 or newer, Safari 17 or newer, Edge 133 or newer, or Firefox 130 or newer.
- [ ] A phone. You open Vyre on it after setup.

> [!WHY] Do I need a VPN or another network app?
> No. Vyre has its own private network built in, so your server, your computers and your phone
> find each other with nothing to install and nothing to sign in to. Where a direct path is not
> possible, Vyre's relay carries the connection, end-to-end encrypted.

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

1. **Checking Docker**: Docker with Compose 2.24 or newer.
2. **Downloading and verifying**: every file is checked against a published list of checksums,
   and the Vyre image's signature is checked against Vyre's release workflow before the image is
   pulled by its digest. A failed check stops the install, and nothing skips it.
3. **Laying out /srv/vyre**: the stack goes in that folder, owned by your account.
4. **Installing the vyre command**: `/usr/local/bin/vyre`.
5. **Starting Vyre**: Vyre starts in a container on your server.

Near the end the terminal prints four words:

```output
  Check words: marble tiger lantern ocean
  They should match the four on your screen.
```

and finishes with `Your server is ready.` and `Done. Back to your browser.` The four words are
the ones on your screen in step 3. Yours will differ.

> [!SNAG] "Another server already used this code. Your browser is not connected to this server."
> The code works for one server. Go back to <https://vyre.run/setup> and start again for a new
> line.

> [!SNAG] "that setup code does not look right. Copy the install line from your browser again."
> The code in the line was cut short. Copy the whole line again, with the Copy button.

> [!SNAG] "this Docker came from snap", "this Docker runs rootless", or "Podman answering as docker"
> Vyre needs the regular Docker Engine. Install it with
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
the Vyre release's signature before it installs anything. It ends with `Vyre is running. Back in
your browser, it will find this Mac.`

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
shows a link to the sign-in page, and then either a code to enter there or a box to paste the
code the provider shows you. One signed-in account is enough to go on, and you can add the others
later. Press **Continue**.

> [!SNAG] The sign-in does not finish
> A sign-in nobody finishes ends after a while and the page says so. Press the provider's button
> again for a fresh one.

## 6. See your network

Vyre's private network is built in, so there is nothing to connect and nothing to sign in to.
The page shows whether your server is reachable directly or through Vyre's relay. Press
**Continue**.

## 7. Add your phone, or skip it

The page offers a ring that you scan with the Vyre app's camera on your phone. The ring works
once, for five minutes, and the page can make only one. The Vyre phone apps for iPhone and
Android are built from the repository today (see [On your phone](../using/mobile.md)), so most
people press **Skip for now** here and add the phone in step 9. You can add phones later from
your server's own page.

## 8. Open your server

The page says your server has its own address. Press **Get my link**, then open
`alex.vyre.run`. The link works once, for two minutes. Open it in the browser you will use with
your server. It asks for your fingerprint, face or
security key, and that makes you its owner. Nothing else can. A QR code on the page opens the same
link on your phone.

When it works, the page says **You're in**, and you carry on at your address. Now and Agents there
show **Create your assistant**: give it a name such as `juno`, tick **Give it its own computer,
from the pool** if you want it to browse and use apps, and press
**Create**. The assistant sees every project and can drive any session.

> [!WHY] Why a fingerprint, face or security key?
> A passkey cannot be typed into a fake page or read by a program on your server. Vyre asks for
> it before anything that matters: approving a new device, taking over a session, releasing a
> secret. A Claude session running on the server can reach its terminal, but it cannot press
> Touch ID.

> [!SNAG] The link expired
> Press **Get a new link** on the setup page.

> [!SNAG] The address does not open in your browser
> The setup page's network step says whether your server is reachable directly or through the
> relay. If your browser still cannot open the address, run `vyre status` on the server.

## 9. Open Vyre on your phone

There is nothing to install and nothing to sign in to first.

1. Open the Vyre app on your phone and scan the code your server or a computer you are signed in
   on shows, or paste its long code. Both screens show the same three words; say yes only if
   they match. Or open `https://alex.vyre.run/now` in the phone's browser, which reaches your
   server through the relay. On an iPhone, use Safari.
2. In the browser, on an iPhone, tap Share, then **Add to Home Screen**, then **Add**. On
   Android, use Chrome's **Install app**. Open Vyre from the Home Screen: it runs full screen,
   like an app.

Now shows a **Set up this phone** card for notifications and a passkey. More in
[On your phone](../using/mobile.md).

> [!SNAG] The phone says it cannot find the server, or the page never loads
> Check the phone has a connection, then reload the page. If it still fails, run `vyre status` on
> the server.

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

(Plain `vyre up` asks for your server's pairing code instead. It shows three words; confirm they
match the server's screen, and approve with your passkey.)

Approve it in the Deck. On your phone, Now shows a card, "A Mac wants to pair: alex-mac". Type
the code, press **Approve**, and confirm with Face ID or your fingerprint. The same card is on Now
in the Deck on the Mac itself, where the Mac can approve its own request only with a passkey made
on that Mac, confirmed with Touch ID. Run `vyre up` again afterwards and it ends with the block
that says it is ready (`your assistant` names the assistant once you have made one, and says `none
yet` before that):

```output
  Vyre is ready.

    your box        https://alex.vyre.run
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

That is the whole install. Next: [Your first day](first-day.md).

## A Windows PC

A Windows PC is a device you use Vyre from, not a server: the server is Linux (including inside
WSL2 on a Windows PC), or a Mac that stays on. The Windows app is a tray app. It is not
code-signed at 0.2.0, so Windows says it does not recognize the app: choose **More info**, then
**Run anyway**. Its installer, `VyreSetup.exe`, is on the latest release at
<https://github.com/vyre-ai/vyre/releases>, and it is checked against the release's published
checksums. You can also use your server from any browser on the PC, at your address. The app, the CLI and WSL2 are in [Windows](../using/windows.md).

## Looking after the box

Updates, logs, moving to a new server and removing Vyre are in [Box care](../using/box-care.md).
How the server and the Mac fit together, and what runs where, is in
[The box and the Mac](../concepts/box-and-mac.md).

### Backup

From the Mac, `vyre box backup` copies the whole server into one file; the box stops while it
copies and starts again after. On the server itself, `vyre backup` writes
`vyre-backup-YYYY-MM-DD.vyre`, one file sealed with a passphrase you type (12 characters or more).
It holds your settings, the store, the sealed vault, watchers, modules, certificates, names and
the artifacts your agents made, plus your project files and session transcripts unless you leave
them out with `--skip-projects` or `--skip-transcripts`. It leaves out the search model, the logs
and your Claude, Codex and Grok sign-ins (you sign in again after a restore). It opens only with
that passphrase: keep the two apart. The steps are in [Box care](../using/box-care.md).

## Other ways to install

Your server is set up (at vyre.run/setup, or from another Mac) and this is a new Mac. Install
Vyre as in [step 10](#10-put-the-lumen-on-your-mac), then:

```sh
vyre up
```

```sh
vyre up --connect https://alex.vyre.run
```

It asks the server to pair this Mac and shows the code to approve in the Deck, as in step 10.
Plain `vyre up` asks for your server's pairing code. On your own terminal it also offers, once, to show Vyre's line under every Claude Code
session (`vyre statusline install` does it later). Pick `3` at the question `vyre up` asks, if you
would rather type the address there.

The server itself can also run without Docker, from the package: see [Without Docker](without-docker.md).

## If setup stops partway

> [!SNAG] This code has expired. Start again.
> The code lasts one hour. Open <https://vyre.run/setup> again for a fresh line. If the first
> line already got as far as starting Vyre, the installer answers `Vyre is already running in
> /srv/vyre, so this installer leaves it alone.` and a new line does nothing. Run `vyre uninstall --keep-data`
> on the server, then paste the fresh line. Your data stays.

> [!SNAG] The setup link has expired (the SSH and loopback paths)
> The link works once, for an hour. From the Mac, run `vyre box add alex@192.0.2.10` again. On
> the server, run `vyre up`. Either prints a fresh link, and the page keeps every step you
> already finished.

> [!SNAG] "Almost there: your box has no address yet."
> You skipped the address screen on the SSH path, so there is nothing for your Mac or phone to
> reach yet. Run `vyre box add alex@192.0.2.10` again and finish **Your address** in the browser.

> [!SNAG] your box https://alex.vyre.run did not answer from here
> The reason follows on the same line. "the box is offline or unreachable": on the server, run
> `vyre status`.

More failures, and the message each one prints, are in [Troubleshooting](troubleshooting.md).
