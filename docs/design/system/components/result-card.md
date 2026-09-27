---
title: Command result card
summary: How a vyre command's result {view, title, rows or text, actions} renders natively in the Capsule, chat and the Deck. Three views (table, text, card), a row cap with Show all, mono only for code and paths, actions as ghost buttons with keys, copy as text, and errors. Also the Answer variant memory.ask draws in Find and the Memory view, with correct-in-place.
audience: builders
owner: app-design
status: draft
---

# Command result card

A `vyre` command run from the Capsule, a chat slash command or the Deck returns a result, not
terminal text: `{view: "table" | "text" | "card", title, rows | text, actions?}` (platform's
commands field, ADR 0033; polish-cli's `--view` frames; cohesion's item 6). A surface asks for it
with `render: true` and draws it with this card. It is a card (card.md) holding list rows
(list-row.md) or a plain text body, with ghost buttons (button.md) and key hints (key-hint.md); it
adds no new part. The CLI prints the same result as text. Not drawn on a board yet (see Gaps).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | the chat transcript, as a tool row's body (`deck/chat/core/tool-detail.js`, work/chat); ⌘K Run results (`deck/views/find.js`, work/pwa) | not built |
| App | the chat-core transcript (work/mobile) | not built |
| Capsule | the result area under the input (`local/capsule/native/Sources/UI/CapsuleView.swift`, work/capsule-pro) | not built |

## Anatomy

A content card: `--panel`, 1 px `--rule`, radius `--radius-card` (12; phone 10).

1. **Header**, 44, padding 0 16: the terminal icon 16 `--text-2`, the title 12/16 600 `--label`
   in sentence case ("Devices", "Voice", "Connected accounts"), and on the right the command in
   mono 12 `--label` (`vyre devices`) with a copy icon button xs. <!-- terms: ignore -->
2. **Body**, by view (below).
3. **Footer** (when there are actions or more rows), padding 12 16, `--rule` top: the actions as
   ghost buttons xs (28; 44 on touch), each with its key hint, then "Show all 23" (ghost) pushed
   right when rows were cut.

## Variants

**Table.** Rows as list rows, dense on the desktop (36), 44 on the phone and in the Capsule:

- The first column is the row's title (base `--text`); the second is its meta (12/16 `--label`);
  further columns join the meta with " · ". A column named `status` draws a status mark before the
  title with its word in the meta (status-mark.md), never a coloured word.
- On the desktop and in the Deck, a table of 3 or more columns may draw as columns: header row
  12/16 600 `--label`, 32 tall; cells 13/18, left aligned, numbers right aligned with tabular
  figures; `--rule` between rows. On the phone and in the Capsule it is always rows.
- At most 8 rows (5 in the Capsule), then "Show all 23" opens the rest in place, in the same card,
  which then scrolls inside at 360.

**Text.** The body is prose in 13/18 `--text` (15/22 in the Capsule, 17/24 on the phone), padding
12 16, paragraphs 8 apart, at most 12 lines then "Show all" (the card grows to fit). A text that
is code, a log or a config is one code block (card.md, Code): `--code-bg`, radius 8, mono 13.

**Card.** One thing and its facts: the title as 15/22 600 `--text` in the body's first line, then
field rows as the draft card's (key 12/16 `--label` in a 64 column, value 13/18 `--text`), `--rule`
between. For one device, one account, one module.

**Answer.** Not a command result — the shape Deck Find, the Memory view's search box and phone
Find draw for `memory.ask` (ADR 0034; memory-iq's iq-everywhere.md), sitting above the search hits
it does not replace. Built once in chat-core so the PWA gets it too.

- No header row: the answer is the card's first line, 13/18 `--text` (17/24 on the phone), in the
  user's own words for names and files.
- Meta line under it, 12/16 `--label`, plain text, no colour ever: "confidence 0.8 · from 2
  sessions" (or "from what you have said" for a personal fact). Confidence is never a traffic
  light and never a status mark.
- Up to three sources as source chips (chip.md: `--rule-strong` border, no fill, mono meta), each
  naming the session and when, with the quoted words; a tap opens that turn. A fourth and more
  collapse behind "More".
- Abstained: the first line reads "Not sure yet.", then "What memory does know:" in `--label` and
  the `known` lines under it, same shell, same padding — never a separate empty state.
- Limited: the `message` from `memory.ask` shown as-is, with its link to Settings.
- **Correct in place.** A quiet "Wrong?" (steplink, not a chip or button) sits after the meta
  line, dot-separated. It expands the row in place, no sheet: two ghost buttons ("That's wrong",
  "Forget this") then a single-line text field prefilled with the current answer; ⏎ sends the
  edit, Esc collapses with nothing sent. An abstained card skips the two buttons and shows the
  field alone, always open, empty, placeholder "Know it? Tell me". After a fix the meta line
  becomes "you corrected this" with an "Undo" steplink beside it, dot-separated; unlike the
  optimistic-action undo (toast.md, 4 s), this Undo does not time out — the card can sit
  unnoticed in a scrolled-past search result.

**Mono.** Only values that are code, a path, a command, an id, a key or a version use JetBrains
Mono (13 in the body, 12 in meta): `src/intake/estate.ts`, `0.2.0`, `cn_4f2k`. Names, words, times and
counts stay in Instrument Sans.

**Actions.** `actions` are `[{label, key?, run: {tool, input}}]` or a command to run. At most 3
show, as ghost buttons xs with their key hint; the first may be secondary when it is the obvious
next step, never primary: a result card has no lime. An action that sends, posts, pays or deletes
goes through its own ask or draft card, never straight from here.

**Copy as text.** ⌘C with the card focused, or the header's copy button, copies the result as the
CLI would print it (a table as aligned columns), "Copied" for 2 s in place.

## Sizes

| | Deck, desktop | Phone | Capsule |
|---|---|---|---|
| Width | the transcript column, up to 820 | full width minus 32 | the panel minus 32 |
| Row | 36 (32 in columns) | 44 | 44 |
| Max rows before Show all | 8 | 8 | 5 |
| Text | 13/18 | 17/24 | 15/22 |

## States

| State | What shows |
|---|---|
| Running | the header with a running ring in place of the icon; the body keeps its last height, or 2 skeleton rows |
| Done | as above |
| Empty table | one row in `--label`: the command's own empty words ("No devices yet"), then its first action |
| Error | the card's error state: what failed in plain words 13/18 `--text` with the failed mark ("Couldn't list devices"), the detail in mono 12 `--text-2` (`ECONNRESET after 15 s`), then Retry (ghost) |
| Needs a credential | the credential sheet opens (credential-sheet.md); the card shows "Needs a Deepgram key" with Connect (ghost) until it is done |
| No result shape | a command that returns only text is drawn as the text view in a code block |
| Box away | "Queued · runs when the box is back" (pill.md queued line) under the header |

## Keyboard and touch

The card is not in the tab order; its buttons are. With the card focused (the Capsule's result, or
a tool row opened in chat), the action keys work (the hint says which), ⌘C copies, and ↑ ↓ move
through table rows, ⏎ opens a row that has `run`. In the Capsule, ⌘O opens the full result in the
Deck. On touch, rows and buttons are 44.

## Motion

None on the card. "Show all" grows the card in place over `--motion-panel`; reduced motion jumps.

## Copy

- Titles are the command's plain name in sentence case: "Devices", "Connected accounts".
- "Show all 23", "Copied", "Retry", "Queued · runs when the box is back".
- Never "Output", "Result", "Success", "Done!", raw JSON, or a table border drawn with characters.

## Accessibility

- The card is a `section` labelled by its title. A table view with columns is a real `table` with
  header cells; as rows it is a `list`.
- The copy button is named "Copy as text". Status marks carry their word.
- A new result in the Capsule is announced once, politely: "Devices, 4 rows".

## Gaps

Deck (work/chat)
- [ ] Slash commands print terminal text in a tool row; ask with `render: true` and draw the card.

Deck (work/pwa)
- [ ] ⌘K Run results open a terminal line; draw the card under the Run row.

App (work/mobile)
- [ ] Nothing built: the three views in the chat-core transcript, rows only.

Capsule (work/capsule-pro)
- [ ] Nothing built: the card under the input for a run command, 5 rows, ⌘O to the Deck.

platform
- [ ] The result shape on the commands field (`view`, `title`, `rows`, `text`, `actions`) and
      `render: true` on the call.

CLI (work/polish-cli)
- [ ] `--view` frames for the seven commands without JSON output (capsule, connect, hooks, mcp,
      sideview, voice, send), so every surface has a result to draw.

System (app-design)
- [ ] The ResultCard board on the canvas: table, text, card, error.
- [ ] An AnswerCard board: the answer, sources, abstained, limited, and correct-in-place open.

Deck (work/pwa), App (work/mobile) — the Answer variant
- [ ] Find has no `memory.ask` card above its hits; the same gap in the Memory view's search box
      and phone Find. Built once in chat-core (memory-iq's iq-everywhere.md, Deck/App/phone gaps).
