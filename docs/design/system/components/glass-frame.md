---
title: Glass frame
summary: The frame around an agent's live computer screen, with the Live badge, the take-over bar, the read-only banner and the idle warning chip.
audience: builders
owner: app-design
status: draft
---

# Glass frame

Glass shows an agent's computer live. The frame holds the screen, says it is live and how good the
link is, and carries the take-over states: who holds the keyboard, how long, and when it goes
back. Watching changes nothing; taking over asks for no proof. Drawn on "Agents and their
computers" and "Glass · take-over and hand-back states".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/glass/index.js`, `deck/glass/takeover.js`, `deck/glass/phone.js`, `deck/glass/glass.css` (main) | partial |
| App | none in `apps/app` (work/mobile) | not built |
| Capsule | not used ("glass kit" opens the Deck) | not used |

## Anatomy

1. **Frame.** Fill `--code-bg`, 1 px `--rule-strong`, radius 8, `overflow: hidden`, position
   relative. The screen draws to a canvas, never as images in the DOM, letterboxed to its
   resolution (1440 by 900 by default).
2. **Address bar**, 26 tall, padding 0 10, bottom 1 px `--rule`: the page address in mono 12
   `--label`, truncating from the end.
3. **Agent cursor.** A `--focus` pointer with a tag (meta size on `--hover`) naming the agent,
   shown while the agent acts.
4. **Live badge.** 22 tall, padding 0 8, radius 11, `--panel`, 1 px `--rule-strong`, 12/16 600
   `--text`: a 6 px `--focus` dot and "Live" (sentence case, like every label; the board draws "LIVE" and is superseded). Beside the frame on desktop, next to "Watching kit's
   screen. Nothing you do here reaches it until you take over." (13 `--text-2`); on the phone it
   overlays the frame 8 from the bottom right.
5. **Link pill** (same shape, 400): "direct · 30 fps" or "relayed · 5 fps", at the right of the
   phone's nav row.
6. **Take-over bar** (you hold the keyboard). Fill `--signal-wash`, inset 1 px `--focus`, radius
   12 on the phone (10 on desktop), padding 8 8 8 14, gap 10: the keyboard icon, "You have
   control" (17/600 phone, 13/600 desktop) and "from phone · 2:14" (13 `--text-2`; desktop shows
   the timer in mono 12). Phone: "Hand back" (outline, 44, fill `--panel`). Desktop: a note field
   (`--panel` fill, hint "Note for kit (optional)") and "Hand back to kit" primary with ⌃⏎.
7. **Read-only banner** (someone else holds it). `banner`: `--hover`, radius 10, min height 40:
   the icon, "Your phone has the keyboard · 2:14" 13/600, "kit is paused and this view is
   read-only." 12 `--text-2`. Take over is disabled with the tooltip "Your phone has control".
8. **Idle chip** (`role="status"`), last 10 s before the idle hand-back: padding 8 12, radius 10,
   1 px `--rule-strong`, `--panel`, clock icon, 13 `--text`: "Handing back to kit in 8 s. Type or
   move to keep control." It sits in the strip above the screen.
9. **Handed-back notice.** `banner` with "You handed back to kit (2m 14s). Your note is in its
   thread." and Dismiss (ghost, 28).

## Variants

- **Watch** (default, read only), **Take over** (the page's one primary, key T), **Sign in
  privately** (a shielded take-over: bar reads "Signing in privately" and "kit sees nothing ·
  0:41"; only here does "Fill a login" appear), **Files**.

## States

| State | Frame shows |
|---|---|
| Starting | the canvas keeps its last frame or `--code-bg`; spinner, "Starting kit's computer · 12 s", three check rows (Container up, Desktop and Chrome, Screen stream); Take over and Sign in privately disabled, title "Starting" |
| Failed to start | card with the crossed circle in `--text`, "Exited on boot · code 137", plain words, Limits, Restart (primary) and Stop (ghost) |
| Screens full | "Waiting for a screen · 30 s", then "Every screen is in use: kit (taken over by you), ledger (watched by 1)" and Try again |
| Watching | Live badge; Take over enabled |
| You hold it | take-over bar; the agent is paused |
| Another screen holds it | read-only banner; Take over disabled |
| Idle warning | idle chip; any typing, click or pointer move clears it |
| Agent paused by you | "kit is paused. Resume it before its hands can act." and Resume kit |
| Relayed | link pill "relayed · 5 fps"; frames drop, never freeze |

None of these is violet: nothing here needs you. Errors are neutral text and the failed glyph.

## Keyboard and touch

- Desktop: T takes over, ⌃⏎ hands back. Esc does not hand back.
- Phone: tap clicks, long press right-clicks, two fingers scroll, pinch zooms; "Keyboard" raises
  the keyboard. Hand back is a 44 button.
- Control returns on Hand back, after the idle time (Off, 2, 5 or 15 min; 5 by default), or when
  the screen stays hidden past the 90 s lease. The take-over follows the lease from laptop to
  phone.

## Motion

Every state swaps in the strip above the screen, so the screen never moves. The countdown ticks
only while the page is visible. Hand-back shows its notice on commit. Bars fade in over
`--motion-reveal` (150).

## Copy

- Owner copy says "your": "Your phone has control", "Your phone has the keyboard · 2:14". For
  another person, their name and surface: "Sam has control from phone".
- Thread lines say why it ended, never what was typed: "The keyboard went back to kit (2m 14s) ·
  note: …", "Handed back to kit after 5 min idle.", "Your take-over lapsed after 90 s without a
  signal (from phone)."
- Never "Remote control", "Session hijack", or a passkey prompt for take-over.

## Accessibility

- The canvas has `role="img"` and `aria-label="kit's screen, live"`; while you hold it, it becomes
  focusable and passes keys through.
- The take-over bar is a `group` named "You have control"; the idle chip is `aria-live="polite"`.
- A disabled Take over keeps its tooltip readable (`aria-describedby` on the reason).

## Gaps

Deck (main)
- [ ] The idle chip uses `--beacon-ink` text, border and `--beacon-wash`; spec is neutral.
- [ ] Read-only and hold banners use `--beacon-wash` (`.gl-banner`, `.gl-notice-hold`).
- [ ] Copy says "Someone has control from <surface>", not "Your phone has control".
- [ ] Error rows and messages tint violet (`.gl-msg-err`, `.gl-tr-err`, `.gl-danger`).
- [ ] Accent reads the raw `--signal` variable instead of `--focus`.

App (work/mobile)
- [ ] No Glass view.
