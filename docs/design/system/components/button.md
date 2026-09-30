---
title: Button
summary: The five buttons (primary, secondary, outline, ghost, hold), their four heights, busy and disabled states, and the key hint inside.
audience: builders
owner: app-design
status: draft
---

# Button

Five buttons, each with one job. One primary per surface. Destructive actions are slowed by words
and a hold, never by colour. Drawn on "Vyre one app, the system" (Five buttons) and used on every
board; hold on "Memory, phone and desktop", "Devices, network and VyreDrive", "Settings · account and
project scopes" and "Session · the composer, like Claude Code".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.btn` `.btn-primary` `.btn-ghost` `.btn-sm` (main); `deck/css/sheet.css` `.sb` `.sb-primary` (work/pwa) | partial |
| App | `apps/app/src/ui/Button.tsx` `Button` (work/mobile) | partial |
| Lumen | `local/capsule/native/Sources/UI/AgentDeskView.swift` `AgentButton` (work/capsule-pro) | partial |

## Anatomy

Inline flex, centred, gap `--space-3` (8), no wrap. Left to right:

1. **Icon** (optional), 16, leading. Replaced by the spinner when busy.
2. **Label**, weight 600, sentence case: verb first ("Allow once", "Send", "Start building").
3. **Key hint** (optional, desktop only): the key in meta 12/16 weight 400, `--label`; on primary
   `--primary-ink`. Plain text, no box (the boxed chip is key-hint, used outside buttons).

Border 1 px on every variant (transparent where none shows), so all five share one box.

## Variants

| Variant | Fill | Border | Ink | Job |
|---|---|---|---|---|
| Primary | `--primary-bg` | `--primary-bg` | `--primary-ink` | The one action on the surface. Bone on dark, ink on paper. |
| Secondary | `--hover` | `--hover` | `--text` | A common second choice ("Snooze 5 min", "Send test"). |
| Outline | none | `--rule-strong` | `--text` | A real alternative ("Always in Harlow Legal"). |
| Ghost | none | transparent | `--text` | Cancel, Deny, Discard, Details, Pause. |
| Hold | none, a `--hover` fill grows under the label | `--text` | `--text` | Destructive. |

**Hold.** The label names the count or the thing: "Delete 214 files", "Forget 3 memories",
"Remove alex's Pixel 8", "Reset 3 settings", "Discard the branch · 2 commits". Press and hold for
`--motion-hold` (0.6 s); a `--hover` fill grows from the left edge, linear, tracking the press.
Release early and the fill drains over `--motion-tap` and nothing happens. At full, the action
fires and the button goes busy ("Deleting"). Beside it, where there is room, meta `--label`
"hold 0.6 s". If the action has an undo, the undo toast follows (4 s); if not, the line says so
("removal is immediate"). A delete outside the box also asks Face ID or Touch ID unless a proof
from the last 30 min covers it.

**The safe choice is never primary.** On a destructive surface the hold button carries the action
and Cancel is ghost; there may be no primary at all. Never make Delete, Remove or Discard primary.

## Sizes

| Height | Token | Padding | Radius | Type | Where |
|---|---|---|---|---|---|
| 28 | `--control-xs` | 0 10 | `--radius-button` (8) | base 13/18 | Dense desktop rows, card footers |
| 32 | `--control-sm` | 0 12 | `--radius-button` (8) | base 13/18 | Desktop default |
| 44 | `--control-touch` | 0 16 | `--radius-button-touch` (10) | phone read 17/24 | Phone default |
| 54 | `--control-touch-lg` | 0 16 | `--radius-card` (12) | phone read 17/24 | Phone sheet actions, stacked, full width |

Touch targets are 44 minimum. On the phone, a card's actions stack full width at 54, primary on
top. Width is the content's, or 100% in a stack; never a fixed pixel width.

## States

- **Hover** (pointer only). Primary: fill and border `--primary-hover`. Secondary: `--rule`.
  Outline, ghost, hold: fill `--hover`.
- **Focus.** 2 px outline `--focus`, offset 2. Never removed.
- **Pressed.** Same as hover, applied on press on touch, over `--motion-tap`. No scale, no shadow.
- **Busy.** The button keeps its resting width (lock `min-width` to the measured width before the
  change). The spinner (14, 1.5 track, rotating arc) replaces the icon, and the label becomes the
  verb in progress: "Allowing", "Sending", "Saving", "Deleting". On primary the track is
  `--primary-hover` and the arc `--primary-ink`; elsewhere the track is `--rule-strong` and the
  arc `--text-2`. Not clickable, `aria-busy="true"`. Optimistic actions skip busy entirely.
- **Disabled.** Label ink on a quiet fill, never opacity alone. Primary: fill and border
  `--hover`, ink `--label`, key hint `--label`. Others: fill none, border `--rule` (hold and
  outline) or transparent (ghost), ink `--label`. Say why nearby in meta text ("Add a project
  first"), not only in a tooltip.
- **Offline.** Buttons stay enabled; the action queues in the outbox with the queued line.

## Keyboard and touch

- Enter and Space activate. The hint shows the row or card key (A, D, R, ⌘⏎), which works while
  the card has focus or is the selected row.
- Hold: keep Space or Enter down for 0.6 s; releasing early cancels. On touch, a press and hold;
  a quick tap does nothing except show the meta line "Hold to delete" for 2 s.
- Key hints never show under 720 or on touch-only devices.

## Motion

Colour changes over `--motion-tap` (120) with `--ease`. Hold fill is linear over `--motion-hold`.
Spinner 0.9 s per turn. Reduced motion: the spinner stops as a static arc, the hold fill still
tracks (it is feedback), colour changes are instant.

## Copy

Verb first, sentence case, the object when it helps ("Send to Harlow Legal"). The hold label
carries the count. Busy uses the same verb in -ing form. Never "OK", "Yes", "No", "Submit",
"Confirm", "Are you sure?", or capitals and mono in a label.

## Accessibility

- Role button, the label is the name; the key hint is `aria-hidden` and exposed as
  `aria-keyshortcuts`.
- Hold: `aria-description` "Hold for 0.6 seconds". VoiceOver and TalkBack pass a double-tap and
  hold straight through; switch and keyboard-only users hold Space (proposed: an accessibility action
  that asks once more in words).
- Primary ink on `--primary-bg` and `--label` on `--hover` (disabled) pass AA in both themes.

## Gaps

- [ ] Deck: `.btn` is JetBrains Mono 12, weight 500, upper case with letter spacing; use Instrument
  Sans 13/18 weight 600, sentence case.
- [ ] Deck: no secondary, outline (plain `.btn` is it but unnamed), hold or busy; disabled uses
  `opacity: 0.45` and primary disabled keeps the bone fill.
- [ ] Deck: `.btn-ghost` ink is `--text-2`; use `--text`. Radius uses the old `--r-2`.
- [ ] Deck (work/pwa): a second system, `.sb` (min 46) and `.sb-primary` (54, 17/22) with opacity
  disabled; fold into the one button at 44 and 54.
- [ ] App: `Button` has four variants at 44 and 32 only; add 28 and 54, hold, busy, leading icon
  and key hint; ghost ink is `text2`; screens roll their own buttons.
- [ ] Lumen: `AgentButton` primary is a `bone` (text) fill, radius 6, pressed at 0.8 opacity;
  use `Tokens` primary colours, `Radius.button`, the five variants and the states above.
