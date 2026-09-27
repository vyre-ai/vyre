---
title: Composer
summary: The session input that works like Claude Code in the terminal, with steer by default, queue for after, stop, rewind, modes, and the line prefixes for commands, files, shell and memory.
audience: builders
owner: app-design
status: draft
---

# Composer

The input at the foot of every session. Typing while the agent works steers it; ⌥⏎ queues for
after the turn; Esc stops; Esc Esc rewinds; ⇧Tab cycles the mode. Drawn on "Session · the
composer, like Claude Code", "Session, phone and desktop" and "Plan approval and modes".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/composer.js`, `deck/chat/core/composer-state.js`, `deck/chat/tray.js`, `deck/chat/pickers.js` (work/chat) | partial |
| App | `apps/app/src/session/Composer.tsx` (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/CapsuleView.swift` bar, `Extensions/sight/SessionPanel.swift` prompt (work/capsule-pro) | partial |

## Anatomy

Above the box, bottom up, gap 8: the **queued row**, the **background task pill**, and on the
phone the **todos pill**. Then the box: `--panel`, 1 px `--rule-strong`, radius 12.

1. **Input**: padding 12 14 4, read size, min height 40 (phone 44), grows to 8 lines then scrolls.
   Placeholder `--label`: idle "Reply to kit, @ to mention, / for commands"; running "Steer kit, or
   ⌥⏎ to queue for after". Caret 1.5 wide in `--focus`.
2. **Bar**, padding 6 8 8, gap 4, left to right: Attach (plus, icon chip 28), provider chip
   ("Claude · opus", chev-d), vault chip (tag, vault icon, "vault: northwind orders", when a grant
   is live), spacer, mode chip ("Asks first" with "⇧Tab" in `--label`; see mode-chip), Dictate
   (mic, 28), then **Stop** `Esc` (secondary, 28, stop icon; only while running) and **Send**
   (send icon, 28; `--hover` fill with `--text` while running, where it steers; `--primary-bg`
   when idle with text).
3. **Queued row**: 1 px `--rule`, radius 8, padding 4 4 4 12: clock icon, "Queued for after"
   (meta `--label`), the text (`--text-2`, ellipsis), then Edit and Take back (ghost 28) and Steer
   now (outline 28). Editable or taken back until the turn ends.
4. **Background task pill**: height 32, radius 16, 1 px `--rule`: terminal icon, "1 background
   task" (meta 600), "npm run dev · 4m" (mono 12 `--text-2`), View output (ghost 24), Stop (outline
   24). ⌃B opens the list: one row per task, run dot or done dot, mono command, "running · 4m" or
   "exit 0 · 2m ago", View output, Stop.
5. **Todos pill** (phone): 44 tall, radius 22, `--panel`, 1 px `--rule`: todo icon, "Todos 3 of 5"
   (base 600), the running ring, the current item (`--text-2`), chev-d. Opens the list as a sheet.
   On the desktop the todos live in the side panel instead.

## Variants: the first character

| Prefix | Mode | What shows |
|---|---|---|
| `/` | Commands and skills | A popover above the box: groups "Built in", the project, "Plugins and skills"; rows 28, command mono 13 (116 wide) and description; footer "Type to filter · ↑↓ move · ⏎ run · Tab complete · Esc close" |
| `@` (anywhere) | Files | "Files in harlow-legal · recent first", rows 30, file icon, path mono 13 with the match in 600, "edited 2m"; ⏎ inserts a quoted path chip (tag, mono) |
| `!` | Shell | Input turns mono; the bar shows a "Shell" tag and the folder in mono 12; "⏎ run · Esc leave shell"; output lands as a tool row |
| `#` | Memory | A "Memory" tag; ⏎ opens "Save this to": This project (Harlow Legal only) or About you (every project and chat); then "Saved to memory · Harlow Legal" with Undo |

⌘V pastes an image: a 56 thumbnail row above the input with name, "PNG · 1170 x 2532" and Remove
(44 on the phone). ↑ in an empty box recalls your last message ("Recalled from 14:32 · ↑ again for
older · Esc clears"), or the newest queued message to edit.

## Sizes

Desktop chips and buttons 28. Phone: Attach, Stop and Send are 44 circles (radius 22); Stop on
`--hover`, Send (steer) on `--primary-bg` with `--primary-ink`; the mode chip is 44 tall. Input
text never under 16 on the phone (read 17).

## States

- **Idle, empty**: Send disabled (label ink, no fill). **Idle, text**: Send primary.
- **Running**: Stop shows; ⏎ steers. On send the transcript draws "steering · kit reads it at its
  next step" at once; thread.steered confirms it (see turn).
- **Queue** (⌥⏎, or a long press on the phone's Send, which opens "Steer now · kit reads it at its
  next step" and "Queue for after · Waits for this turn to end"): the queued row appears.
- **Stopping** (Esc): open asks for that turn close; the turn ends "Stopped by you".
- **Rewind** (Esc Esc on an empty box): a popover "Rewind to an earlier message", your messages
  newest first with "14:32 · 3 file changes after this"; "Also undo file changes" checkbox ("3
  files go back to 14:32"; needs File checkpoints on, else disabled with "Needs File checkpoints on
  (Settings, Sessions)"). The action is Rewind (secondary); with the checkbox it becomes the hold
  button "Rewind and undo 3 files" (0.6 s). Cancel `Esc`. The text comes back: "Prefilled from 14:32".
- **Mode change** (⇧Tab): the chip changes in place; Plan first, Asks first, Edits allowed,
  Doesn't ask. Only the person switches into Doesn't ask; its chip is the inverse neutral chip.
- **Plan waiting**: on the phone the composer tucks away until the plan is answered.
- **Offline**: sends go to the outbox; the send stays drawn with "Sends when back online".

## Keyboard and touch

Esc stop · Esc Esc rewind · ⇧Tab next mode · ⏎ send or steer · ⌥⏎ queue · ⇧⏎ new line · ↑ recall ·
⌃B background tasks · ⌘V paste image · / @ ! #. On a touch keyboard Return is a new line and Send
sends; hold Send to queue. The composer moves with the keyboard by transform in the same frame.

## Motion

Popovers open at `--motion-tap` (120) from 4 px below; the hold fill runs `--motion-hold` (600).
Steer, queue and memory saves draw on send and confirm in place. Menus filter from a cached index
on the next frame.

## Copy

As quoted above. Never "Accepts edits", "Plan mode", "bypass" in the chip; never "Submit".

## Accessibility

Input `aria-label="Message kit"`; Stop "Stop kit (Esc)"; Send "Steer kit (Return)" while running,
"Steer kit, hold to queue for after" on the phone. Popovers are `listbox` with `aria-activedescendant`.

## Gaps

Deck (work/chat)
- [ ] No Attach, vault chip or Dictate; placeholder "Steer kit, or Alt+Enter to queue for after".
- [ ] Mode labels "Accepts edits" and "Plan mode"; ⇧Tab walks three modes and never Doesn't ask.
- [ ] Rewind offers three restores; spec: one list, the "Also undo file changes" checkbox, the hold.
- [ ] Todos pinned above the composer on the desktop; spec: side panel.
- [ ] Stop is ghost; spec: secondary.

App (work/mobile)
- [ ] Text only: no chips, attach, prefixes, queued row, pills or rewind; input 16 not 17.

Capsule (work/capsule-pro)
- [ ] Plain field; no steer, queue, Stop, modes or prefixes.
