---
title: Draft card
summary: A held outbound draft whose every line edits in place, with Send, Discard, a scheduled send and the presence line.
audience: builders
owner: app-design
status: draft
---

# Draft card

An agent drafted something that leaves as you (an email, a post, a payment), and the Gate holds it
until you say so. The card shows exactly what will be sent; every line is a field you change in
place. It appears in the Needs you detail pane, in the session transcript and as a pushed screen on
the phone. Drawn on "Needs you, phone and desktop" and "Presence, sign in once, prove it rarely".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/gate-item.js` (work/chat); phone `deck/js/need-sheet.js`, `deck/js/editable.js` (work/pwa) | partial |
| App | `apps/app/app/need/[id].tsx` (work/mobile) | partial |
| Lumen | `local/capsule/native/Sources/UI/AgentDeskView.swift` HeldCardView (work/capsule-pro) | partial |

## Anatomy

A neutral card: `--panel`, 1 px `--rule`, radius 12 (phone 10).

1. **Header**, 44 tall, padding 0 16: needs-you dot, label "Draft to send" (meta 600,
   `--beacon-ink`), right "Gate · outbound email" (meta, `--label`).
2. **Field rows** (`df`), padding 0 16: a grid of 64 and the rest, gap 12, baseline aligned,
   7 top and bottom, 1 px `--rule` top border:
   - key in meta, `--label`: From, To, Cc, Subject, Message, Attached; From shows only when more
     than one account can send, and opens the account picker (account-row.md);
   - value in base (read on the phone), `--text`; addresses and paths in mono 13; the message as
     prose paragraphs 8 apart; an attachment as file icon, name, size in meta `--label`.
3. **Footer**, padding 12 16, 1 px `--rule` top, gap 8, in this order: **Send** `⌘⏎` (primary),
   **Send at 9:00 tomorrow** (secondary, `--hover` fill), the presence line (see presence-line),
   then **Discard** `D` (ghost) pushed right.
4. Under the card, meta `--label`: "Every line is a field: click to change it. Nothing leaves until
   you press Send. Discard keeps an undo for 10 s."

## Variants

- **Detail pane** (desktop): with the pane header (agent tile 40, title at title size, "kit ·
  Harlow Legal · held 12 min ago", "Open session" ghost) and "Why kit wants to" below the card.
- **Phone screen**: fields in a `ph-card` (key meta `--label`, value read 17); the message folds
  to two lines with "3 more lines · q3-report.pdf, 412 KB"; buttons stack: Send 54 full width, the
  presence line, then Send at 9:00 tomorrow (44, grows) and Discard (44 ghost) side by side.
- **Other kinds**: a post names the account in To; a payment shows Amount in mono and the payee;
  the label reads "Post to publish" or "Payment to approve".

## Sizes

Buttons 32 desktop, 54 and 44 phone. Key column 64. Values wrap; nothing truncates in a draft.

## States

- **Field default**: value has no chrome. **Hover** (desktop): `--hover` fill, radius 6, padding
  2 6 (negative margin, so nothing moves). **Editing**: 1 px `--focus` ring, `--bg` fill. Single
  line fields take no Enter; the message takes new lines.
- **Edited**: the primary reads "Send edited"; the sent version is what you see.
- **Covered** (a proof in the last 30 min): Send plain; presence line "Face ID confirmed 12 min ago
  · covers sends until 15:02".
- **Lapsed**: Send becomes "Send with Face ID" (faceid icon), the line reads "Last Face ID 34 min
  ago" (see presence-line).
- **Busy**: Send keeps its width, spinner, "Sending"; other buttons disabled.
- **Sent**: the card becomes one row, check glyph, "Sent to Sam", Undo (ghost) for 4 s.
- **Scheduled**: "Sends at 9:00 tomorrow" with Undo 4 s, then "Scheduled · 9:00 tomorrow".
- **Discarded**: "Discarded" with Undo for 10 s, then the row leaves Needs.
- **Failed**: the draft stays held, one line with the failed mark: "It came back held: <reason>.
  Send tries again." No red.

## Keyboard and touch

`⌘⏎` sends; `D` discards (when focus is not in a field); Tab moves field to field; Esc leaves a
field keeping the edit. Phone: tap a value to edit; the keyboard pushes the card up, no jump.

## Motion

Edit ring at `--motion-tap`. Sent and Discarded collapse on the commit frame; the Undo lasts
`--motion-undo` (4 s; Discard 10 s).

## Copy

"Draft to send", "Send", "Send edited", "Send with Face ID", "Send at 9:00 tomorrow", "Discard",
"Sent to Sam". No Edit button, ever: fields edit in place. Never "HELD FOR YOU" in caps.

## Accessibility

- Each value is a labelled text field (`aria-label="Subject"`) that reads as text until focused.
- Send carries `aria-keyshortcuts="Meta+Enter"`, Discard `"D"`.
- The presence line is `aria-live="polite"` so a lapse is announced.

## Gaps

Deck (work/chat, work/pwa)
- [ ] No "Send at 9:00 tomorrow"; no D key on Discard.
- [ ] Badge "Held for you" beside the title; spec: header dot and "Draft to send" label.
- [ ] Presence line only on work/pwa, wording "Face ID covers sends until 14:32, confirmed 6 min ago".

App (work/mobile)
- [ ] Fields are read-only; spec: edit in place.
- [ ] No presence line; no "Send with Face ID" state; sends from the Deck or Lumen "for now".

Lumen (work/capsule-pro)
- [ ] Field keys in caps, tracked; label "HELD FOR YOU"; spec: sentence case.
- [ ] No scheduled send; no presence line under Send.
