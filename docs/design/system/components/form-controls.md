---
title: Form controls
summary: Field, textarea, select, toggle, segmented control, stepper, checkbox, radio and search field, at desktop and touch sizes.
audience: builders
owner: app-design
status: draft
---

# Form controls

The nine input controls. Settings, the planner's quick add, the vault editor, question cards and
list searches all build from these. Drawn on "Settings · account and project scopes", "Places,
Settings", "Project settings, Teammates and usage", "Planner, phone and desktop" and "Session ·
the composer, like Claude Code".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.input` `.sw` `.seg` `.search` (main); `deck/chat/chat.css` `.cv-chk` `.cv-radio` (work/chat) | partial |
| App | the text input in `apps/app/src/session/Composer.tsx` only (work/mobile) | partial |
| Capsule | SwiftUI `TextField` and `TextEditor` in `local/capsule/native/Sources/UI/CapsuleView.swift`, `UI/AgentDeskView.swift` (work/capsule-pro) | partial |

## Anatomy

**Field wrapper.** Column, gap 6: label (meta 12/16 weight 600, `--text-2`), the control, help
(meta 12/16, `--label`). The help line's slot is reserved, so an error never moves the form.

**Field (input).** Height 32, padding 0 10, radius `--radius-field` (8), border 1 px
`--rule-strong`, fill `--bg`, base 13/18 `--text`, placeholder `--label`. Optional leading 16 icon
(`--label`) and trailing icon button, gap 8. Large: height 40, padding 0 12, read 15/22 (the
planner's quick add). Codes, keys and paths inside use JetBrains Mono.

**Textarea.** Padding 10 12, radius `--radius-field`, border and fill as field, read 15/22. Grows
with content to 8 lines, then scrolls inside.

**Select.** A field with the value and a trailing 12 chev-d, fill `--panel`. Opens a popover menu
on desktop and a sheet on the phone; never the browser's native menu on desktop.

**Toggle.** Track 32 x 18, radius 9; knob 14, inset 2. Off: track `--rule-strong`, knob `--text`.
On: track `--primary-bg`, knob `--primary-ink`, moved 14.

**Segmented control.** Container fill `--hover`, padding 2, gap 2, radius 8. Segments height 28,
padding 0 12, radius 6, base 13/18, `--text-2`. On: fill `--panel`, ink `--text`, weight 600, a
1 px `--rule-strong` ring. Two to four segments; five or more is a select.

**Stepper.** Fill `--hover`, radius `--radius-button-touch` (10): minus icon button, the value
(centred, fixed width for three digits), plus icon button. Desktop uses 28 icon buttons around a
base 13/18 value.

**Checkbox.** 16 square, radius 4, 1.5 inset `--rule-strong`. On: fill `--text`, a 12 check in
`--bg`. Mixed: fill `--text`, a 12 minus in `--bg`.

**Radio.** 16 circle, 1.5 inset `--rule-strong`. On: ring `--focus`, an 8 dot `--focus`.

**Search field.** A field with the 16 search icon leading (`--label`) and, once there is text, a
28 x icon button trailing. Placeholder names what it finds: "Find a setting", "Search projects".

## Sizes

| Control | Desktop | Phone |
|---|---|---|
| Field, select, search | 32 (40 large) | 44, radius 10, read 17/24 (no zoom on focus) |
| Textarea | read 15/22 | read 17/24 |
| Toggle | 32 x 18 | 48 x 27, knob 21, in a 44 row |
| Segmented | 28 segments, 32 overall | padding 3, gap 3, radius 10, 38 segments, radius 8, read 17/24, 44 overall |
| Stepper | 28 buttons | 44 tall, 44 buttons, value read 17/24 36 wide |
| Checkbox, radio | 16 | 16 drawn; the whole row (min 44) is the target |

No input text under 16 px on the phone.

## States

- **Hover** (pointer). Field border `--text-2`; segment ink `--text`; checkbox and radio ring
  `--text-2`.
- **Focus.** Field: border `--focus` plus a 1 px `--focus` ring, no offset outline. Toggle,
  segment, checkbox, radio, stepper buttons: 2 px outline `--focus`, offset 2.
- **Disabled.** Ink and placeholder `--label`, border `--rule`, fill unchanged; a toggle's track
  `--rule`, knob `--label`. Help says why ("Kept per account only").
- **Read-only** (a Claude Code file value). No border, fill `--hover`, ink `--text-2`, the source
  chip beside it.
- **Error.** Border stays `--rule-strong`; the help slot shows the failed icon (12) and the reason
  in `--text-2` ("Not saved. The box refused 0 as a limit."). No red, no violet.
- **Saved.** Optimistic: the control changes on the tap; "Saved" with a 12 check shows in the
  reserved slot for 2 s. If the box refuses, the control flips back and the slot reads "Not
  saved".
- **Offline.** Changes queue through the outbox and replay; the slot reads "Queued".
- **Stepper at a limit.** That button's ink `--label`, `aria-disabled="true"`.

## Keyboard and touch

- Tab order follows reading order. Enter in a field submits its form; Esc in a search clears it,
  a second Esc leaves.
- Toggle and checkbox: Space. Radio and segmented: arrow keys move and select (roving tabindex).
- Select: Enter or Space opens; ↑ ↓ move; ⏎ picks; Esc closes. Typing jumps to a match.
- Stepper: ↑ ↓ on the value, or the buttons; a held button repeats every 120 ms after 400 ms.
- Touch: every control's hit target is 44; toggling a settings row anywhere toggles it.

## Motion

Toggle knob and segment fill over `--motion-tap` with `--ease`. Saved line fades in over
`--motion-reveal`. Reduced motion: instant.

## Copy

Labels are nouns in sentence case ("Quiet hours", "Mode"). Help is one plain line. Placeholders
are examples or verbs, never the label repeated. Never "Invalid input", "Error:", or an
exclamation mark.

## Accessibility

- Every control has a visible label or an `aria-label`; help and error link by
  `aria-describedby`.
- Roles: toggle `switch` with `aria-checked`; segmented `radiogroup` (tabs use tablist, see tabs);
  stepper `spinbutton` with min, max and value; search `searchbox`.
- Placeholder `--label` on `--bg` passes AA at 13; the on toggle `--primary-ink` on
  `--primary-bg` passes in both themes.

## Gaps

- [ ] Deck: `.input` is 40 tall on `--panel` with a 15 size; use 32 on `--bg` at 13 (40 is the
  large field). Focus has no ring.
- [ ] Deck: the toggle `.sw` is 34 x 20 with an on track of `--text`; use 32 x 18 and
  `--primary-bg`.
- [ ] Deck: `.seg` has a `--rule` border and 26 segments with `aria-pressed`; use the `--hover`
  container, 28 segments and radiogroup semantics.
- [ ] Deck: no stepper or select component (native `select.input` in settings); two checkboxes
  (`.cv-chk` on is lime, the design is `--text`).
- [ ] Deck: `.search` is 420 wide on `--panel` with a `--rule` border; use the field.
- [ ] App: only the composer's text input exists (16 px); build the other eight at touch sizes.
- [ ] Capsule: system `TextField` and `TextEditor` styling; no toggles, segments or steppers.
- [ ] System: the stepper is drawn twice (a `--hover` fill in Settings, a `--rule-strong` outline
  in Project settings); this spec takes the fill.
