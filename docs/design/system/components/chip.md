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
Legal") or grants a surface on the Connections card. A **source chip** says where a setting's
value comes from (Project, Account, Claude Code file). Drawn on "Memory, phone and desktop",
"Vault, phone and desktop", "Planner, phone and desktop", "States, every list, every size",
"Settings · account and project scopes" and the Connections board. The session mode and provider
chips are their own component (mode-chip).

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
| Filter chip | Yes, toggles | "All", a kind with its count, a project, a person, a surface |
| Source chip | Claude Code file only (opens the file) | Project, Account, Claude Code file |

**A surface grant** (the Connections card, card.md) is a filter chip, not a new kind: one chip per
surface the connection can be used from: Capsule, Chat, Agents, Phone, the vault's real surfaces,
never a made-up list. Leading icon the surface's own glyph, On meaning granted and Off meaning
not. This is the one place a filter chip's state is not a view filter but a real write.

Revoking (On to Off) is always one tap: no confirm, no proof, the same bar draft-card.md sets for
an in-place field edit. Granting (Off to On) is one tap too, except Agents: handing a credential
to an autonomous session is a vault write (the no-nag rule's own line: presence for vault
secrets, pairing and send/post/pay), so the Agents chip asks for Touch ID or a passkey before it
turns on, the same proof credential-sheet.md's Connect step uses. While a grant to Capsule, Chat
or Phone can still be seen turning on, the chip shows the undo toast (toast.md, 4 s) instead of
an in-place undo, since a grant is consequential enough to want the "Undo" word on screen, not
just "tap it again". A refused proof leaves the Agents chip Off with no error, nothing granted.

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
- **Asking** (the Agents grant chip only, Off to On). The system Touch ID or Face ID prompt shows
  at once on tap; the chip does not change state until it resolves. Confirmed: On, with the undo
  toast. Refused: stays Off, nothing shown but the system's own cancel.

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
  Confirmed live in chat's session header (`.cv-project`, `deck/chat/chat.css`): the thread's
  project ("harlow-legal") is correctly a Tag, not a new kind — it just inherits this gap.
- [ ] Deck (work/native-core): source labels include "Default" and "Not set"; show no chip for a
  default value, and add the "Claude Code file" chip.
- [ ] App: the devices badge is bordered with radius chip; no filter chips, no source chip.
- [ ] Capsule: chips are capsule-shaped with gold icons (`Theme.recall`); use the tag and filter
  shapes and neutral ink.
- [ ] System: the boards draw tags with radius 5; the token is `--radius-chip` (4).

native-core
- [ ] The Connections card's grant chips are not built; toggling one needs `vault.connections.update
      {id, grants}` or equivalent (vault's call to name). See card.md's Connections card.
