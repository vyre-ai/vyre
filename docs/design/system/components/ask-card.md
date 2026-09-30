---
title: Ask card
summary: A permission ask with exactly what will run, why, and three answers (Allow once, Always in the project, Deny) on keys A and D.
audience: builders
owner: app-design
status: draft
---

# Ask card

A permission ask: an agent wants to run a command, edit a file or fetch a page, and waits for you.
It sits at the tail of the session and, at the same time, as a row in Needs you; answering either
resolves the other. Drawn on "Needs you, phone and desktop", "System" (the five buttons, busy
"Allowing") and "States" (decided).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/ask-item.js` (work/chat); phone sheet `deck/js/need-sheet.js` (work/pwa) | partial |
| App | `apps/app/src/session/Rows.tsx` AskCard (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/AgentDeskView.swift` HeldCardView (work/capsule-pro) | partial |

Built once: this card is built once in chat-core for the web (the Deck and the PWA) and Expo (the
app), from this spec, and the Capsule mirrors the same spec in Swift. No surface draws its own
version (cohesion, ADR 0036).

## Anatomy

A neutral card: `--panel`, 1 px `--rule`, radius `--radius-card` (12; phone `--radius-card-phone`
10). The attention colour is only the dot and the label.

1. **Header**, 44 tall, padding 0 16: needs-you dot (8, `--beacon-dot`), label "Permission" (meta
   600, `--beacon-ink`), then right-aligned "kit · 14:40" (meta, `--label`).
2. **Title**, base 600: "kit wants to run a command" (or "edit src/intake/estate.ts", "fetch
   app.northwind.test").
3. **Command block**: JetBrains Mono 13/18 on `--code-bg`, radius 8, padding 8 12, `--text`, wraps.
   An edit shows a diff instead (see diff); a write shows the path and a 12-line preview.
4. **Reason**: base, `--text-2`, one or two lines, from the agent's description of the call.
5. **Footer**, padding 12 16, 1 px `--rule` top, gap 8:
   - **Allow once** `A`: primary (`--primary-bg`, `--primary-ink`), key hint inside.
   - **Always in Harlow Legal**: outline (1 px `--rule-strong`, `--text`). Shown only when the ask
     offers a project rule; "Always for this" when it offers a plain rule.
   - **Deny** `D`: ghost (no border), key hint inside.

## Variants

- **Inline** in a session (above).
- **Detail pane** in Needs you on the desktop: same card, with "Why kit wants to" (label, prose in
  `--text-2`, "From the session "Q3 report" · 14:10" in meta) under it, and "Open session" ghost in
  the pane header.
- **Phone sheet** (from a Needs row tap): buttons stack full width: Allow once 54
  (`--control-touch-lg`, radius 12), then Always in Harlow Legal and Deny at 44, radius 10.
- **Elsewhere**: an ask on a paired Mac that the box cannot forward: no buttons, one line with the
  laptop icon, "Answer it on alex's MacBook Pro".

## Sizes

Buttons 32 (`--control-sm`) on the desktop, 28 in a compact Capsule row; 54 and 44 on the phone.
Text: title base 13 desktop, read 17 phone; command mono 13 on both.

## States

- **Open**: as above. Keys go to the focused card, else the newest open one, when focus is not in
  a text field.
- **Busy** (per button): the pressed button keeps its width, shows the spinner and a verb:
  "Allowing", "Saving rule", "Denying". The other two are disabled (label ink on no fill).
- **Deny with a note**: clicking Deny opens a field "Tell kit why (optional)" with Deny (ghost) and
  Back; Enter denies with the note, Esc goes back. The D key denies at once without a note.
- **Answered**: buttons leave, the dot and violet label leave; a neutral glyph (check or x, 16) and
  "Allowed once by you · 14:22", "Always allowed in Harlow Legal", "Denied by you · 14:25".
- **Answered elsewhere**: "Answered from the Capsule · 14:31" under the outcome.
- **Withdrawn** (the turn was stopped): "Withdrawn" with the x glyph, `--label`.
- **Error**: the buttons come back; one line under them in `--text` with the failed mark, in plain
  words ("The box did not answer. Try again."). No red.
- **Offline**: the answer goes to the outbox; the card shows "Allowed once · sends when back
  online" with Undo for 4 s.

## Keyboard and touch

- `A` allow once, `D` deny, Enter also allows once. No proof: answering an ask never asks for Face
  ID or Touch ID.
- Phone: swipe right on the Needs row approves (bone reveal), left denies, each with Undo 4 s.

## Motion

Answer: the card collapses to its answered line on the commit frame (optimistic, through the
outbox). Busy spinner stops under reduced motion.

## Copy

"Allow once", "Always in <project name>", "Deny", "Allowing". Never "Approve" for an ask, never
"Yes/No", never caps.

## Accessibility

- `section` with `aria-label="Permission ask from kit"`; focusable (`tabindex=0`) so keys route.
- Key hints are `aria-hidden`; buttons carry `aria-keyshortcuts="A"` and `"D"`.
- Busy button: `aria-busy="true"`, label "Allowing".

## Gaps

Deck (work/chat, work/pwa)
- [ ] `.cv-ask.ask-card` fills `--beacon-wash` (a violet wash); spec: `--panel` with `--rule`.
- [ ] Title weight 500; spec: 600.
- [ ] "Always in" is a ghost button; spec: outline.
- [ ] No per-button busy verb; all three disable with no spinner.
- [ ] Phone sheet primary reads "Approve" and key hints read ⏎/esc (work/pwa); spec: "Allow once", A and D.

App (work/mobile)
- [ ] Border turns `--beacon` while open; spec: neutral border.
- [ ] Allow once and Deny only; no Always in the project, no reason, no busy state.

Capsule (work/capsule-pro)
- [ ] Buttons read "Allow" and "Deny"; no "Always in <project>", no reason line.
- [ ] Label "HELD FOR YOU" in mono caps, tracked; spec: "Permission", sentence case.
