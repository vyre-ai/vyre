---
title: Capsule on the Mac
summary: The native Swift panel that opens with Control twice over any app, answers the Needs rows, streams the assistant's reply and queues offline.
audience: builders
owner: app-design
status: draft
---

# Capsule on the Mac

A floating panel, 680 wide, that opens over whatever you are doing when you press Control twice.
It asks the assistant or a targeted agent, answers the same Needs rows as the app with keys,
streams the reply, and keeps working offline. Native Swift; every colour and size comes from
`Tokens.generated.swift`, never a hand-typed value. Drawn on "The Mac Capsule and the CLI".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | not used | not used |
| App | not used | not used |
| Capsule | `UI/CapsuleView.swift`, `UI/AgentDeskView.swift`, `UI/PresenceView.swift`, `UI/Theme.swift`, `Host/Panel.swift`, `Host/Hotkeys.swift`, `Host/MenuBarItem.swift` under `local/capsule/native/Sources/` (work/capsule-pro) | partial |

## Anatomy

Panel: width 680, radius `Tokens.Radius.sheet` (14; the board draws 16, which no token holds),
fill `panel`, 1 px `ruleStrong`, the `--float` shadow (not in the Swift tokens yet; the generator should emit it). Centred horizontally on the active screen,
its top a fifth of the way down. Rows, top to bottom:

1. **Input row**, 56 tall, padding 0 16, gap 12, bottom 1 px `rule`: the mark (20), the input at
   the read size (15/22, `text`), placeholder in `label`: "Ask juno, @ to target, or run"; the
   "esc" key hint at the right.
2. **Sends to**, 12/16 `label`, padding 8 16: agent tile 24, "Sends to juno" in `text2`, then
   "· Northwind Bakery" (the project) and "@kit to target an agent". It names the target the
   moment an @ completes.
3. **The waiting list.** Group header 32: the needs dot, "Needs you" 12/600 `label`, then
   "2 · oldest first". Rows are the Needs row cut to one detail line: tile 32, title 13/600
   truncating, one line 12 `label` "Kind · agent · project · detail" (commands in mono), age at
   the right. The focused row has fill `signalWash` and shows its actions inline: Allow once
   (primary, 28, key A) and Deny (ghost, 28, key D) for asks; drafts show "⏎ review".
4. **Streaming reply.** Author row: tile 24, name 13/600, status ("running" with the running
   ring), then the thread and time 12 `label`. Prose 15/22 `text`, paragraphs 8 apart, the caret
   in `focus` while it streams.
5. **Footer**, 12/16 `label`, padding 10 16, top 1 px `rule`: the outbox icon and "Works offline
   · 1 queued" (only when something is queued or the box is away), then key hints "⏎ send",
   "⌘⏎ approve", "esc close".

**Confirm send** (replaces the body when a send needs a proof): the Touch ID glyph, "Confirm send"
15/600 and "kit · Harlow Legal · outbound email" 12 `label`; one sentence 13 with the address in
mono and the first words quoted; "Touch ID covers sends for 30 min" 12 `label`; buttons "Send with
Touch ID" (primary, with the fingerprint icon) and "Cancel" (ghost, esc).

## States

| State | What shows |
|---|---|
| Empty input, nothing waits | input row and footer only; no list header |
| Something waits | the waiting list; the menu bar mark's dot turns `beacon` |
| Row focused | `signalWash` fill, meta steps up to `text2`, actions inline |
| Streaming | caret, running ring; the list stays above it |
| Offline | footer "Works offline · 1 queued"; asks and drafts answered offline queue |
| Proof needed | Confirm send, as above; within 30 min of a proof it sends with no prompt and the footer says "Touch ID confirmed 12 min ago · covers sends until 15:02" |
| Decided | the row leaves on the frame the key commits; the undo lives in the app for 4 s |

Appearance follows macOS: `Tokens.dark` in dark mode, `Tokens.paper` in light.

## Keyboard and touch

- Control twice (two bare Control taps within 450 ms) opens and closes it; ⌥Space works without
  the Input Monitoring permission. Esc closes.
- ↑ ↓ move through the waiting list; A allows once, D denies, ⏎ opens a draft's card, ⌘⏎
  approves or sends. ⏎ in the input sends to the target.
- "@" completes agents and projects; "alarm 7am", "code northwind" and "glass kit" are typed
  commands the box already understands.

## Motion

Opens with opacity and a 6 pt drop over `Tokens.Motion.panel` (220 ms); closes over
`Tokens.Motion.reveal` (150). Streaming text reveals paced to the display. Reduce Motion: fade
only.

## Copy

- Placeholder: "Ask juno, @ to target, or run". List header: "Needs you". Footer: "Works offline ·
  1 queued". Proof line: "Touch ID covers sends for 30 min".
- Only sends, posts, payments and deletes outside ask for Touch ID. Allowing an ask never does.
- Never caps labels ("WAITING ON YOU", "OFFLINE"), never "Approve?" dialogs.

## Accessibility

- The panel is an accessibility group named "Vyre Capsule"; the input has the placeholder as its
  label. Each waiting row reads "Push q3-report, ask from kit, Harlow Legal, 9 minutes".
- Every action has its key in its accessibility hint. VoiceOver focus lands on the input on open.

## Gaps

Capsule (work/capsule-pro)
- [ ] `Theme.swift` maps tokens to old names and hand-types sizes (query 22, title 14, label
  10.5 mono, rows 40); only colours, status and `Radius.card` come from tokens.
- [ ] Placeholder reads "Search, calculate, ask, or @ a session".
- [ ] List header is "WAITING ON YOU · n" in mono caps in the attention colour; the focused row
  has a violet left bar instead of `signalWash`.
- [ ] Offline banner reads "OFFLINE" in caps, not "Works offline · 1 queued".
- [ ] Always dark; no `Tokens.paper`.
- [ ] Presence reads "Touch ID to approve exactly this." with no 30 min covered line.
- [ ] `AgentButton` primary is bone on graphite, radius 6, not lime `primaryBg`.
- [ ] Radius is `Tokens.Radius.card` (12), not `sheet`.
- [ ] `Tokens.generated.swift` has no shadow tokens, so `--float` cannot come from it yet.
