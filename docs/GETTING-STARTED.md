# Getting started

The exact steps to put Vyre on your server and your Mac, in order. The same page is on the
site at [vyre.run/start](https://vyre.run/start).

Vyre is not on npm yet, and the Mac app is not signed. Until both are done, the server installs
from a tarball on vyre.run (checked against a published SHA-256), and the Mac installs from the
same tarball. The steps below already account for that.

## What you need

- A Linux server you can `ssh` into, with sudo. Docker is installed for you if it is missing.
- A Mac with Node 22.5 or newer (`node --version`).
- A Claude subscription (Pro or Max) or an Anthropic API key.
- A Tailscale account. The free plan is enough.
- A Cloudflare API token with DNS edit rights on the `vyre.run` zone. vyred uses it to publish
  `<you>.vyre.run` and to get its certificate. The hosted name directory will replace it.

## 1. The server

From your Mac, ssh to the server and run the one line:

```
ssh <you>@<server>
curl -fsSL https://vyre.run/install.sh | sh
```

The installer asks before installing anything (Docker, if the server has none). It lays out the
stack in `/srv/vyre`, installs the `vyre` command to `/usr/local/bin/vyre`, builds the image
from `vyre.run/box/vyre.tgz` after checking its checksum, and starts two containers:
`tailscale` and `vyre`. The first build takes a few minutes.

If a test stack is already in `/srv/vyre`, the installer leaves `/srv/vyre/.env` as it is. To
start clean: `curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall`,
then run the one line again. The data volumes stay unless you add `--purge`.

Then give vyred the Cloudflare token, in a file only you can read:

```
cp /srv/vyre/vyre.env.example /srv/vyre/vyre.env
chmod 600 /srv/vyre/vyre.env
nano /srv/vyre/vyre.env            # uncomment CLOUDFLARE_VYRE_TOKEN= and paste the token
vyre update                        # recreates the vyre container so it reads the file
```

`vyre up` prints the onboarding link, and, because you are on ssh, the tunnel line to reach it:

```
  Open this link to set up Vyre (it works once, for an hour):

    http://127.0.0.1:7300/onboard?t=...

  This box is headless. On your own computer, run this first, then open the link there:
    ssh -N -L 7300:127.0.0.1:7300 <you>@<server>
```

If your account is not in the `docker` group, every `vyre` command on the server needs `sudo`.

## 2. Onboarding, in the browser on your Mac

1. In a second Terminal tab on your Mac, run the `ssh -N -L 7300:...` line and leave it open.
2. Open the `http://127.0.0.1:7300/onboard?t=...` link in your Mac's browser. The link works
   once and for an hour. If it has expired, run `vyre up` on the server for a new one.
3. **You.** Type the name you want, e.g. `alex`. That becomes `alex.vyre.run`. The rest of this page writes `<you>` for it.
4. **Claude Code.** Sign in with your subscription (the page runs `claude setup-token` for you
   and shows Anthropic's sign-in link) or paste an API key. It goes into the Vault.
5. **Tailscale.** Press Connect. Tailscale's own sign-in opens; sign in with your Tailscale
   account. The page waits until the server shows up on your tailnet.
6. **Your address.** Vyre points `<you>.vyre.run` at the server's tailnet address and gets a
   certificate. When that is done the page moves to `https://<you>.vyre.run`, and the
   `127.0.0.1:7300` link stops working. You can close the ssh tunnel.
7. **Your history** and **Your devices** can be skipped for now and finished from Settings.

`https://<you>.vyre.run` only opens from your own devices on your tailnet. Put Tailscale on the
Mac and your phone ([tailscale.com/download](https://tailscale.com/download)) and sign in with
the same account.

## 3. The Mac

Install the CLI from the same tarball the server uses:

```
npm install -g https://vyre.run/box/vyre.tgz
vyre up --connect <you>.vyre.run
```

`vyre up` on a Mac sets its role to `local`, starts vyred for this Mac, and checks that your
box answers (the Mac must be on your tailnet). Plain `vyre up` also works: it looks for your
box on the tailnet and takes it when there is exactly one. Then it pairs this Mac with the box and prints a
code:

```
  pair this Mac: on the box, run vyre link approve 123-456
```

Run that line on the server (`ssh <you>@<server>`, then `vyre link approve 123-456`). The code
expires after a few minutes; `vyre up` again prints a fresh one. `vyre link` on the Mac says
when it is paired. Last, `vyre up` opens the Capsule if you have installed it (next step).

The install is about 480 MB, most of it the optional local embedding model that lets search
find things by meaning. Search still works without it, as full text.

To use Vyre's tools inside Claude Code on the Mac:

```
claude --plugin-dir "$(npm root -g)/vyre/harness"
```

## 4. The Capsule

Download [vyre.run/box/Vyre-mac.zip](https://vyre.run/box/Vyre-mac.zip), unzip it, and move
`Vyre.app` to Applications before you open it. Opened from Downloads, macOS runs it from a
temporary copy, and the permissions you grant it do not stick.

The app is not signed with a Developer ID or notarized yet, so macOS stops it the first time:

1. In Finder, right-click (or Control-click) `Vyre.app` and choose **Open**.
2. macOS says it cannot check the app for malicious software. Choose **Open** again.
   On recent macOS the dialog may offer only **Done**. If so, open System Settings, then
   Privacy & Security, scroll to the note about Vyre, and choose **Open Anyway**.
   If you prefer the terminal, this does the same (it removes the download mark macOS checks):
   `xattr -dr com.apple.quarantine /Applications/Vyre.app`
3. Grant Input Monitoring when it asks: Control twice opens the Capsule from any app, and
   macOS needs that permission to see the key. Contacts is optional, for contact results.

After the first open it starts normally. Run `vyre capsule` (or `vyre up` again) so it opens
wired to this Mac's vyred, then press Control twice anywhere to open it.

## What works today

- **The server install.** The one line installs Docker if you agree, verifies every file against a published SHA-256, builds the image from main, and prints the onboarding link. Tested end to end on a fresh Linux server.
- **Onboarding in the browser.** The one-time link over the `ssh -L` tunnel, with the Claude, Tailscale and name steps.
- **The Mac CLI and Claude Code plugin.** `npm install -g` from the tarball, `vyre up`, and Vyre's tools inside Claude Code.
- **The Capsule.** Control twice, from the zip. It opens after the one-time right-click, Open.
- **Pairing.** `vyre up` on the Mac finds the box, and you approve the code on the box.

Not yet checked on a real server: the Tailscale sign-in, the certificate for your name, and pairing against it. Each works in tests with a simulated tailnet.

## What's coming

- **npm.** `npm install -g vyre` works once the package is published. Until then, use the tarball URL.
- **A published image.** Today each server builds its own from the tarball, which takes a few minutes. `vyre update` rebuilds it.
- **A signed, notarized Mac app.** Until then, right-click, Open. If macOS refuses the zip, `vyre capsule build` (needs the Xcode command line tools) and then `vyre capsule --dev` run the Capsule from the npm install.
- **Names without a token.** `<you>.vyre.run` needs your own Cloudflare token for now. The hosted name directory is designed (ADR 0002) and not built.
- **Approving from your phone.** Today a Mac is approved from the box's terminal. The Deck screen for it is not built.
- **Updates.** Nothing updates itself. On the server, `vyre update`. On the Mac, run the `npm install -g` line again and download the zip again.

## If something goes wrong

- The link says it expired or was used: run `vyre up` on the server for a new one.
- The page will not load: check that the `ssh -N -L` line is still running, and that you opened
  `127.0.0.1:7300`, not `localhost:7300`.
- On the server: `vyre status`, `vyre logs`, and `docker compose -p vyre ps`.
- Start over on the server (keeps your data): `curl -fsSL https://vyre.run/install.sh | sh -s -- --uninstall`,
  then the one line again. Add `--purge` to delete the vault, sign-ins and projects too.
