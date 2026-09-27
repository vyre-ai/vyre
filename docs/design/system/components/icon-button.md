---
title: Icon button
summary: A square button holding one icon, for frequent actions whose meaning the icon carries (More, Back, Add, Dictate, Send).
audience: builders
owner: app-design
status: draft
---

# Icon button

A borderless square with one 16 icon, for actions people use often enough that a word is noise:
More, Back, Close, Add, Dictate, Send, Copy, Pause. Drawn on most boards: headers ("Projects,
phone and desktop"), the composer bar ("Session · the composer, like Claude Code"), steppers
("Project settings, Teammates and usage").

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.ibtn` (main) | built |
| App | none (work/mobile) | not built |
| Capsule | inline SwiftUI buttons with SF Symbols in `local/capsule/native/Sources/Extensions/sight/SessionPanel.swift`, `UI/CapsuleView.swift` (work/capsule-pro) | partial |

## Anatomy

- A square, no border, fill none, ink `--text-2`, one icon centred.
- The icon is 16 at every size (20 only in the rail, which is its own component).
- Always an accessible name; never a visible label.

## Variants

| Variant | Look | Where |
|---|---|---|
| Plain | As above | Headers, rows, composer bar, stepper ends |
| Toggle | `aria-pressed="true"`: fill `--hover`, ink `--text` | Pin, mute, show thinking |
| Filled round | 44 circle, fill `--hover`, ink `--text` | Phone "New agent", the Capsule's mic (40) |
| Send | Plain, fill `--hover`, ink `--text` when there is text; the primary colours only when it is the surface's one primary | Composer |

Only one icon button on a surface may take the primary colours, and only when no other primary
exists there.

## Sizes

| Size | Token | Radius | Where |
|---|---|---|---|
| 28 | `--control-xs` | `--radius-button` (8) | Composer bar, dense rows, desktop steppers |
| 32 | `--control-sm` | `--radius-button` (8) | Desktop default |
| 44 | `--control-touch` | `--radius-button-touch` (10), round for filled | Phone default, phone steppers, back |

On the phone every icon button is 44; a 28 or 32 drawing inside a row still gets a 44 hit area.

## States

- **Hover** (pointer). Fill `--hover`, ink `--text`.
- **Focus.** 2 px outline `--focus`, offset 2.
- **Pressed.** Fill `--hover`, ink `--text`, over `--motion-tap`.
- **Toggle on.** Fill `--hover`, ink `--text`; hover keeps it.
- **Disabled.** Ink `--label`, no hover, `aria-disabled="true"` (a stepper at its limit).
- **Busy.** The spinner (14) replaces the icon; the size never changes.

## Keyboard and touch

Tab to it; Enter or Space activates. Toggles announce their state. The desktop tooltip shows the
name and the key, if any, after 500 ms of hover (proposed). No long-press menus on icon buttons,
except Send, where a long press queues for after the turn (the composer's ⌥⏎).

## Motion

Fill and ink over `--motion-tap` with `--ease`. Reduced motion: instant.

## Copy

`aria-label` in sentence case, verb first where it is an action: "More", "Back", "Close", "New
session", "New agent", "Dictate", "Send", "Copy code", "Pause", "One fewer teammate", "One more
teammate". Never an icon button for a destructive action; use the hold button.

## Accessibility

- Role button with `aria-label`; toggles add `aria-pressed`. Native: `accessibilityRole="button"`
  plus `accessibilityLabel`; SwiftUI `.accessibilityLabel`.
- Icon ink `--text-2` on `--bg` and `--panel` holds 3:1 in both themes; `--label` is only for
  disabled.

## Gaps

- [ ] Deck: `.ibtn` radius uses the old `--r-2`; switch to `--radius-button`. No 44 size, no
  filled round variant, no busy.
- [ ] App: no icon button; screens use `Pressable` with text. Build `IconButton` with 44 default
  and the icon component.
- [ ] Capsule: close and mic buttons are SF Symbols at 11 to 13 pt with no hover fill or focus
  ring; draw the set's icons in a 28 square with `Tokens` colours.
