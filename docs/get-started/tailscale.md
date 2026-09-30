---
title: Tailscale, from zero
summary: Make a Tailscale account, put your Mac, phone and box on one tailnet, turn on MagicDNS and HTTPS, check it works, fix the usual snags, and set up the optional Tailscale features Vyre can use.
audience: users
owner: tailnet
status: stable
---

# Tailscale, from zero

Vyre reaches your box over Tailscale, and only over Tailscale. This page starts before you have
an account and ends with every device on one private network, the box at an HTTPS address such
as `https://vyre.tail1234.ts.net`, and a check that it all works. After that come the optional
Tailscale features Vyre can use. Each of those is off until you turn it on, and you can skip all
of them.

> [!TIP] Useful links
> - Downloads: [all platforms](https://tailscale.com/download), [Mac](https://tailscale.com/download/mac), [iPhone](https://tailscale.com/download/ios), [Android](https://tailscale.com/download/android), [Linux](https://tailscale.com/download/linux)
> - App stores: [Tailscale on the App Store](https://apps.apple.com/us/app/tailscale/id1470499037), [Tailscale on Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn)
> - Admin console: [Machines](https://login.tailscale.com/admin/machines), [DNS](https://login.tailscale.com/admin/dns), [Access controls](https://login.tailscale.com/admin/acls/file), [Keys](https://login.tailscale.com/admin/settings/keys), [General settings](https://login.tailscale.com/admin/settings/general), [Device management](https://login.tailscale.com/admin/settings/device-management), [Trust credentials](https://login.tailscale.com/admin/settings/trust-credentials)
> - Tailscale docs: [MagicDNS](https://tailscale.com/docs/features/magicdns), [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates), [Taildrive](https://tailscale.com/docs/features/taildrive), [Taildrop](https://tailscale.com/docs/features/taildrop), [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh), [Tailnet Lock](https://tailscale.com/docs/features/tailnet-lock), [Funnel](https://tailscale.com/docs/features/tailscale-funnel), [Exit nodes](https://tailscale.com/docs/features/exit-nodes), [Sharing](https://tailscale.com/docs/features/sharing), [Tags](https://tailscale.com/docs/features/tags), [Grants](https://tailscale.com/docs/features/access-control/grants), [Auth keys](https://tailscale.com/docs/features/access-control/auth-keys), [Key expiry](https://tailscale.com/docs/features/access-control/key-expiry), [CLI](https://tailscale.com/docs/reference/tailscale-cli)

The admin console also answers at `console.tailscale.com`; the pages are the same.

## What Tailscale is

Tailscale is a private network made of your own devices, called a tailnet. Each device runs the
Tailscale app, signs in to your Tailscale account, and gets an address in `100.64.x.x` that only
your other devices can reach. The traffic between them is encrypted end to end with WireGuard,
and it works from anywhere: home, a café, a phone on mobile data.

Tailscale also names each device. With MagicDNS on, the box is `vyre.tail1234.ts.net`, where
`tail1234.ts.net` is your tailnet's name, and with HTTPS on, that name gets a real certificate.

> [!WHY] Why does Vyre use Tailscale?
> Two reasons. First, your box never opens a port to the internet: it answers only on its
> tailnet address, so nobody off your tailnet can even find the Deck. Second, Tailscale tells
> Vyre who is calling. For every connection, vyred asks `tailscale whois` about the address it
> came from, and serves it only when the answer is the box's owner, one Tailscale login. That is
> why Vyre has no password and no login screen. The decision is [ADR 0002](../adr/0002-network-and-identity.md);
> how it works is [The tailnet](../concepts/tailnet.md).

## 1. Make a Tailscale account

You need one Tailscale account, and every device you use Vyre from signs in to it.

1. Open <https://login.tailscale.com/start>.
2. Choose how to sign in: Google, Microsoft, GitHub, Apple, or another identity provider
   Tailscale lists. Tailscale has no password of its own; the account is that identity.
3. Finish the short welcome. Tailscale makes your tailnet and gives it a name like
   `tail1234.ts.net`.

The free Personal plan is enough for Vyre.

Pick the identity you will keep. The login you choose here, for example `alex@example.com`,
becomes the box's owner, and the box serves nobody else.

> [!WHY] Can I use my company's tailnet?
> You can, but you may not be allowed to change the settings this page needs, and whoever
> edits that tailnet's policy decides who reaches your box. A personal account is the simple
> path. See [A company tailnet with a locked-down policy](#a-company-tailnet-with-a-locked-down-policy).

## 2. Install Tailscale on each device

::: tabs
::: tab Mac
1. Download Tailscale from <https://tailscale.com/download/mac>, or from the Mac App Store.
2. Open it. Its icon appears in the menu bar.
3. Allow the VPN configuration when macOS asks. Tailscale uses it to add the tailnet.
4. Choose **Log in** from the menu bar icon. A browser tab opens; sign in with the identity from
   step 1.
5. The menu now shows your account and this Mac's name, for example `alex-mac`.

The `tailscale` command comes with the app. If your terminal says `command not found`, use the
app's own copy, which Vyre also looks for:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

Vyre only reads your Mac's Tailscale (`status`, `whois`, `ping`, `lock status`) and runs
`file cp` when you send a file. It never runs `tailscale up`, `set` or `logout` on your Mac.
::: tab iPhone
1. Install [Tailscale from the App Store](https://apps.apple.com/us/app/tailscale/id1470499037).
   Onboarding's last screen also shows a QR code for the download page.
2. Open it and tap **Log in**. Sign in with the identity from step 1.
3. When iOS asks to add a VPN configuration, tap **Allow**, then confirm with Face ID or your
   passcode.
4. The switch at the top of the app is on, and your devices are listed below it.

The iPhone reaches the box only while that switch is on.
::: tab Android
1. Install [Tailscale from Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn).
2. Open it and sign in with the identity from step 1.
3. When Android asks to allow a VPN connection, tap **OK**.
4. The app shows connected, with your devices listed.

Android runs one VPN at a time. If you use another VPN app, starting it turns Tailscale off.
::: tab The server
You do not install Tailscale on the box yourself. Vyre's box runs its own tailscaled in a
container (the `tailscale` service in `box/compose.yml`, named `vyre` on your tailnet), and
onboarding signs it in:

1. In onboarding, step 3 **Put this machine on your tailnet**, press **Connect**.
2. Tailscale's sign-in opens in a new tab. Sign in with the same identity as your Mac.
3. The rows tick, and the step names the machine and its tailnet address. Press **Continue**.

The whole step is in [Onboarding, step 3](onboarding.md#3-tailscale). To sign a headless box in
without a browser, put `TS_AUTHKEY=tskey-auth-...` in `/srv/vyre/.env` before the first
`vyre up`; see [Tailscale](../using/tailscale.md).

To run a `tailscale` command on the box, go through its container:

```sh
cd /srv/vyre && docker compose exec tailscale tailscale status
```

Without Docker, Vyre uses the server's own Tailscale, which you install from
<https://tailscale.com/download/linux>. It must use its network interface, not userspace
networking. See [Without Docker](without-docker.md).
:::

## 3. Sign every device into the same account

The box serves one login. A device signed in as anyone else is on a different network as far
as Vyre is concerned, and the box answers it with `403 not_owner`.

1. Open [Machines](https://login.tailscale.com/admin/machines) in the admin console.
2. Check that every device you use (Mac, iPhone, Android, the box `vyre`) is listed.
3. Under each device's name, check the owner is your login, for example `alex@example.com`.

A device missing from the list is signed in to another tailnet. Sign it out in its Tailscale
app and sign in again with the right identity.

On the box, `vyre owner` prints the login it serves.

> [!WHY] Why does a tagged device not count as me?
> A tagged device belongs to its tag, not to a person, so whois names no user for it. The box
> cannot tell whose it is, and refuses it like any other stranger. The devices you use must be
> signed in as you, untagged.

## 4. Turn on MagicDNS

MagicDNS lets your devices find the box by name. Tailnets made since October 2022 have it on
already; check anyway.

1. Open [DNS](https://login.tailscale.com/admin/dns) in the admin console.
2. Near the top, find your **Tailnet DNS name**, for example `tail1234.ts.net`. Note it: your
   box's address is `https://vyre.` followed by it.
3. Find **MagicDNS**. If a button reads **Enable MagicDNS**, press it. If it offers to disable
   MagicDNS, it is already on.

On each device, leave Tailscale's own DNS setting on (on the Mac it is **Use Tailscale DNS
settings** in the app's settings). Without it the device cannot resolve `ts.net` names.

## 5. Turn on HTTPS certificates

HTTPS is off for new tailnets. Without it the box cannot get a certificate for its `ts.net`
name, and onboarding stops at step 4 with "HTTPS certificates are off for your tailnet".

1. Open [DNS](https://login.tailscale.com/admin/dns) in the admin console. Onboarding's
   **Turn on HTTPS** button opens the same page.
2. Scroll to **HTTPS Certificates**.
3. Press **Enable HTTPS**.
4. Read the note and confirm it: your machine names, such as `vyre`, are published in the
   public Certificate Transparency logs. The addresses stay private.
5. Back in onboarding, press **Check again**. From a terminal on the box, `vyre name ts.net`
   retries.

MagicDNS must be on first. vyred then gets the certificate with `tailscale cert` and renews it
itself, 30 days before it expires.

> [!WHY] Why are machine names public, and does it matter?
> Every public certificate is written to an append-only public ledger, so anyone can see that a
> certificate was issued for `vyre.tail1234.ts.net`. Nobody can reach it: the name resolves only
> on your tailnet. Do not turn on HTTPS if a machine name on your tailnet is itself a secret;
> rename that machine first.

## 6. Check that it works

On the Mac, list your tailnet:

```sh
tailscale status
```

```output
100.64.0.7    alex-mac      alex@  macOS   -
100.64.0.5    vyre          alex@  linux   active; direct 192.0.2.10:41641, tx 3104 rx 2890
100.64.0.9    alex-iphone   alex@  iOS     -
100.64.0.11   alex-pixel    alex@  android offline, last seen 2d ago
```

The first line is this Mac. Every line should show the same login. A `-` means online and idle;
`offline` means the device is not connected now.

Then check the Mac reaches the box:

```sh
tailscale ping vyre
```

```output
pong from vyre (100.64.0.5) via 192.0.2.10:41641 in 23ms
```

`via` and an address means a direct connection. `via DERP(fra)` means Tailscale relays the
traffic through one of its servers: it works, a little slower.

Last, open `https://vyre.tail1234.ts.net` (with your tailnet name) in a browser on the Mac, and
on the phone. The Deck opens, with no certificate warning. `vyre name` prints the address if you
are unsure of it.

## When something is wrong

> [!SNAG] The phone cannot open the address, but the Mac can
> The Tailscale switch on the phone is off, or another VPN app turned it off. Open the Tailscale
> app and turn the switch on. On an iPhone, iOS Settings, VPN, shows whether Tailscale is
> connected. On Android, only one VPN runs at a time: turn the other one off.

> [!SNAG] A device shows "offline, last seen ..."
> The device is asleep, the app was quit, or it lost its network. Wake it and open Tailscale. If
> [Machines](https://login.tailscale.com/admin/machines) marks it **Expired**, its key expired
> (180 days by default): sign in again in its Tailscale app. For the box, open its menu (the
> "..." at the far right of its row) and choose **Disable Key Expiry**, so it never drops off; if
> it has already expired, **Temporarily extend key** first.

> [!SNAG] The Deck answers "403 not_owner"
> This device is signed in to Tailscale as a different account, or it is tagged. Check its
> account in the Tailscale app, sign out and sign in as the box's owner (`vyre owner` on the box
> names it). On the Mac, `vyre up` says the same thing as "the box serves ... and this Mac is
> signed in to Tailscale as ...".

> [!SNAG] A device is not in the list at all
> It signed in to a different tailnet, often a second Google or work account. Sign it out in its
> Tailscale app and sign in with the identity from step 1.

> [!SNAG] "HTTPS certificates are off for your tailnet"
> Do [step 5](#5-turn-on-https-certificates), then press **Check again** in onboarding, or run
> `vyre name ts.net` on the box.

> [!SNAG] The address does not load, and no certificate error either
> The device cannot resolve the name. Check MagicDNS is on ([step 4](#4-turn-on-magicdns)) and
> the device uses Tailscale's DNS. `tailscale ping vyre` tells you whether the box answers at
> all; if it does not, the box is down or offline in Machines.

> [!SNAG] A device says "Needs approval"
> Device approval is on for the tailnet, so an admin must approve each new device. In Machines,
> open the device's menu and approve it, or ask your tailnet's admin to.

### A company tailnet with a locked-down policy

On a tailnet your employer runs, you may not be an admin. Then you cannot turn on MagicDNS or
HTTPS, approve devices, add tags, or edit the policy, and the default policy may not let your
devices reach the box at all. Ask the admin for:

- MagicDNS and HTTPS certificates on.
- Your devices and the box approved.
- A rule that lets your own devices reach your own devices on port 443, for example:

```json
{ "grants": [ { "src": ["alex@example.com"], "dst": ["autogroup:self"], "ip": ["tcp:443"] } ] }
```

Know what you are trusting: on a shared tailnet, whoever edits the policy can grant the optional
features below to other people, such as guests or vault access. Each of those is off in Vyre
until you turn it on, and a policy grant only narrows what Vyre already allows. When in doubt,
use a personal tailnet.

## Optional: more of Tailscale in Vyre

Everything below is optional and off by default. Vyre works fully without any of it. Vyre never
edits your tailnet: where a feature needs a policy entry or an admin setting, you make it, and
Vyre checks what it can.

| Feature | What it gives you | Vyre support |
| --- | --- | --- |
| [VyreDrive](#vyredrive-the-box-folders-on-your-mac) (built on Tailscale's Taildrive) | the box's project folders in Finder | built, read-only unless you make a share writable |
| [Taildrop](#taildrop-send-files-to-the-box) | send a file from the Mac or phone to the box | built |
| [Tailscale SSH](#tailscale-ssh-for-vyre-box-add) | `vyre box add` without SSH keys | built |
| [Tailnet Lock](#tailnet-lock) | only devices you sign may join | built (Vyre reads it; you turn it on) |
| [Egress through your Mac](#glass-egress-through-your-mac-exit-node) | chosen sites see your home address, not the server's | built, tested on a test tailnet only; renewal without expiry in progress |
| [Vault grants](#vault-passes-authorized-by-the-policy) | the policy must also cover a vault pass | built |
| [Guests](#guests-from-another-tailnet) | someone from another tailnet lists your threads | built |
| [Agent nodes](#a-tailnet-node-for-each-agent) | each agent's computer is its own tailnet device | not live yet |
| [Webhooks through Funnel](#webhooks-through-funnel) | signed webhooks from the internet | built |

Most of these have not yet been tried on a real tailnet. If one does not behave as written, the
policy form is the likely cause; `vyre call files.drive.audit`, `vyre hooks status` and the other
checks below say what they see.

### Edit the policy file

Several features add entries to your tailnet policy file.

1. Open [Access controls](https://login.tailscale.com/admin/acls/file) in the admin console. If
   it opens in the visual editor, switch to the JSON editor.
2. Merge each snippet's keys into the one file: add to an existing `grants`, `nodeAttrs`, `ssh`,
   `tagOwners` or `hosts` list rather than adding a second one.
3. Press **Save**. Tailscale refuses a policy with a mistake and says where it is.

The snippets use sample names. Replace them: the owner `alex@example.com`, the Mac `alex-mac`
at `100.64.0.7`, and the box tagged `tag:vyre-box`.

### Tag the box

The snippets name the box by the tag `tag:vyre-box`, because a policy rule for one device needs
a tag. Vyre does not tag the box for you. To tag it:

1. Add the tag's owner to the policy and save:

   ```json
   { "tagOwners": { "tag:vyre-box": ["alex@example.com"] } }
   ```

2. In [Machines](https://login.tailscale.com/admin/machines), open the box's menu (the "..." at
   the far right of its row) and choose **Edit tags**. Add `tag:vyre-box` and press **Save**.

Tagging the box removes its user and turns off its key expiry. The box keeps serving the owner
it already has (`vyre owner`). Tailscale's docs say Taildrop does not reach tagged devices; see
[Taildrop](#taildrop-send-files-to-the-box).

### VyreDrive: the box folders on your Mac

Optional, off by default. Vyre support: built, read-only unless you make one share writable.

VyreDrive (built on Tailscale's Taildrive) puts the box's folders on your Mac. The box shares only
named folders (`projects` and `glass-files` by default, config
`files.drive.shares`), and your Mac mounts them at `~/Vyre/Box/<share>` so Finder and the Capsule
open box files in place. Taildrive is in alpha at Tailscale.

1. Add to the policy:

   ```json
   {
     "tagOwners": { "tag:vyre-box": ["alex@example.com"] },
     "hosts": { "alex-mac": "100.64.0.7" },
     "nodeAttrs": [
       { "target": ["tag:vyre-box"], "attr": ["drive:share"] },
       { "target": ["alex@example.com"], "attr": ["drive:access"] }
     ],
     "grants": [
       { "src": ["alex-mac"], "dst": ["tag:vyre-box"],
         "app": { "tailscale.com/cap/drive": [{ "shares": ["projects", "glass-files"], "access": "ro" }] } }
     ]
   }
   ```

   `src` is the Mac alone. With `alex@example.com` there, every device of yours, the phone too,
   would get the shares.

2. Share a folder and check who can reach it, on the box:

   ```sh
   vyre call --tty files.drive.share '{"name":"projects"}'
   vyre call files.drive.audit
   ```

   Sharing needs your presence (`--tty` asks for a code). A folder with a `.env`, a key or a
   `secrets` folder anywhere inside it is refused (`unsafe_share`, with what was found), and so
   is a checkout whose `.git/config` holds a token in a remote URL or an `Authorization` header.
   The check skips `node_modules`, `dist`, `.next`, `target`, `venv`, `.venv` and `.git/objects`.
   The audit lists any device besides a paired Mac that the policy lets in, and any shared folder a
   secret has landed in since.

3. Mount it on the Mac:

   ```sh
   vyre call files.drive.mount '{"share":"projects"}'
   ```

To edit box files from Finder: `"access": "rw"` in the grant, then make that one share
read-write, from the box's terminal, the Capsule or your paired Mac. It asks for no proof, since
the share already exists; an agent or a guest is refused:

```sh
vyre call files.drive.access '{"name":"projects","mode":"rw"}'
```

Its answer says when the container's mount must change as well: `VYRE_DRIVE_ACCESS=rw` in
`/srv/vyre/.env`, then `docker compose up -d` in `/srv/vyre`. Unmount and mount the share on the
Mac to pick up the change. Every other share stays read-only.

> [!WHY] Why read-only, and why named folders?
> Tailscale serves the files itself, from its own container, which runs as root. Read-only keeps
> it from ever changing a project. And a share serves every file under its folder, `.env` files
> included, without Vyre's file guard in the way, so Vyre shares only folders you name and
> audits who can reach them.

### Taildrop: send files to the box

Optional, off by default. Vyre support: built.

1. Open [General settings](https://login.tailscale.com/admin/settings/general) in the admin
   console and turn on **Send Files**.
2. If the box is signed in as you (untagged), that is all. If you tagged it, add a grant for its
   tag. Tailscale's own docs say tagged devices cannot use Taildrop, and Vyre has not yet
   confirmed this grant on a real tailnet:

   ```json
   { "grants": [ { "src": ["autogroup:member"], "dst": ["tag:vyre-box"],
       "app": { "https://tailscale.com/cap/file-sharing-target": [{}] } } ] }
   ```

3. Send from the Mac:

   ```sh
   vyre send ~/Downloads/northwind-invoice.pdf
   ```

   From the Capsule, option-return on a file row sends it. From a phone, use the Share menu,
   choose Tailscale, then `vyre`.

Files land in the box's inbox, `/work/inbox` (the `inbox` setting under `files` in the box's config moves it). Vyre announces each one as
`files.received` and never opens or runs it. `vyre send` refuses keys, `.env` files and other
secrets, and when Taildrop cannot deliver, it says why.

### Tailscale SSH for `vyre box add`

Optional, off by default. Vyre support: built.

When the server runs Tailscale on the host (not only in Vyre's container) with Tailscale SSH on,
`vyre box add`, `update`, `backup` and `move` connect over it first, with no SSH key, and say so.
If it fails they fall back to the address you typed.

1. On the server's host: `sudo tailscale set --ssh`.
2. Add to the policy:

   ```json
   { "ssh": [ { "action": "accept", "src": ["alex@example.com"], "dst": ["tag:vyre-box"], "users": ["autogroup:nonroot"] } ] }
   ```

   With `"action": "check"` instead, Tailscale asks you to sign in again before each connection;
   `vyre box add` shows that sign-in link in your terminal.

### Tailnet Lock

Optional, off by default. Vyre support: built. Vyre reads the lock state and never turns it on.

With Tailnet Lock, a new device joins only once a device you trust signs it, so even Tailscale's
servers cannot add one. The cost: if you lose your signing devices and your disablement secrets,
nobody can undo it.

1. On the Mac, read its lock key (it starts `tlpub:`):

   ```sh
   tailscale lock
   ```

2. Find the box's lock key on the onboarding card or in the Deck, Settings, Network, **Tailnet
   Lock**. Both show the full command with the box's key filled in.
3. On the Mac:

   ```sh
   tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> <box key>
   ```

4. Save both disablement secrets it prints in the [Vault](../using/vault.md). They are shown
   once.

The admin console can build the same command: [Device management](https://login.tailscale.com/admin/settings/device-management),
**Enable Tailnet Lock**. From then on, sign each new device from a signing device with
`tailscale lock sign`.

### Glass egress through your Mac (exit node)

Optional, off by default. Vyre support: built and tested on a test tailnet, not yet with a real
Tailscale account. The installer does not copy `box/compose.egress.yml` to `/srv/vyre`; you copy it. Renewal with an
OAuth client, so the key never expires, is in progress; today it takes an auth key, which expires.

Some sites refuse or question a datacenter address. You can list sites whose traffic from an
agent's Chrome leaves through your Mac instead. Only those sites go that way, and when the Mac is
off the tailnet they fail rather than fall back to the server's address.

1. On the Mac: the Tailscale menu, **Exit Node**, **Run Exit Node**.
2. In [Machines](https://login.tailscale.com/admin/machines), open `alex-mac`'s menu, choose
   **Edit route settings**, and tick **Use as exit node**.
3. Add to the policy:

   ```json
   {
     "tagOwners": { "tag:vyre-egress": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-egress"], "dst": ["autogroup:internet"], "ip": ["*"] } ]
   }
   ```

4. In [Keys](https://login.tailscale.com/admin/settings/keys), press **Generate auth key**. Turn
   on **Reusable**, **Ephemeral** and **Pre-approved**, and under **Tags** choose
   `tag:vyre-egress`. Copy the key.
5. On the box, copy `box/compose.egress.yml` from the Vyre release into `/srv/vyre`. In
   `/srv/vyre/.env` (not `vyre.env`, which Claude sessions can read), add the key and the Mac,
   add `compose.egress.yml` to the `COMPOSE_FILE` line already there, and make sure the
   `computers` profile is on:

   ```sh
   VYRE_EGRESS_AUTHKEY=tskey-auth-...
   VYRE_EGRESS_EXIT_NODE=alex-mac
   COMPOSE_FILE=compose.yml:compose.egress.yml
   COMPOSE_PROFILES=computers
   ```

6. Start it and choose the sites:

   ```sh
   cd /srv/vyre && docker compose up -d
   vyre call --tty computers.egress.set '{"enabled":true,"sites":["portal.northwind.example"]}'
   ```

A change applies to each agent computer the next time it starts. When the auth key expires, make
a new one and repeat steps 4 and 6. Use a reusable key: a single-use key is spent on the first
start, and the sidecar never comes back after a restart.

> [!WARNING] Keep the Mac offering the exit node
> If the Mac stays on the tailnet but stops offering itself as an exit node (you turn off
> **Run Exit Node**, or the route is unapproved in Machines), the listed sites go out directly,
> from the server's address, with no error. Vyre does not catch this yet.

### Vault passes authorized by the policy

Optional, off by default. Vyre support: built.

A vault pass lets someone use a secret through your box without seeing it. With this on, a
relayed request also needs a policy grant that covers its item. The grant only adds a check: a
revoked or expired pass stays refused whatever the policy says.

1. Add a grant for the holder, here `orders@northwind.example`, who reaches the box through
   machine sharing. `7301` stands for the port the box's vault relay listens on, which you set
   under `vault.relay` in its config (see [Share with another person](../using/vault.md#share-with-another-person)):

   ```json
   { "grants": [ { "src": ["orders@northwind.example"], "dst": ["tag:vyre-box"], "ip": ["tcp:7301"],
       "app": { "vyre.run/cap/vault": [ { "items": ["northwind-*"], "mode": "relayed" } ] } } ] }
   ```

2. In the box's config, set `"vault": { "relay": { "identity": "whois", "grants": "require" } }`
   and restart vyred.
3. Check with `vyre call vault.grants.status`: it shows, per holder, whether the policy covers
   their passes.

Whether a grant reaches a holder from another tailnet is not yet confirmed. If
`vault.grants.status` shows them uncovered, set `grants` back to `"off"`.

### Guests from another tailnet

Optional, off by default. Vyre support: built.

Someone outside your tailnet, for example `desk@harlowlegal.com`, can list threads and close a
Glass session, and nothing else. A guest cannot open or watch Glass: its streams are yours
alone. Every other tool answers as if it did not exist, and a guest can never approve anything.

1. In [Machines](https://login.tailscale.com/admin/machines), open the box's menu and choose
   **Share**. Under **Share by email**, add `desk@harlowlegal.com` and press **Share**. They accept
   from the invite (they must be an admin of their own tailnet to accept).
2. Tell Vyre which tools they may use, either in Vyre:

   ```sh
   vyre call --tty network.guests.add '{"login":"desk@harlowlegal.com","tools":["threads.list"]}'
   ```

   or in the policy:

   ```json
   { "grants": [ { "src": ["desk@harlowlegal.com"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"],
       "app": { "vyre.run/cap/guest": [ { "tools": ["threads.list"] } ] } } ] }
   ```

3. Turn guests on, and see who would be served:

   ```sh
   vyre call --tty network.guests.enable '{"on":true}'
   vyre call network.guests.check
   ```

### A tailnet node for each agent

Optional, off by default. Vyre support: not live yet. The switch exists and the key handling is
written, but the agent computer image cannot run its tailnet side safely until an image change
lands, so turning it on reports the problem and sends nothing. The steps, for when it does:

1. Add to the policy, and remove any allow-all rule with `"src": ["*"]`, which covers tags too:

   ```json
   {
     "tagOwners": { "tag:vyre-agent": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-agent"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"] } ]
   }
   ```

2. In [Keys](https://login.tailscale.com/admin/settings/keys), press **Generate auth key**, with
   **Reusable**, **Ephemeral** and **Pre-approved** on and the tag `tag:vyre-agent`.
3. Store it and let the computers module use it:

   ```sh
   vyre vault put tailscale-agent-authkey
   vyre vault grant tailscale-agent-authkey computers
   ```

4. Turn it on: `vyre call --tty computers.tailnet.set '{"enabled":true}'`.

### Webhooks through Funnel

Optional, off by default. Vyre support: built. This is the only part of Vyre that faces the
internet, one signed route at a time, and it never calls a tool: a verified delivery is stored
and announced as `hook.received` for a watcher to pick up.

1. HTTPS on ([step 5](#5-turn-on-https-certificates)), and in the policy:

   ```json
   { "nodeAttrs": [ { "target": ["tag:vyre-box"], "attr": ["funnel"] } ] }
   ```

2. On the box, turn hooks on, store the sender's signing secret, open a route, and publish it
   with Funnel on port 8443 (vyred holds 443):

   ```sh
   vyre hooks on
   vyre vault put northwind-orders-hook
   vyre vault grant northwind-orders-hook hooks
   vyre hooks open northwind-orders --scheme hmac-sha256 --header x-northwind-signature --secret northwind-orders-hook
   cd /srv/vyre && docker compose exec tailscale tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-orders http://127.0.0.1:7310/hooks/northwind-orders
   ```

3. The sender posts to `https://vyre.tail1234.ts.net:8443/hooks/northwind-orders`. Check with
   `vyre hooks status`, which flags any route Funnel does not publish and any path Vyre has no
   route for.
4. To close it: `vyre hooks close northwind-orders`, then
   `docker compose exec tailscale tailscale funnel --https=8443 --set-path=/hooks/northwind-orders off`.
   After the last route, `docker compose exec tailscale tailscale funnel --https=8443 off`.

## What Vyre will not do

- Change your tailnet. No policy edit, no admin setting, no `tailscale lock`, `funnel` or `serve`
  command. It shows you the steps.
- Touch your Mac's Tailscale beyond reading it and sending files you ask it to send.
- Trust a header. Only `tailscale whois` of the connection's address says who is calling.
- Turn any optional feature on by itself.

## Next

- [Install](install.md), if you have not set up the box yet.
- [Tailscale](../using/tailscale.md): pairing the Mac with the box, and everyday fixes.
- [The tailnet](../concepts/tailnet.md): how identity and addresses work.
- [Mobile](../using/mobile.md): the Deck on your phone.
- [ADR 0014](../adr/0014-tailnet.md): why each optional feature works the way it does.
