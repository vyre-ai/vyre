---
title: Authenticator code
summary: A one-time code with the current value large, the next value small and a ring that counts down the 30 s window.
audience: builders
owner: app-design
status: draft
---

# Authenticator code

Shows a login's one-time code so a code about to roll over is never a guess: the current code
large, the next one small under it, and a ring counting down. Appears on a vault login's detail
(desktop), in the phone's Codes list, and in the pairing code of Add your phone (the same mono
style, no ring). Drawn on "Vault" and "Add your phone".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/views/vault-item.js`, `deck/css/views/vault.css` (main) | partial |
| App | none in `apps/app` (work/mobile) | not built |
| Capsule | none ("code northwind" is a typed command, not drawn) | not built |

## Anatomy

1. **Label** (desktop card only): "Authenticator", 12/16 600 `--label`.
2. **Current code.** JetBrains Mono, hero size 28/34, 600, `--text`, `letter-spacing: 0.04em`,
   `font-variant-numeric: normal`. Six digits as two groups of three with one space: "482 913".
3. **Next code.** Mono 12/16 `--label`: "next 031 775".
4. **Ring.** SVG, viewBox 22, radius 9, stroke 2.5: track `--rule-strong`, arc `--focus` with a
   round cap, starting at 12 o'clock and emptying clockwise over the period (30 s). Drawn 32 on
   desktop, 28 on the phone. Under it, the seconds left at 12/16 `--text-2`: "18 s".
5. **Copy.** Desktop: a secondary button "Copy code" with the copy icon. Phone: the whole row
   copies on tap.

Desktop layout: label, current and next stacked on the left; ring and seconds centred in a column
(gap 4); Copy code at the right. Phone row (padding 12 14): account tile 32, then a column of the
account name (13 `--text-2`, truncating), the current code and the next line; the ring column at
the right (gap 2).

## States

| State | Look |
|---|---|
| Counting | ring arc shrinks; seconds tick; nothing changes colour, ever, even under 5 s |
| Rollover | the next code moves up to current in place; the next line shows the new next; no layout shift (mono, fixed width) |
| Copied | row fill `--signal-wash`; the next line becomes a 12 px check and "Copied · clears in 30 s" at `--text-2` |
| Locked | code and ring replaced by the lock pill "Locked · Face ID to open" (proposed; the board draws only unlocked) |
| Unlocked | the vault's pill reads "Unlocked · 24 min left"; use does not extend it |
| Offline | still counts: codes are computed on the device from the secret cached while unlocked |

## Keyboard and touch

- Desktop: the Copy code button, or ⌘C with the code focused.
- Phone: tap anywhere on the row copies; the whole row is the target (min 44 tall, 72 as drawn).
- The clipboard clears itself after 30 s and the row says so.

## Motion

The ring animates on the compositor: one linear `stroke-dashoffset` transition across the seconds
left, restarted at each period, never a per-second redraw. The copied wash fades out over
`--motion-reveal` (150) when it clears. Reduced motion: the ring steps once a second.

## Copy

- "Authenticator", "next 031 775", "18 s", "Copy code", "Copied · clears in 30 s",
  "Tap a code to copy", "Locked · Face ID to open", "Unlocked · 24 min left".
- Seconds always with a space: "18 s", never "18s". Never "OTP", "TOTP" or "2FA code" in the UI.
- Pairing code (Add your phone) uses the same current-code style, but 8 characters in two groups of
  four joined by a hyphen ("7KQM-4P2X", alphabet ABCDEFGHJKMNPQRSTUVWXYZ23456789, no 0, O, 1, I or L),
  never wrapping, with its own status: "Used 14:31",
  and "Single use, valid 10 min. Treat this code like a password."

## Accessibility

- The code has `aria-label` reading digit by digit: "Code 4 8 2 9 1 3". The ring is
  `aria-hidden`; the seconds are available but not live (no announcement every second).
- "Copied" is announced once through a polite live region.
- Mono 28/600 `--text` on `--panel` passes easily; `--label` next code passes 4.5:1 at 12.

## Gaps

Deck (main)
- [ ] No next code; the code sits in a field row labelled "Code", not "Authenticator".
- [ ] Ring is 20 px, and seconds render "18s" without the space.
- [ ] Codes come from the box each period, not computed on the device, so offline shows nothing.
- [ ] Copy is an icon button with the tooltip "This vyred has no vault.copy yet" when missing.
- [ ] No phone Codes list with tap-to-copy rows.

App (work/mobile)
- [ ] No vault codes.
