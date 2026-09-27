---
title: Chip
summary: Three small labels: the tag (a static fact), the filter chip (on or off) and the source chip (where a setting's value comes from).
audience: builders
owner: app-design
status: draft
---

# Chip

Small labels in three kinds. A **tag** states a fact on a row ("Claude", "orders", "Update
ready"). A **filter chip** narrows a list and toggles on and off ("All", "About you", "Harlow
Legal"). A **source chip** says where a setting's value comes from (Project, Account, Claude Code
file). Drawn on "Memory, phone and desktop", "Vault, phone and desktop", "Planner, phone and
desktop", "States, every list, every size" and "Settings · account and project scopes". The
session mode and provider chips are their own component (mode-chip).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.chip` `.tag` (main); `deck/views/settings-keys.js` source labels (work/native-core) | partial |
| App | inline badge in `apps/app/app/devices.tsx` (work/mobile) | partial |
| Capsule | inline in `local/capsule/native/Sources/UI/CapsuleView.swift`; `chipView` in `Extensions/sight/SessionPanel.swift` (work/capsule-pro) | partial |

## Anatomy

**Tag.** Inline flex, height 20, padding 0 6, radius `--radius-chip` (4), fill `--hover`, no
border, meta 12/16 weight 400, ink `--text-2`, no wrap. Optional 12 icon, gap 4.

**Filter chip.** Inline flex, height 28, padding 0 10, radius `--radius-full`, border 1 px
`--rule-strong`, fill none, base 13/18, ink `--text-2`, gap 6. Optional leading 12 icon or status
dot, optional trailing count in `--label` ("Logins 12").

**Source chip.** A tag with one of three words: "Project", "Account", or "Claude Code file". Fill
`--hover` for Project and Account; `--rule` for Claude Code file, which is read-only. It follows
the setting's value, before the control.

## Variants

| Kind | Interactive | Words |
|---|---|---|
| Tag | No | A kind, a label, a provider, a short state ("Update ready", "Recommended") |
| Filter chip | Yes, toggles | "All", a kind with its count, a project, a person |
| Source chip | Claude Code file only (opens the file) | Project, Account, Claude Code file |

The source chip shows **only when the value is not the default**. Project beats Account beats
the default. There is no "Default" chip and no "Not set" chip: a default value shows no chip.

## Sizes

| | Desktop | Phone |
|---|---|---|
| Tag | 20 | 20 (never a touch target) |
| Filter chip | 28 (`--control-xs`) | 36 visible, radius 18, 44 hit area |
| Source chip | 20 | 20; Claude Code file opens from the row, not the chip |

## States

Filter chip:
- **Off.** Border `--rule-strong`, ink `--text-2`.
- **Hover** (pointer). Fill `--hover`, ink `--text`.
- **On.** Border `--focus`, fill `--signal-wash`, ink `--text`; the count steps up to
  `--text-2`. Selection is lime, never violet.
- **Focus.** 2 px outline `--focus`, offset 2.
- **Disabled** (no items of that kind). Border `--rule`, ink `--label`; still visible, not
  clickable.
- **Loading.** Chips draw at once from cache; counts fill in without the chip changing width
  (reserve two digits).

Tags have no states. The source chip "Claude Code file" shows its path on hover or focus
(desktop) and an "Open file" action on the row.

## Keyboard and touch

- Filter chips are a group (`role="group"`, name "Filter"). Tab reaches the group; Left and Right
  move between chips; Space or Enter toggles. "All" turns the others off; turning every chip off
  selects All.
- Touch: tap toggles. Chips scroll sideways in one row on the phone (scroll-snap, no wrap), and
  the list keeps its scroll position under them.

## Motion

Fill, border and ink over `--motion-tap`. The list filters in one frame, from memory. Reduced
motion: instant.

## Copy

Sentence case, nouns: "All", "About you", "Logins 12", "Harlow Legal". Tags are one to three
words. Source chip words exactly "Project", "Account", "Claude Code file". Never upper case, never
mono, never a coloured tag.

## Accessibility

- Filter chip: a button with `aria-pressed`. Name includes the count ("Logins, 12").
- Tag and source chip: plain text; the source chip is read with its setting ("Mode, Plan first,
  from Project").
- `--text-2` on `--hover` passes AA in both themes; on `--signal-wash` ink is `--text`.

## Gaps

- [ ] Deck: `.chip` is 26 tall with radius `--r-1` and ink `--text`, no on state; use 28, round,
  `--text-2`, and `.chip-on`.
- [ ] Deck: `.tag` is mono 11 with a `--rule-strong` border; use sans 12 on a `--hover` fill.
- [ ] Deck (work/native-core): source labels include "Default" and "Not set"; show no chip for a
  default value, and add the "Claude Code file" chip.
- [ ] App: the devices badge is bordered with radius chip; no filter chips, no source chip.
- [ ] Capsule: chips are capsule-shaped with gold icons (`Theme.recall`); use the tag and filter
  shapes and neutral ink.
- [ ] System: the boards draw tags with radius 5; the token is `--radius-chip` (4).
