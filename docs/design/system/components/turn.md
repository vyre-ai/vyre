---
title: Turn
summary: One exchange in a session transcript, with your bubble, the agent's author line and prose, the thinking row, the steer marker and the turn footer.
audience: builders
owner: app-design
status: draft
---

# Turn

A turn is one exchange in a session: what you said, and the agent's reply with its thinking and
tool rows. It is the body of every transcript in Chat, on the desktop and the phone. Drawn on the
boards "Session, phone and desktop" and "Session · the composer, like Claude Code".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/session.js`, `deck/chat/core/session-state.js`, `deck/chat/chat.css` (work/chat) | partial |
| App | `apps/app/src/session/Rows.tsx` (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/CapsuleView.swift`, `UI/AgentDirectView.swift`, `Extensions/sight/SessionPanel.swift` (work/capsule-pro) | partial |

## Anatomy

1. **Your bubble.** Right-aligned, max width 78% of the transcript column, fill `--hover`, radius
   `--radius-card` (12), padding 8 by 12, text `--text` at read size. No author line, no avatar.
2. **Author line.** Agent tile (avatar, 24, initial "k"), gap 12, then the agent name (600) and the
   time (meta, `--label`), height 24. The body indents under the name, not under the tile.
3. **Thinking row.** A tool-row shaped line: chevron icon (chev-r, rotates 90 when open), "Thinking
   · 8 s". Open, the reasoning sits under it in base size, `--label`, with a 1 px `--rule` left
   border, 16 left padding, 7 left margin.
4. **Prose.** Read size, `--text`, paragraphs 8 apart, markdown rendered as text nodes. Inline code
   uses JetBrains Mono 13 on `--hover`, radius 4.
5. **Tool rows** (see tool-row) and an inline **diff** only when opened (see diff).
6. **Steer marker.** A centred line between two 1 px `--rule` hairlines: meta size, `--label`.
7. **Turn footer.** Meta size, `--label`: time and tokens ("18 s · 4.2k tokens"), or "Stopped by
   you", or the error in plain words.
8. Asks, questions and plans that open in the turn sit at its tail (see ask-card, question-card,
   plan-card).

Items stack with 10 gap in the transcript column; padding 8 top, 24 sides (16 on the phone).

## Variants

- **Desktop:** tile and name in one `.msg` row; tool rows 28 tall.
- **Phone:** the author line stands alone (tile, name at base 600, time); prose and rows below at
  full width; tool rows 32 tall; your bubble at 17/24.
- **Agent thread vs your assistant:** the name is the agent's (kit) or your assistant's (juno).
  Never "Claude" or "assistant".

## Sizes

| Part | Desktop | Phone |
|---|---|---|
| Your bubble text | read 15/22 | read 17/24 |
| Prose | read 15/22 | read 17/24 |
| Author name | base 13/18, 600 | base 13/18, 600 |
| Time, footer, steer marker | meta 12/16 | meta 12/16 |
| Thinking body | base 13/18 | base 13/18 |

## States

- **Streaming.** Prose reveals paced to the display (`--motion-reveal` 150); only the growing
  block re-parses. No caret in transcript prose.
- **Thinking, streaming.** Row reads "Thinking" with the running seconds; folds to "Thinking · 8 s"
  when done. Closed by default.
- **Steering (optimistic).** On send the marker reads "steering · kit reads it at its next step",
  your bubble drawn under it.
- **Steered (confirmed).** On thread.steered {uuid, turn, step} the marker reads "you steered here
  · after 3 steps · 14:32" and moves to where the words joined.
- **Stopped.** Esc or Stop: open asks for that turn close, the footer reads "Stopped by you".
- **Failed.** Footer: failed mark (crossed circle, `--text`) and the error in words. Never violet.
- **Rewound.** After Esc Esc the chosen message and everything after it leave the view; nothing
  is struck through.
- **Offline.** The transcript stays readable from cache; no placeholder over it.

## Keyboard and touch

- Text in bubbles and prose is selectable; nothing else is (no callout on rows).
- ⌃O shows or hides all thinking; Enter or Space on a focused thinking row toggles it.
- The transcript is an inverted list: newest at the bottom, earlier pages load above with no jump.

## Motion

Thinking opens with `--motion-panel` (220) height reveal, chevron rotates at `--motion-tap` (120).
The steer marker changes text in place, no move animation. Reduced motion: no reveal pacing
animation beyond showing text as it arrives.

## Copy

- "Thinking · 8 s", "steering · kit reads it at its next step", "you steered here · after 3 steps
  · 14:32", "Stopped by you".
- Never "Claude", "assistant", "AI", "Steered at step N", "Thought · N characters".

## Accessibility

- Each turn is a `listitem`; the author line is its label ("kit, 14:32").
- Thinking row is a `button` with `aria-expanded`.
- Steer marker is `role="separator"` with its text as the label.
- Streaming prose sits in an `aria-live="polite"` region that announces once per finished block.
- `--label` on `--bg` passes AA at 12; on `--hover` (your bubble) step meta up to `--text-2`.

## Gaps

Deck (work/chat)
- [ ] Steer marker reads "Steered at step N" in mono 11 px in the signal colour; spec: "you steered
      here · after 3 steps · 14:32", meta sans, `--label`.
- [ ] Turn footer `.cv-turn` is mono 11 px; spec: meta 12 sans.
- [ ] `.cv-text` is 15/24; spec: 15/22.
- [ ] Thinking body border 2 px `--rule-strong`; spec: 1 px `--rule`.

App (work/mobile)
- [ ] No author line (tile, name, time).
- [ ] Your bubble is `--panel` with a `--rule` border; spec: `--hover` fill, no border.
- [ ] Thinking reads "Thought · N characters" and never opens; spec: "Thinking · 8 s", expandable.
- [ ] Steer marker reads "Steering" / "Steered at step N"; spec copy above.

Capsule (work/capsule-pro)
- [ ] Three renderers (CapsuleView answer, DirectView message, SessionPanel message); one turn view.
- [ ] Author in mono caps; spec: sans 600, sentence case.
- [ ] No steer marker, no thinking row, no turn footer.
