---
title: Plan card
summary: An agent's plan to approve, as a short document with steps, what it will not touch and the files it expects, then Start building in a chosen mode, Revise or Keep planning.
audience: builders
owner: app-design
status: draft
---

# Plan card

When an agent in Plan first finishes planning, it asks you to approve the plan. The plan is the
fourth kind of ask, beside permission, question and mode (ADR 0030). It sits at the tail of the
session and as "kit has a plan to approve" in Needs you; answering either resolves the other.
Drawn on "Plan approval and modes, phone and desktop".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none; the plan shows as an unfolded tool row (`deck/chat/core/grouping.js`, `deck/chat/core/tool-detail.js`, work/chat) | not built |
| App | none | not built |
| Capsule | none | not built |

## Anatomy

A neutral card: `--panel`, 1 px `--rule`, radius 12 (phone 10).

1. **Header**, 44 tall, padding 0 16: needs-you dot, label "Plan to approve" (meta 600,
   `--beacon-ink`), right "kit · 14:40" (meta, `--label`).
2. **Body**, padding 4 16 16, gap 12:
   - **Title**, read 600 (desktop 15, phone 17).
   - **Steps**, a numbered list, read size, gap 6: the number in `--label` ("1."), the step in
     `--text`; paths and commands as inline code (mono 13 on `--hover`, radius 4).
   - **Will not touch**: one line, base, `--text-2`: "Will not touch the general intake,
     src/billing/ or anything outside ~/work/harlow-legal." (paths in mono 12).
   - **Files it expects to change**: label (meta 600, `--label`) with "4 files · +140 −62" right
     (meta, `--text-2`), then one row per file: path in mono 12 with ellipsis, counts right in
     `--text-2`, "new · +60" for a new file. Counts are neutral.
   - **Then continue in**: meta `--text-2`, then a segmented control (radiogroup) "Asks first" |
     "Edits allowed", Asks first selected by default.
3. **Footer**, padding 12 16, 1 px `--rule` top, gap 8: **Start building** `⌘⏎` (primary),
   **Revise** `R` (outline), **Keep planning** (ghost).

## Variants

- **Desktop** (above).
- **Phone**: steps fold after four with a ghost "Show all 6 steps" (chev-d); files collapse to one
  row "4 files expected · +140 −62" with a chevron that opens the list; "Then" and the segmented
  control fill the width; buttons stack: Start building 54 full width, then Revise and Keep
  planning side by side at 44. The composer tucks away while a plan waits.
- **Building** (after Start building): the same card shrinks to a header with the running ring,
  "Building · Asks first" (base 600) and "kit · 14:41", and one line with the check glyph "Plan
  approved on this iPhone · 6 steps" (base, `--text-2`).

## Sizes

Buttons 32 desktop; 54 and 44 on the phone. Segmented control 32 desktop (28 buttons inside), 40
on the phone. File rows 20 tall desktop, 24 phone.

## States

- **Open**: as above. The session chip reads "waiting · plan".
- **Busy**: Start building keeps its width with the spinner and "Starting".
- **Building**: see Variants; the mode chip in the composer updates to the chosen mode at once.
- **Revise**: the composer opens prefilled "Change the plan: " with the caret at the end; kit stays
  in Plan first; the card stays open until the new plan replaces it.
- **Kept planning**: the card folds to "Kept planning · you declined this plan" with the x glyph,
  `--label`. No note is sent.
- **Answered elsewhere**: "Approved from the phone · 14:41".
- **Error**: buttons come back, one line with the failed mark in `--text`.
- **Offline**: Start building goes to the outbox; "Building · sends when back online" with Undo 4 s.

## Keyboard and touch

`⌘⏎` starts building in the selected mode; `R` revises; ← → move the segmented control when it has
focus. Keys route to the plan card when focus is not in a text field. No proof is asked.

## Motion

Start building flips the card to Building on the commit frame. Step and file lists open with
`--motion-panel` (220). Reduced motion: no height animation.

## Copy

"Plan to approve", "Will not touch ...", "Files it expects to change", "Then continue in", "Start
building", "Revise", "Keep planning", "Show all 6 steps", "Building · Asks first", "Plan approved
on this iPhone · 6 steps". Mode names are the plain four (see mode-chip), never "acceptEdits".

## Accessibility

- `section` with `aria-label="Plan to approve"`; the steps are an `ol`.
- The mode choice is a `radiogroup` labelled "Then continue in".
- Start building carries `aria-keyshortcuts="Meta+Enter"`, Revise `"R"`.

## Gaps

Deck (work/chat)
- [ ] Not built. The plan text shows as an unfolded tool row with no approve controls; the ask of
      kind plan needs this card, the Needs row "kit has a plan to approve", and the mode choice.

App (work/mobile)
- [ ] Not built.

Capsule (work/capsule-pro)
- [ ] Not built (proposed: the Needs row with Start building on `⌘⏎`, the card opening in Chat).
