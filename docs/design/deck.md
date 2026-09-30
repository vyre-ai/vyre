---
title: Deck design
summary: The Deck's visual system and screen patterns, Direction B second pass, picked on 27 Sep 2026.
audience: builders
owner: docs
status: draft
---

# Deck design (Direction B, second pass)

The Deck's visual system and screen patterns, picked by the user on 27 Sep 2026: B's look (icon
rail, command bar, cards), built for daily use. The mockups are in
`docs/design/deck-directions/` (one `.dc.html` per screen, dark and paper; `vyre.css` holds every
shared part). Colours live in `core/config/palette.js`; its test checks every pair for WCAG AA.

## Type

Two families. Instrument Sans for everything; JetBrains Mono only for commands, code, file paths,
IDs and keys. Names, emails and times are sans (with tabular numbers).

| Step | Size / line | Use |
|---|---|---|
| 28 | 28/34 | Spec sheets and first-run heroes. Rare. |
| 20 | 20/26 | Page greeting, detail and sheet titles |
| 15 | 15/22 | Messages, prose, card titles (600) |
| 13 | 13/18 | The default: rows, buttons, fields, top bar |
| 12 | 12/16 | Labels, meta, counts, shortcuts, rail labels |

Two weights: 400 to read, 600 for names, titles, labels and buttons. Section labels are 12/600
sentence case in `label`; no mono caps anywhere. Mono uses 12 or 13.

Phone: +2 on the 15 and 20 steps only (17 and 22), for iOS body size and no zoom on focus. 12, 13
and 28 are shared.

## Colour

Eight neutrals per theme, one accent, one attention colour. Nothing else: no gold, no red, no
honey, no coral.

| Role | Dark | Paper |
|---|---|---|
| bg | #0E0D0C | #F4F1EA |
| panel | #161513 | #FBFAF6 |
| hover | #1E1C1A | #EEEAE2 |
| rule | #2B2926 | #DCD7CC |
| rule-strong | #3A3733 | #C9C3B7 |
| text | #F1EEE6 | #141311 |
| text-2 | #B3AEA4 | #4A463F |
| label | #8C877D | #6B665D |
| primary-bg / primary-hover | #F1EEE6 / #FFFFFF | #141311 / #4A463F |
| primary-ink | #0E0D0C | #F4F1EA |
| focus | #F1EEE6 | #141311 |
| signal-wash | rgba(241,238,230,0.12) | rgba(20,19,17,0.10) |
| del-wash (neutral) | rgba(140,135,125,0.14) | rgba(107,102,93,0.10) |
| beacon-ink = beacon-dot (violet) | #B8A4FF | #5B3FC4 |
| alternative attention (teal) | #5FD4C4 | #0B6E66 |

- Paper `hover` changed from #FBFAF6 (the same as `panel`, so a hovered row on a card did not
  change) to #EEEAE2.
- `beacon-wash` and `beacon-rule` are gone. The count on a badge is `primary-ink` on `beacon-dot`
  in both themes (9.1:1 dark, 6.3:1 paper); no separate badge ink is needed.
- Code blocks: `code-bg` #121110 dark, #F0EDE5 paper.
- Bone is the primary button, the focus ring, running and a selected row. Violet means "needs
  you" and appears only as a dot, a label or a count badge, never as a card fill, border or
  wash. Memory, success, info and errors are neutral text plus an icon.
- Meta text on any wash steps up from `label` to `text-2`.

## Placement

- The rail (72px) is icons with 12px labels; the current page is a `hover` fill and 600. Now
  carries the needs-you badge.
- The top bar (56px) is three columns: page title (and breadcrumb or count) left, the command bar
  (⌘K) in the middle, then "N need you" and the page's one primary action at the right end, with
  its key (N). Now has no top-bar primary (its composer is the primary). Settings has none (changes
  save as you go, and the bar says so).
- Pages do not repeat a big title under the top bar.
- Inside a card or sheet the actions sit in a footer: primary first, then secondary; Cancel,
  Deny or Discard as a ghost button pushed right. One primary per surface.
- Create flows open in place (inline row on Projects) or as a right sheet over the list (Agents,
  Vault), so the list stays in view.

## Components

- Cards are `panel` plus a 1px `rule`, radius 12, no shadow. No box inside a box, except code.
  Only overlays (sheets, the ⌘K palette) have a shadow.
- Lists: 44px rows (36 in compact), title plus one meta line, a 32px column header when there are
  columns. Hover is `hover`, selected is `signal-wash`, keyboard focus is a 2px `focus` ring inset.
- Buttons: sentence case, 13/600, 32px (28 small), radius 8. Primary, outline and ghost. Disabled
  is `label` on a quiet fill. Working keeps its width and shows a spinner and a verb ("Allowing").
- Held items and questions are neutral cards: header with the violet dot and a label
  ("Permission", "Draft to send", "Question") and the agent and time on the right; the command in
  a code block; the reason in text-2. Gate buttons: Allow once (A), Always in <project>, Deny (D).
- Drafts edit in place: each field is a line you click to change (`df` rows). Only Send (⌘⏎) and
  Discard (D). No Edit button.
- After a held item is decided it goes neutral: "Allowed once by you · 14:22", "Denied by you",
  "Expired after 24 h" with Ask again.

## States (the States board)

Every list and page shows: loading as skeleton rows shaped like the rows they replace (never a
blank page; after 10 s the line says the box is slow and offers Cancel); empty with the first
action inline (a name field and Create); an error in place with plain words, the detail in mono
and a way out (Retry, Open doctor); offline as a banner that says what waits and when it retries;
many items with a count, filter chips, sticky group headers and "Load 40 more", badges cap at
99+; long names truncate with an ellipsis and carry the full name in `title`.

## Keyboard

| Key | Action |
|---|---|
| ⌘K | Jump to anything, run a command |
| N | The page's primary action |
| J / K | Next and previous item |
| ⏎ | Open |
| A | Allow once |
| D | Deny or discard |
| ⌘⏎ | Send, save, create |
| / | Filter this list |
| Esc | Close, cancel, stop editing |

Buttons show their key inside them; a list shows a one-line key hint above or below it.

## For the build

- deck.css still has coral and the old roles. The one-commit attention swap (after the user
  confirms violet) moves it onto `core/config/palette.js` and drops the `todo` on the deck.css
  test in `core/config/palette.test.js`.
- The render audit (`docs/design/deck-directions/render/render.sh`) now also fails any text off
  the five sizes, off the two weights or families, and any colour not in the palette.
