---
title: List row
summary: The generic 44 row with a title and a meta line, used by every list that is not Needs you, settings or devices, with hover, focus and selected states.
audience: builders
owner: app-design
status: draft
---

# List row

The plain row of the one-row family: a thread in Chats, an agent, a project, a vault item, a
search result, a group in Settings, a command in Find. Title, one meta line, optional leading
tile and trailing meta. Needs you, settings and devices extend it (see their specs). Drawn on the
boards "Session, phone and desktop" (thread list), "States, every list, every size" (long names),
"Vault, phone and desktop" and "Settings · account and project scopes" (group list).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/chat.css` `.thread-row`, `.fb-row` (main); `deck/css/views/find.css`, `deck/css/views/planner.css` `.pl-row` | partial |
| App | `apps/app/src/ui/Row.tsx` Row, `ROW_HEIGHT` (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/CapsuleView.swift` Row (work/capsule-pro) | partial |

## Anatomy

Flex row, align center (align start when it has three lines), gap 12, min height 44, padding 6
16.

1. **Leading** (optional): an avatar (agent tile 24 or 32, person avatar round), a 16 icon in
   `--text-2`, or a status mark (see the status-mark spec) before the title.
2. **Title.** Base size, `--text`, 400 (600 when unread), one line, ellipsis. The part a search
   matched is 600.
3. **Meta line** (optional). Meta size, `--label`, one line, ellipsis: "kit · 24m", "kit ·
   Harlow Legal / estate-planning-intake-sacramento", "Sessions · 10 min".
4. **Trailing** (optional). Meta size `--label` age or count ("3m", "12 threads"), a count pill, a
   key-hint chip ("⏎"), or a 12 chevron in `--label` when the row pushes a screen.

Rows are separated by a 1 px `--rule` top border inside a list (none on the first).

## Variants

- **Single line** (44): title only, trailing meta.
- **Two line** (min 44, about 56): title and meta. The default.
- **Three line** (thread in Chat, about 76): title, last message in `--text-2`, meta.
- **Dense** (36, padding 4 16): pickers, the key-driven Find list.
- **Group row** (Settings list): title 600, meta is the group's current values ("Plan first · 4
  allow, 1 ask, 3 never"), a count on the right.
- **Queued row** (chat's composer queue, `threads.send {now: false}`; also the todos pin): a
  message waiting to join the session at its next step, before the row is a real turn. 1 px
  dashed `--rule-strong` border (dotted for a message queued locally, not yet confirmed by the
  box), no fill, min height 32, padding 0 6 0 12. Label "Queued for after" (`.lbl`, sentence
  case, 12/16 600 sans, never the retired mono/uppercase `.lbl` (see tokens.md Retired names),
  then the queued text in `--text-2`, ellipsis. Trailing: ghost buttons "Edit", "Take back",
  "Steer now" (or "Send now"), ⏎/key hints per key-hint.md. Wraps on the phone: the text drops to
  its own full-width line under the label.

## Sizes

| | Desktop | Phone |
|---|---|---|
| Min height | 44 (36 dense) | 44; 56 with meta |
| Padding | 6 16 | 12 14 in a card, 12 16 bare |
| Title | 13/18 | 17/24 |
| Meta | 12/16 | 13/18 in rows, 12/16 in the kind line |

Desktop titles never wrap. Phone titles wrap to two lines at larger text sizes and the row grows.

## States

- **Default.**
- **Hover** (desktop): fill `--hover`, no transition delay (`--motion-tap` out).
- **Pressed** (phone): fill `--hover` on touch-down, no transition.
- **Focused** (keyboard): 2 px `--focus` outline, offset -2, square corners.
- **Selected**: fill `--signal-wash`; meta and trailing step up to `--text-2`; hover keeps the
  wash. Selected and focused can show together.
- **Unread**: a text-colour dot leading and the title in 600; clears on open.
- **Running**: the lime ring before the title with its elapsed time in the meta ("kit · 24m").
- **Failed**: crossed circle in `--text-2`, the meta reads the failure in `--text`.
- **Disabled**: title and meta in `--label`, no hover, a reason in the meta.
- **Skeleton**: a 24 block, a title bar 10 tall at 40% width and a meta bar at 25%, in `--hover`.

## Keyboard and touch

The row is a link or button (the whole row is the target, 44 minimum). J and K or ↑ and ↓ move
the selection in its list; Enter opens. Long-press (phone) or hover (desktop, 600 ms) shows the
full title when truncated. `-webkit-touch-callout: none` and no text selection on rows.

## Motion

Hover and pressed fills change in `--motion-tap` out, 0 in. A row that leaves collapses over
`--motion-tap`. Nothing else moves.

## Copy

Titles are the thing's name as the user knows it ("Harlow Legal · Estate planning intake form
rebuild"); meta joins facts with " · ". No trailing punctuation, no caps.

## Accessibility

`role="link"` or `button` with the title as the name and the meta as the description; in a
listbox, `role="option"` with `aria-selected`. The status mark has a text equivalent in the
accessible name ("running", "failed", "unread").

## Gaps

Deck
- [ ] No generic row: `.thread-row`, `.fb-row`, `.pl-row` and `.fd-row` each set their own
      height, padding and type; make one `.li` with the variants above.
- [ ] Failed marks are violet in places; use the crossed circle in `--text-2`.
- [ ] Queued row and the todos pin (`deck/chat/session.js` `.cv-queued-row`, `deck/chat/tray.js`)
      both label themselves with the base `.lbl` in `deck/css/deck.css`, which is still the
      retired mono 11, uppercase, 0.16em spec (TOKENS.md line 60's old "Buttons: Mono 12/16, 500,
      uppercase" carried over), reads "QUEUED FOR AFTER" and "TODOS 1 of 3" on screen instead of
      sentence case. This is the base class, used about 146 places across the whole Deck
      (chat, glass, vault, views/*, onboarding); fixing `.lbl` itself in deck.css to 12/16 600
      sans, sentence case, fixes every caller at once rather than patching each one. app-design
      2026-09-28, from a live-build review, not a board.

App (work/mobile)
- [ ] Row is one 86 tall three-line shape for everything (`ROW_HEIGHT`); add the 44 single and
      two-line variants and selected, focused states.
- [ ] Rows sit on `--bg` with a bottom border, not in a card; the avatar is round, not a tile.

Capsule (work/capsule-pro)
- [ ] Row is 40 tall with hand-typed sizes (14, 12, 11.5); selected is a rounded raised fill with a 3 px lime capsule on the left; use
      44, the type steps and the `--hover` fill.
