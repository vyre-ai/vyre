---
title: Tool row
summary: One quiet line per tool call, with an icon, a verb, a mono summary and a running timer, folding runs of calls and opening to their detail.
audience: builders
owner: app-design
status: draft
---

# Tool row

Every tool call in a transcript is one quiet line: an icon, a past-tense verb, a mono summary and
what it cost. A run of calls folds into one row that opens to them. Drawn on "Session, phone and
desktop", "Session · the composer, like Claude Code" and "Plan approval and modes".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/core/grouping.js`, `deck/chat/core/tool-detail.js`, `deck/chat/chat.css` (work/chat) | partial |
| App | `apps/app/src/session/Rows.tsx` RunRow (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/CapsuleView.swift` ToolRows (work/capsule-pro) | partial |

## Anatomy

A flex row, gap 8, no border, no fill, `--text-2`:

1. **Icon**, 16, from the stroke set: file (Read, Edited, Wrote), terminal (Ran, Shell), search
   (Searched), globe (Fetched), agents (sub-agent), chev-r when the row opens to detail. Running:
   the spinner (14, 1.5 ring `--rule-strong`, arc `--text-2`) replaces the icon.
2. **Verb**, base size: Read, Edited, Wrote, Ran, Searched, Fetched, Running, Editing.
3. **Summary**, JetBrains Mono 12/16, `--text-2`, one line, ellipsis in the middle for paths.
4. **Right meta**, pushed right, meta size: `+12 −4` (`--text-2`), "0:18" elapsed while running
   (`--text-2`), "9 s" or "moved to background" (`--label`), "you · 0.2 s" for a `!` line.

**Folded run.** Consecutive calls fold: chev-r, "Read 6 files, searched 2 patterns", right meta the
total time. Running: "Running npm run build · 0:42". A run of one stays a plain row. A plan and a
todo list never fold.

**Expanded detail.** Opening a row shows, indented to the summary, a block on `--code-bg` with a
1 px `--rule` top border: the full command and output (terminal type), or the diff (see diff), or
key and value pairs for other tools. A `!` shell row always shows its output, capped at 12 lines
with "Show all".

## Variants

- **Plain** (one call), **folded run**, **running**, **failed**, **opened**.
- **Shell line** you ran with `!`: verb "Shell", meta "you · 0.2 s", then one line under the block:
  "Ran in ~/work/harlow-legal. kit sees the output on its next turn."

## Sizes

| | Desktop | Phone |
|---|---|---|
| Row height | 28 (`--control-xs`) | 32 (`--control-sm`), hit area 44 |
| Verb | base 13/18 | base 13/18 |
| Summary | mono 12/16 | mono 12/16 |
| Detail block | mono 12/18, padding 8 12 | same, scrolls sideways inside |

## States

- **Default.** `--text-2`, no fill.
- **Hover** (desktop, rows that open). Fill `--hover`, radius `--radius-field` (8).
- **Focus.** 2 px `--focus` outline, offset 2.
- **Running.** Spinner, "Running" or "Editing", lime is never used for the text; the elapsed
  time counts up once a second so quiet work never looks stalled.
- **Failed.** Crossed circle icon in `--text`, verb stays, meta "failed · exit 1". Never violet,
  never a border.
- **Canceled** (turn stopped). Meta "stopped", icon unchanged, `--label`.
- **Opened.** Chevron rotated 90; detail below.
- **Background.** Right meta "moved to background"; the task continues in the composer's
  background pill.

## Keyboard and touch

- A row that opens is a `button`: Enter or Space toggles. Arrow keys do not move between rows.
- Deep links (`?tool=<id>`) open the row and scroll it into view.
- Phone: tap anywhere on the row; long press copies the summary.

## Motion

Open and close with a `--motion-panel` (220) height reveal (grid rows 0fr to 1fr), chevron at
`--motion-tap` (120). The spinner stops under reduced motion and shows a still ring.

## Copy

Verbs past tense when done, present participle while running. Counts in words: "Edited 3 files,
ran 2 commands". Never tool names from the SDK (no "Bash", "TodoWrite"), never capitals.

## Accessibility

- Row: `button` with `aria-expanded` when it opens, else a plain `listitem`.
- Label: verb plus the full summary ("Ran npm test, 18 seconds").
- The spinner has `aria-hidden`; the row carries "running" in its label.
- Summary `--text-2` on `--bg` passes AA at 12.

## Gaps

Deck (work/chat)
- [ ] `.cv-tool` is a bordered card (38 high, `--panel`, radius 8); spec: a borderless 28 line.
- [ ] Failed uses `--beacon-ink` and a beacon border; spec: crossed circle in `--text`.
- [ ] Running state word is lowercase in the signal colour; spec: spinner plus `--text-2` verb.
- [ ] Meta is 11 px; spec: 12.

App (work/mobile)
- [ ] No icon, no elapsed timer, no detail; "Hide"/"Show" text instead of a chevron.
- [ ] Status mark dot instead of the icon.

Capsule (work/capsule-pro)
- [ ] SF Symbols instead of the stroke set; no folding, no detail.
