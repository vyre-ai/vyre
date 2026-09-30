---
title: Key hint
summary: The small boxed key chip that shows a keyboard shortcut next to what it does, on desktop only.
audience: builders
owner: app-design
status: draft
---

# Key hint

A small boxed key ("⌘K", "A", "⇧Tab", "Esc") that teaches the shortcut where it is used: in the
command bar, next to row actions, in popover headers, in Lumen's footer. Inside a button the
key is plain text, not this chip (see button). Drawn on most desktop boards, e.g. "Needs you,
phone and desktop", "Plan approval and modes" and "The Mac Lumen and the CLI".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.kbd` (main) | partial |
| App | none (work/mobile) | not built |
| Lumen | `local/capsule/native/Sources/UI/CapsuleView.swift` `KeyHint` `KeyCap` (work/capsule-pro) | partial |

## Anatomy

- Inline flex, centred, height 20, min width 20, padding 0 5.
- Border 1 px `--rule-strong`, radius `--radius-chip` (4), fill none.
- JetBrains Mono 12/16 weight 400, ink `--label`.
- **Hint line**: one or more chips then a meta word in `--label`, gap 6 between chip and word, 12
  between pairs: "⏎ send  Esc close", "J K move".

## Variants

- **Single key**: "A", "D", "R", "J", "Esc", "⏎".
- **Chord**: one chip, modifiers first, no plus sign: "⌘K", "⇧Tab", "⌘⏎", "⌥⏎", "⌃B".
- **Sequence**: one chip per press, gap 4: "Esc" "Esc", or "J" "K" for a pair of keys.

## Sizes

One size. The chip never scales with the text around it.

## States

- **Default.** Ink `--label`, border `--rule-strong`.
- **On a selected row or chip** (`--signal-wash`). Ink steps up to `--text-2` (label on a wash
  falls under 4.5:1).
- **Pressed** (proposed: while the key is down, where the app can tell). Fill `--hover`, ink
  `--text`, for `--motion-tap`.
- **Unavailable.** Not drawn. A hint is removed with its action, never greyed.

## Keyboard and touch

- Not interactive: never focusable, never a click target.
- Shown when the window is 720 or wider and the device has a keyboard and a fine pointer
  (`(any-hover: hover)` on the web). Never on the phone. On an iPad with a keyboard, shown.
- Glyphs on the Mac: ⌘ ⇧ ⌥ ⌃ ⏎ ⌫ ↑ ↓ ← →, and the words Esc, Tab, Space. Elsewhere the Deck
  prints Ctrl, Shift, Alt, Enter (proposed).

## Motion

None, except the proposed pressed flash.

## Copy

Keys as printed on the Mac keyboard. The word after a chip is a lower-case verb ("send", "move",
"close", "cycles", "take over"). Never "Press" before a key, never "+" in a chord, never ↵ (use
⏎).

## Accessibility

- `aria-hidden="true"` on the chip; the control it describes carries `aria-keyshortcuts`
  ("Meta+K", "Shift+Tab").
- `--label` on `--bg` and `--panel` passes AA at 12 in both themes; on washes it steps up as above.

## Gaps

- [ ] Deck: `.kbd` is mono 11 with padding 0 6 and radius `--r-1`; use 12/16, padding 0 5, min
  width 20, `--radius-chip`.
- [ ] Deck (work/pwa): ask hints read "⏎" and "esc" where the design keys are A and D; lower-case
  "esc" should be "Esc".
- [ ] App: no key hints; add them for iPad and web builds with a hardware keyboard.
- [ ] Lumen: `KeyCap` uses SF Rounded 10.5 semibold in `Theme.stone`, 17 square, filled
  `Theme.raised`; use JetBrains Mono 12, 20 tall, no fill, `Tokens` label ink.
- [ ] System: the "Settings · account and project scopes" board draws ↵; use ⏎.
