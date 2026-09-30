---
title: Diff
summary: A unified line diff with added lines on the bone wash, removed lines on a neutral wash, and line numbers.
audience: builders
owner: app-design
status: draft
---

# Diff

A unified diff of a file change. It appears inside an opened tool row, inside a permission ask
for an edit, and in the Files tab. It opens only when you ask. Drawn on "Session, phone and
desktop" (the Edited row, opened).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/core/line-diff.js`, `deck/chat/lib/diff.js`, `deck/chat/chat.css` (work/chat) | partial |
| App | none | not built |
| Capsule | none | not built |

## Anatomy

A block on `--code-bg`, padding 6 top and bottom, JetBrains Mono 12/20. Each line is a grid of
three columns:

1. **Line number**, 44 wide, right-aligned, 10 right padding, `--label`.
2. **Sign**, 16 wide: `+`, `-` or a space, `--label`.
3. **Text**, the rest, `white-space: pre`, scrolls sideways inside the block.

| Line | Fill | Text | Number |
|---|---|---|---|
| Added | `--signal-wash` | `--text` | `--text-2` |
| Removed | `--del-wash` | `--text-2` | `--text-2` |
| Context | none | `--text-2` | `--label` |
| Hunk header (`@@ ... @@`) | none | `--label` | empty |

Above the block, in the tool row that holds it: the path in mono and the counts `+12 −4` in
`--text-2`. Counts are neutral, never bone or another hue.

## Variants

- **Inline** (in a tool row or ask card): no header of its own, capped at 20 lines, then a
  "Show all 64 lines" ghost button.
- **Full** (Files tab): a sticky file header (path, counts), all hunks, "3 unchanged lines" rows
  between hunks that expand on click.
- **New file**: every line added; the tool row meta reads "new · +60".
- **Multi-file** (30 Sep, the PR review card's use, `pr-review.md`): several files' diffs in one
  scroll, each behind its own collapsed file row: path (mono 13, `--text`), counts `+12 −4`
  (`--text-2`), a chevron. Collapsed by default beyond the first file; a file with a review
  comment on it (see `pr-review.md`) opens by default regardless of position. Collapsing one file
  never affects the others - each file's open state is independent, and "Collapse all" /
  "Expand all" (ghost, header of the file list) set every file at once. Everything else (the
  per-line anatomy, the added/removed washes, Too large per file) is unchanged from the single-
  file diff above; a file over the Too large threshold collapses to its own message inline rather
  than blocking the rest of the list.

## Sizes

Desktop and phone share mono 12/20 and the column widths. On the phone the block scrolls
sideways; lines never wrap.

## States

- **Default** as the table.
- **Hover** (full variant): the line fill steps to `--hover` on context lines only.
- **Selected lines** (full variant, for a comment): `--signal-wash` with a 2 px `--focus` left
  inset.
- **Loading**: three skeleton lines shaped like diff lines (`--hover`, 10 tall).
- **Too large**: "This diff has 4,200 lines. Open it in Files." with a secondary button.
- **Binary**: "Binary file changed" in base size, `--text-2`.

## Keyboard and touch

- Text is selectable; the number and sign columns are not (`user-select: none`).
- Full variant: J and K move between hunks.

## Motion

None. It appears when its tool row opens.

## Copy

"Show all 64 lines", "3 unchanged lines", "Binary file changed", "new · +60". Counts use the true
minus sign (−).

## Accessibility

- The block is a `table` of rows for screen readers: "added line 12, import estateV2 ...".
- Colour is never the only signal: the sign column carries `+` and `-`.
- `--text` on `--signal-wash` and `--text-2` on `--del-wash` pass AA at 12 in both themes.

## Gaps

Deck (work/chat)
- [ ] Removed lines strike through (`text-decoration: line-through`); spec: no strike.
- [ ] Removed text is `--label`; spec: `--text-2`.
- [ ] Added sign in the signal colour; spec: `--label` sign, colour only in the fill.
- [ ] Mono 12.5/21; spec: 12/20.
- [ ] Legacy `.diff-del` in `deck/chat/chat.css` uses the beacon colour and wash; remove it.

App (work/mobile)
- [ ] Not built: edits show as a tool row with no diff.

Capsule (work/capsule-pro)
- [ ] Not built.
