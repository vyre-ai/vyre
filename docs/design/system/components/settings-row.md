---
title: Settings row
summary: One setting as a row with its label, description, control, where its value comes from, a reset that names where it goes back to, and when the change applies.
audience: builders
owner: app-design
status: draft
---

# Settings row

One setting from the registry, drawn the same way for every key: what it is, its control, where
its value comes from and when a change applies. It saves as you go; there is no Save button
anywhere. Drawn on the boards "Settings · account and project scopes" and "Places, Settings".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/views/settings-keys.js`, `deck/css/views/settings-keys.css` (work/native-core) | built |
| App | `apps/app/app/settings.tsx` (work/mobile): navigation rows only | not built |
| Capsule | not used | |

## Anatomy

Desktop is a three-column grid: text `minmax(0, 1fr)`, a reserved slot 214, the control 168;
gap 12, padding 8 by 16, min height 56.

1. **Label.** Base size, `--text`, one line with ellipsis.
2. **Source chip** beside the label, only when the value is not the default: "Project", "Account"
   or "Claude Code file" (see the chip spec, source variant: 20 tall, radius `--radius-chip`,
   fill `--hover`, meta size `--text-2`; "Claude Code file" on `--rule`). Project beats Account
   beats Default. "Default" is never printed.
3. **Description line.** Meta size, `--label`: what it does or its current value in words
   ("Shift+Tab changes one session", "None beyond the project"). Rule values and paths in mono
   (`Bash(npm test:*)`, `harlow-legal/.claude/settings.json`).
4. **Apply hint**, at the end of the description line, meta size `--label` with a 12 icon: "Next
   session" (clock) or "After restart" (refresh). A change that applies now prints nothing.
5. **Reserved slot.** Holds one of: the reset ghost, "Saved", or the reset line with Undo. It is
   always laid out, empty or not, so nothing shifts when one appears.
6. **Control.** By type: toggle for a boolean, segmented for up to 4 choices, select for more, a
   field for text and numbers, a stepper for small counts (phone), chips with Add for a list.
   Desktop controls are 32 tall (`--control-sm`).

A "Claude Code file" row is read-only: the slot shows the key in mono (`permissions.deny`) and "·
3 rules", and the control column is an outline button "Open file" (16 file icon). The full path
shows on hover.

## Sizes

| | Desktop | Phone (under 720) |
|---|---|---|
| Label | 13/18 | 17/24 |
| Description, hint | 12/16 | 13/18 |
| Control height | 32 | 44 (`--control-touch`); toggle drawn at 1.5 scale in a 72 by 44 box |
| Layout | one line, three columns | label and control on one line, the reserved line (44) under them |
| Reset | ghost `--control-xs` 28, shown on hover or focus | ghost 44, always shown when the row holds a value |

## States

- **Default.** No chip, no slot content.
- **Overridden.** Source chip; the reset ghost shows on hover or focus (always on touch).
- **Hover** (desktop). Row fill `--hover`.
- **Focus.** 2 px `--focus` outline inset on the row; the reset ghost shows.
- **Saved.** On the frame of the change the control shows the new value (optimistic), and the
  slot reads a 12 check and "Saved" in `--text-2` for 2 s.
- **Just reset.** The slot reads "Reset to Account" (meta, `--text-2`) and a ghost "Undo" for
  `--motion-undo` (4 s). No confirm.
- **Not saved.** The box refused: the control flips back and the description line reads "Not
  saved" and the reason in `--text`, with the failed mark. No red.
- **Unavailable here.** A key kept per account shown in Project scope (or the other way round):
  label and control in `--label`, control disabled, the line reads "Set for your account only"
  or "Set per project only". Its module off: "Its module is off".
- **Disabled** controls use `--label` ink on a quiet fill, never opacity alone.
- **Loading.** Skeleton at the row's height; controls disabled until values land.

## Restart banner

Changes that apply "After restart" from any group collect in one banner at the top of the
detail (see the banner spec): refresh icon, "2 changes apply after restart" (600), then the names,
the scope and the cost in meta ("Lock after idle, Terminals open at once · your account ·
sessions reconnect in about 5 s"), and an outline "Restart now" at 28. It stays until the restart.

## Keyboard and touch

Desktop: J and K move between rows, / focuses "Find a setting", R resets the focused row, Space
toggles a focused toggle, Enter commits a field (fields also save on blur, 400 ms after the last
of them). A whole group resets with a hold button "Reset 3 settings" (0.6 s, see the button spec).
Phone: every control and the reset line are 44 targets.

## Motion

Slot content swaps in place with a `--motion-tap` fade; the toggle knob slides over 160. Nothing
changes height. Search filters in memory in one frame.

## Copy

- Reset names where it goes: "Reset to Account (Asks first)", "Reset to Account", "Reset to
  default", "Reset to default (no limit)", "Reset to default (no cap)". Never a bare "Reset".
- Hints: "Next session", "After restart". Never print "Applies now", "Applied", "From the next
  session" or "Restart vyred to apply".
- Page subtitle: "Saved as you go". Scope footnote: "Harlow Legal's values save to
  `.claude/settings.local.json` in the project. The committed `.claude/settings.json` is
  read-only here."

## Accessibility

The label is the control's accessible name (`label for`, or `aria-labelledby` on a segmented
group). The source chip and apply hint are part of the description (`aria-describedby`). The slot
is a polite live region, so "Saved", "Reset to Account" and "Not saved" are announced. Reset's
accessible name is its full text.

## Gaps

Deck (work/native-core)
- [ ] The source chip is always shown, including "Default" and "Not set"; show it only when
      the value is not the default, and drop "Not set".
- [ ] "Claude Code file" is a second chip on every Claude-owned key, beside the source; it should
      be the source itself, with the row read-only and Open file.
- [ ] Reset is a bare "Reset" that does not name its target; no Undo after a reset.
- [ ] Apply hint is printed after a save as "Applied", "From the next session", "Restart vyred
      to apply"; use the resting hints "Next session" and "After restart" and print nothing for
      live keys.
- [ ] No "Saved", no reserved slot (meta and note lines grow the row), no restart banner.
- [ ] The key id is printed under every label in mono; show it only in search results.
- [ ] Refusals print the raw error; use "Not saved" with the failed mark.

App (work/mobile)
- [ ] No settings rows: build the phone layout above (44 controls, reserved line, stepper).
