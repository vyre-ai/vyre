---
title: Question card
summary: An agent's question with radio or checkbox choices, an Other field and Submit, answered from the session or from Needs you.
audience: builders
owner: app-design
status: draft
---

# Question card

An agent asks you something with set choices ("Which intake form should the Estate branch use?").
It sits at the tail of the session and in Needs you at once; answering from either place resolves
both. Answering needs no proof. The row is drawn on "Needs you, phone and desktop"; the choice rows
share the `.choice`, `.radio` and `.chk` parts drawn on "Session · the composer, like Claude Code"
(the memory scope picker) and "System".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/question.js`, `deck/chat/lib/answers.js` (work/chat) | partial |
| App | none (the ask card says "Answer it in the Deck for now") | not built |
| Capsule | none | not built |

## Anatomy

A neutral card: `--panel`, 1 px `--rule`, radius 12 (phone 10), overflow hidden.

1. **Header**, 44 tall, padding 0 16: needs-you dot, label "Question" (meta 600, `--beacon-ink`),
   step "1 of 2" when there are several (meta, `--label`), right "kit · 14:40" (meta, `--label`).
2. **Question**, read size 600, `--text`, padding 0 16 12.
3. **Choice rows**, each a full-width `button`, padding 10 16, 1 px `--rule` top border, gap 12:
   - the mark: radio (16, 1.5 ring `--rule-strong`) for one answer; checkbox (16, radius 4) for
     several;
   - label (base 600 desktop, read 17 phone, `--text`) and an optional description under it
     (base, `--text-2`);
   - the number key hint on the right on the desktop (1 to 9, kbd chip).
4. **Other** row: the last row, label "Other"; picking it reveals a single-line field under it,
   indented to the label, placeholder "Type your answer".
5. **Footer**, padding 12 16, 1 px `--rule` top: **Submit** (primary, key ⏎) and **Decline**
   (ghost). With several questions the primary reads "Next" until the last, then "Review", then
   "Submit".

## Variants

- **Single** (radio) and **multiple** (checkbox, "Pick any").
- **With previews**: when choices carry a preview, the focused choice's preview sits beside the
  list from 900 wide (mono or markdown on `--code-bg`), under the list on the phone.
- **Review step** (several questions): a two-column list, question in `--label`, answer in
  `--text`, then Submit.

## Sizes

Choice rows at least 44 tall on the phone (52 with a description), 40 on the desktop. Buttons 32
desktop; 54 primary and 44 ghost stacked on the phone.

## States

- **Choice default**: no fill. **Hover**: `--hover`. **Focused** (keys): 2 px `--focus` inset on
  the left. **Selected**: `--signal-wash` fill, radio ring and inner dot `--focus`, checkbox filled
  `--text` with a `--bg` check; meta inside steps up to `--text-2`.
- **Submit disabled** until an answer is picked: label ink on `--hover`, never opacity alone.
- **Busy**: Submit keeps its width, spinner and "Sending".
- **Answered**: the choices fold to "Answered · Estate intake v2" with the check glyph; the dot and
  violet label leave. "Answered from the phone · 14:31" when another place answered.
- **Declined** / **Withdrawn**: the x glyph and the word, `--label`.
- **Error**: choices stay picked; one line with the failed mark and plain words.

## Keyboard and touch

1 to 9 pick a choice; ↑ ↓ move; Space toggles (multiple) or picks; Enter picks and moves on, and on
the last step submits; Esc steps back. Keys work when focus is not in the composer. Phone: tap a
row; the Other field opens the keyboard and the card scrolls above it.

## Motion

Selection fill at `--motion-tap` (120). Steps swap in place, no slide. Answered collapse on the
commit frame.

## Copy

"Question", "Other", "Type your answer", "Submit", "Next", "Review", "Decline", "Answered · <choice>".
No caps chips, no "Q1".

## Accessibility

- The choice list is a `radiogroup` or a `group` of checkboxes named by the question.
- Each row: `role="radio"` or `"checkbox"` with `aria-checked`, description as `aria-describedby`.
- Step "1 of 2" is announced with the question.

## Gaps

Deck (work/chat)
- [ ] `.cv-q-chip` step label is mono 11 px caps tracked; spec: meta sans, sentence case.
- [ ] Question 15/23 at weight 500, labels 14/20 at 500; spec: read 600 and base 600.
- [ ] Card border `--rule-strong`, radius 10; spec: `--rule`, radius 12.
- [ ] Choice numbers mono 11 on the left; spec: kbd chip on the right.

App (work/mobile)
- [ ] Not built: the ask card sends you to the Deck.

Capsule (work/capsule-pro)
- [ ] Not built.
