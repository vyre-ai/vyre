---
title: Device row
summary: One device in Devices, saying how it reaches the box now, what it holds, when it was last seen, and for a browser whether you trust it, with Trust, Stop trusting and Remove.
audience: builders
owner: app-design
status: draft
---

# Device row

One device paired with the box: the box itself, the Mac, each phone, each browser from
app.vyre.run, and the relay. Every row answers three questions: how it reaches the box right now
(and what it switches to), when it was last seen, and what it holds. Drawn on the boards
"Devices, network and VyreDrive" and "Devices, trusting a browser for the vault".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/views/vault-places.js` devicesView, `deck/css/views/vault.css`, `deck/js/health.js` (work/pwa) | partial |
| App | `apps/app/app/devices.tsx` DeviceRow, `src/state/devices-model.ts` (work/mobile) | partial |
| Lumen | not used | |

## Anatomy

1. **Tile.** 40 square (32 in a browsers list), radius 10, fill `--hover`, a 20 device icon in
   `--text`: box, laptop, phone, globe for a browser. Devices never get a colour.
2. **Name line.** Name, read size 600 ("alex's Pixel 8", "Chrome on alex's Pixel 8"), ellipsis,
   then tags (the chip spec, tag variant): "This device" ("This Mac", "This phone" where known),
   and for a browser exactly one of "Trusted", "Untrusted", "Unknown build". "Update ready" when
   the box has a newer build for it.
3. **What it is.** Base size `--text-2`: kind and version ("Android app 0.14.2 · 0.14.3 waiting
   on the box", "Web app, paired through app.vyre.run · push on"). For a browser, its powers:
   "Trusted · full powers of your app" or "Browser · over the relay · limited: no vault secrets,
   can't add devices". Unknown build puts its warning here in `--text` instead.
4. **What it holds.** Meta size `--label`: "Holds a presence key (Face ID) · no vault session",
   "vault session open, 18 min left". The relay: "Holds nothing: it cannot read your data and
   keeps no keys". For a browser, the trust line: "Paired 2 h ago · build known · Expires after
   30 days unused", or "Trusted from alex's MacBook Pro 3 Sep · build known · Expires after 30
   days unused", or "Release 0.14.4 · not in this box's releases" (the release in mono).
5. **Path, right column.** Right-aligned, two lines: the status-mark dot then the path, meta size
   `--text-2` ("Tailscale · direct 12 ms", "Tailscale now · direct 18 ms", "Relay now · Tailscale
   when reachable"); under it, `--label`, the fallback and last seen ("Relay if it drops · seen 4
   min ago", "via fra 80 ms · seen 1 h ago", "Seen now"). The dot is `--focus` (bone) for a
   direct path and `--label` (grey) when relayed. Never amber or gold.
6. **More.** Icon button 28, "More" (Rename, Update, Remove) at the row's end on the desktop.

## Variants

- **The box, the Mac, a phone, the relay.** Rows as above; the relay says what it holds (nothing)
  and "In use by alex's Pixel 8".
- **Browser.** Adds trust: the tag, the powers line, the trust line, and one action on the right:
  - Untrusted: secondary "Trust this browser", 28, with "Touch ID follows" (meta, `--label`,
    92 wide) beside it.
  - Trusted: ghost "Stop trusting", with "One tap".
  - Unknown build: outline "Trust this browser" (never primary, never secondary), with "Touch ID
    follows".
  - Paired again: back to Untrusted, the trust line reads "Paired again 1 min ago · limited
    again" and "Was trusted from alex's MacBook Pro 14:22".

## Sizes

Desktop: padding 12 by 16, gap 12, tile 40, name 15/22, lines 13/18 and 12/16. Phone (pushed
Settings screen, Devices): padding 12 by 14, tile 32, name 17/24, lines 13/18 and 12/16; This
phone sits first on its own card with its path, so "why is it slow" has an answer. Actions are
44 tall on the phone.

## States

- **Selected** (desktop list): fill `--signal-wash`; meta steps up to `--text-2`. The detail
  shows Rename (outline), Update to 0.14.3 (secondary) and Remove.
- **Remove.** A hold button (outline in `--text`, fill tracks a 0.6 s hold, `--motion-hold`)
  labelled with the name: "Remove alex's Pixel 8", with "Hold 0.6 s · removal is immediate" and
  "Its presence key stops working and its sessions end the moment you let go. To bring it back,
  pair it again." No Undo, no proof.
- **Trust.** Tapping Trust asks Touch ID once (like pairing); while waiting the button keeps its
  width with a spinner and "Trusting". When the box confirms, the tag and lines change in place.
- **Stop trusting.** One tap, no proof, applied at once; the row drops to Untrusted.
- **Asked** (on the browser itself, after Ask to trust): its own card reads "Asked · waiting for
  your Mac" in place. The ask lands as a Device row in Needs you on trusted devices (see the
  needs-row spec).
- **Expired.** A browser unused for 30 days leaves the list; pairing again starts it Untrusted.
- **Offline or not connected.** Path reads "Not connected", the dot hollow (`--label` ring), last
  seen stays.
- **Viewer is untrusted.** No trust actions anywhere (the box refuses them from an untrusted
  browser); the page says "This browser is limited. Trust changes are made from your Mac or
  phone."
- **Loading.** Rows paint from cache first; latency and the relay to Tailscale switch update in
  place with no row jump.

## Keyboard and touch

Desktop: J and K move, Enter opens the detail, T trusts or stops trusting the focused browser
(proposed), the hold button takes Space held for 0.6 s. Phone: tap opens the device's page;
Remove lives there, never as a swipe.

## Copy

"Trust this browser", "Stop trusting", "Touch ID follows" (Face ID on a phone, fingerprint on
Android), "One tap", "Expires after 30 days unused", "Build known", "Unknown build", "This browser
runs a build Vyre doesn't recognise. Don't trust it unless you just updated." Never "Revoke" for
a relay device; never colour a device.

## Accessibility

Row is a group labelled by the name; the path dot has text beside it, so status is never colour
alone. The hold button announces "Hold to remove alex's Pixel 8" and its progress. The trust tag
is text, read with the name.

## Gaps

Deck (work/pwa)
- [ ] Devices lists only vault autofill browsers (`vault.devices`), not the relay devices from
      `relay.devices.list`; no path, holds or trust columns.
- [ ] Remove is a confirm button "Revoke" / "Revoke now", not a hold; no Rename.
- [ ] The relayed dot in `deck/js/health.js` is amber; use `--label`.

App (work/mobile)
- [ ] No holds line, no More, no Rename or Remove hold, no Update ready.
- [ ] Trust note reads "Presence follows"; name the proof ("Face ID follows").
- [ ] Trust tags draw as outline chips; use the tag (fill `--hover`, no border).
- [ ] No 40 tile and no right-hand path column: the path is a text line under the name.

Core
- [ ] `relay.devices.remove` and `relay.devices.trust` both ask for presence; Remove (a hold) and
      Stop trusting need no proof. Parked with relay; the summary should name the device, not
      its id ("Trust browser Chrome on alex's Pixel 8 fully").
