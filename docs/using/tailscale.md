---
title: Tailscale
summary: Reach your box from your Mac, laptop and phone over Tailscale, pair the Mac with the box, and fix the usual reasons a device cannot connect.
audience: users, operators
owner: tailnet
status: draft
---

# Tailscale

Your box is not on the public internet. It is on your tailnet, the private network Tailscale
makes between your own devices, and every device you use Vyre from joins that tailnet. There is
no Vyre password: when a device connects, vyred asks Tailscale who is on the other end
(`tailscale whois` of the connection's source address) and serves only the box's owner, one
Tailscale login. Why it works this way is in [ADR 0002](../adr/0002-network-and-identity.md);
how the pieces fit is in [Tailnet](../concepts/tailnet.md).

## Know your box's address

The box's Tailscale name is `vyre` (a second box is `vyre-2`). With MagicDNS, which Tailscale
turns on by default, its address is:

```
https://vyre.<tailnet>.ts.net
```

for example `https://vyre.tail1234.ts.net`. The certificate comes from `tailscale cert`. `vyre up`
prints the address once onboarding is done, and so does:

```
vyre name
```

### If the address has no certificate

Tailscale gives a ts.net name a certificate only when HTTPS certificates are on for your tailnet.
If they are off, onboarding says so and offers "Turn on HTTPS", which opens
`https://login.tailscale.com/admin/dns`. Turn on HTTPS Certificates there, then choose
Check again. From a terminal, `vyre name ts.net` retries.

## Connect a device

On each device you want to use:

1. Install Tailscale and sign in with the same login as the box's owner.
2. Open the box's address in a browser. The [Deck](deck.md) opens.

A device signed in as anyone else gets `403 not_owner` and nothing more. So does a tagged device:
a tagged node has no user, so it cannot be the owner. To see or set the owner on the box:

```
vyre owner                          # which login this box serves
vyre owner alex@example.com         # set it
```

For the phone, see [Mobile](mobile.md).

## Connect your Mac to the box

On the Mac, with Tailscale signed in as the owner:

```
npm install -g vyre
vyre up
```

`vyre up` looks for your box on the tailnet: the online peers that answer as a Vyre box. One
answer is your box. Several, and it lists them and asks. None, and it asks where Vyre should run.
If you know the address:

```
vyre up --connect https://vyre.tail1234.ts.net
```

Then the Mac pairs with the box:

1. The Mac asks the box to pair and shows a code. `vyre link pair <address>` does the same by
   hand.
2. Approve that code in the Deck. Now shows a card, "A Mac wants to pair", naming the Mac. Type
   the code from the Mac's screen into **Code on that Mac** and press **Approve**, which asks for
   your passkey. **Deny** turns it down. A terminal on the box cannot give a passkey, so
   `vyre link approve <code>` there answers "approve it in the Deck".
3. Check it on the Mac with `vyre link`:

   ```output
     ● linked to https://vyre.tail1234.ts.net
   ```

> [!GAP]
> A Mac cannot approve its own pairing, and the Mac's browser is on the tailnet as that Mac, so
> the Deck open on the Mac being paired cannot approve it. Open the Deck on your phone or another
> computer on your tailnet. A passkey you made on the Mac works on an iPhone when iCloud Keychain
> is on. See [known gaps](../known-gaps.md#approving-a-mac-in-the-deck).

The first connection pins the box's Tailscale node, so a different machine answering at the same
name later is refused. `vyre link unpair` forgets the box on the Mac, or a Mac on the box
(`vyre link unpair <id>`, with the id `vyre link` lists there). After five wrong codes every
pairing request is cancelled; start again from the Mac.

Vyre never runs `tailscale up`, `set` or `logout` on your Mac. Your Mac's Tailscale stays yours.

## Sign a headless box in without a browser

On a Docker box, put an auth key in `/srv/vyre/.env` before the first `vyre up`:

```
TS_AUTHKEY=tskey-auth-...
```

Make the key untagged. An untagged key signs the node in as the person who made it, which is
what lets vyred name an owner.

## When a device cannot connect

| You see | Why | Fix |
| --- | --- | --- |
| The address does not load | the device is not on the tailnet, or the box is down | open Tailscale on the device and check it is connected; `vyre box` on the Mac says whether the box answers (if you added the box with `vyre box add`) |
| `403 not_owner` | the device is signed in to Tailscale as another login, or is tagged | sign the device in as the owner |
| a certificate error | HTTPS certificates are off for the tailnet | turn them on, then `vyre name ts.net` |
| `vyre up` on the Mac says the box did not answer | the Mac is off the tailnet, or the box is offline | start Tailscale on the Mac, then `vyre up` again |

More in [Troubleshooting](../get-started/troubleshooting.md).

## What it will not do

- It never reads an identity header. `Tailscale-User-*` and `X-Forwarded-*` change nothing.
- It never serves a process on the box as if it were you on a device: a connection from the box's
  own tailnet address is refused.
- It does not use `tailscale serve` or Funnel. Nothing about your box is public.

Coming, from the tailnet workstream (not on this branch): link health in the Deck and Capsule,
sending files to the box with Taildrop, shares with Taildrive, Tailscale SSH for `vyre box add`,
Tailnet Lock status, guest access, and agents' computers as their own tailnet nodes.

## Next

- [Box and Mac](../concepts/box-and-mac.md), what runs where.
- [Mobile](mobile.md), your phone on the tailnet.
- [Security](../security/index.md), what the tailnet protects and what it does not.
