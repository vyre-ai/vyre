---
title: Stepper and checks
summary: The numbered stepper, the live check rows that turn bone in place, and the QR block used by Add your phone and first-run setup.
audience: builders
owner: app-design
status: draft
---

# Stepper and checks

Install and setup flows show every step at once, mark each as done, and prove the result with live
checks rather than a "Success!" screen. Add your phone pairs over the relay first (the QR), and
offers Tailscale only as the optional last step. Drawn on "Add your phone" (Install 1) and "First
run" (Onboarding).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/views/pair.js`, `deck/js/pair-steps.js`, `deck/css/pair.css` (work/pwa); `deck/js/phone-setup.js` and `deck/onboard/onboard.js` (main) | partial |
| App | `apps/app/app/pair.tsx` (work/mobile), a status line only | not built |
| Lumen | not used | not used |

## Anatomy

1. **Step marker**, 28 circle, 12/16 600. Todo: 1 px `--rule-strong` border, number in
   `--text-2`. Current: border `--focus` plus a 1 px `--focus` ring, number `--text`. Done: fill
   `--primary-bg`, a check in `--primary-ink`.
2. **Step text** beside it (gap 12): title 13/600, one line 12 `--label` ("Code used 14:31",
   "3 of 5, live", "Optional · Tailscale").
3. **Horizontal stepper** (a wide sheet): steps joined by 1 px `--rule` hairlines that grow to
   fill. **Vertical stepper** (the onboarding aside): one row per step, current in 600, todo in
   `--text-2`, a done step shows its answer at 12 `--label` on the right ("alex", "harlow").
4. **Check row**: min height 36, gap 10, top 1 px `--rule` (none on the first). Mark 18: ok is a
   `--primary-bg` circle with a `--primary-ink` check; waiting is an 18 circle with an inset
   1.5 px `--rule-strong`; running is the 14 spinner; failed is the crossed circle in `--text`.
   Label 15 (13 in onboarding), truncating; detail at the right 13 `--text-2` or mono 12.
5. **Checks card**: `card`, header with "4 · Checks" (12/600 `--label`) and "Live" with the
   running ring; heading 20/600 ("Checking alex's iPhone"); one line 13 `--text-2`.
6. **QR block**: 168 square, radius 12, padding 12, always `#FFFFFF` with black modules in both
   themes (the one fixed colour, for cameras). Beside it: the instruction 13 and one alternative
   12 `--label`. Under it the code in the current-code style of otp ("7KQM-4P2X", mono 28/600: the code's 8 characters in two groups of four, from ABCDEFGHJKMNPQRSTUVWXYZ23456789 with no 0, O, 1, I or L; single use, valid 10 min; typed case-insensitive, spaces and the hyphen ignored) and
   its status ("Used 14:31" with the ok mark).
7. **Optional path card** (`path`): 1 px `--rule`, radius 12, `--panel`, padding 16, gap 10;
   title 15/600 with a "Recommended" tag; body 12 `--text-2`; its own QR; "Skip for now"
   (outline 28) and "Add it later from Devices." 12 `--label`.
8. **Footer** (`card-f`): the presence line, Cancel (ghost), Done (primary, disabled until the
   required checks pass).

## Variants

- **Add your phone** (laptop sheet, Devices, key N): 1 Which phone (segmented iPhone, Android),
  2 Scan to pair (relay QR, single use, 10 min), 3 Install, 4 Checks, 5 Faster and private
  (optional). Done steps keep their codes on screen.
- **First run** (browser): six steps You, Claude Code, Tailscale, Your address, History, Devices,
  then Ready. One screen per step: "Step 2 of 6", one line of purpose, one primary, "Skip for now".

## States

| Check | Waiting | Running | Done | Failed |
|---|---|---|---|---|
| Phone reached the box | wait mark | spinner | "via relay 80 ms" | crossed circle, plain words, Retry |
| Secure address works (HTTPS) | | | mono "app.vyre.run" | |
| Opened as an app, not a browser tab | | | | |
| Sending a test notification… | | "4 s" | "Test notification arrived" | after 30 s: which part failed |
| Face ID key saved for approvals | "next" | | | |
| Switched to Tailscale · direct 18 ms | "Appears when Tailscale is reachable" | | bone when reached | stays waiting (optional) |

Finished: the ok mark, "alex's iPhone is ready", "5 of 5 checks passed. Push on · Face ID key
saved.", and "Switched to Tailscale · direct 18 ms, was relay 80 ms" when it switched.

## Keyboard and touch

Tab moves through the segmented choice, Skip for now, Cancel and Done; ⏎ runs the step's primary
("Connect ⏎"). Checks are not interactive until one fails, then Retry is a button. The phone-side
/pair page takes the code typed, capitals, dash optional.

## Motion

Checks stream in and morph wait to spinner to ok in place over `--motion-reveal` (150), with the
row height reserved so nothing jumps. The relay to Tailscale switch changes only the path line: no
reload, no prompt. Reduced motion: marks swap without the morph.

## Copy

- "Scan with the Camera app. It opens app.vyre.run/pair." "No Tailscale needed. Or open that
  page and type the code." "Single use, valid 10 min. Treat this code like a password." "The
  relay carries sealed traffic only; it never sees your data."
- "Faster and private" / "Add Tailscale" / "Optional. Vyre already works over the relay; Tailscale
  makes the path direct and keeps it on your own network."
- Presence line: "Touch ID confirmed · pairing allowed for 10 min". Pairing is the only proof.
- The terminal prints the same five steps in the same order (a proposed phone add command).
- Never "Success!", "Oops", or Tailscale as a requirement for the phone.

## Accessibility

- The stepper is an ordered list; the current step has `aria-current="step"`.
- Check rows sit in a polite live region; each change is announced once ("Phone reached the box,
  done").
- The QR has an `aria-label` naming its target ("QR code: app.vyre.run/pair, single use"), and the
  code beside it is the accessible alternative.

## Gaps

Deck (work/pwa, main)
- [ ] No laptop "Add your phone" sheet in Devices; no relay QR step and no optional Tailscale step.
- [x] Board: the Install boards drew a 6-character "7KQ-M4P"; they now draw "7KQM-4P2X" in the sheet and the terminal, matching the code (8 characters, XXXX-XXXX).
- [ ] `phone-setup.js` is a three-step card on Now (install, notifications, passkey), not the five live checks.

App (work/mobile)
- [ ] Pairing shows a status line only; no steps, checks or QR.
