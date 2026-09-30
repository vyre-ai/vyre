---
title: Status mark
summary: The five status marks (needs you, failed, running, unread, done), the needs-you badge and the neutral count, one model on every surface.
audience: builders
owner: app-design
status: draft
---

# Status mark

One status model, most urgent first, drawn the same way on rows, tabs, the rail, the favicon, the
app badge, Lumen's mark and the CLI. Drawn on "Vyre one app, the system" (Status, one
model) and on every list board; the 99+ cap on "States, every list, every size".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.dot.*` (main); `deck/chat/chat.css` `.cv-state-*` (work/chat) | partial |
| App | `apps/app/src/ui/StatusMark.tsx` `StatusMark` (work/mobile) | partial |
| Lumen | `local/capsule/native/Sources/UI/AgentDeskView.swift` WaitingRow, `UI/CapsuleView.swift` ToolRows and Pulse, `Host/MenuBarItem.swift` (work/capsule-pro) | partial |

## Anatomy

Order when several apply (the most urgent wins, one mark per row): needs you, failed, running,
unread, done. The source is `tokens.json` `status`.

| Status | Mark | Colour | Word |
|---|---|---|---|
| Needs you | 8 solid dot | `--beacon-dot` | needs you |
| Failed | the failed icon at 12 (circle r 6 with a cross, 1.5 stroke) | `--text-2` | failed |
| Running | 10 ring, 1.5 stroke, no fill, plus the elapsed time beside it | `--focus` | running |
| Unread | 8 solid dot | `--text` | unread |
| Done | 8 hollow dot, 1.5 inset stroke | `--label` | done |

**Status word.** Beside a mark, the `.st` line: gap 6, meta 12/16, `--text-2`, no wrap
("running · 4m", "failed · history", "waiting · plan"). Running always carries elapsed time, so
quiet work never looks stalled: under a minute "12s", under an hour "4m", then "1h 12m".

**Badge** (needs you only). Height 18, min width 18, padding 0 5, radius `--radius-full`, fill
`--beacon-dot`, ink `--beacon-badge-ink`, meta 12/16 weight 600, centred. Numbers 1 to 99, then
"99+". The exact number stays in the page header ("Needs you 128").

**Count** (neutral). Same geometry, fill `--hover`, ink `--text-2`. For any count that does not
wait on you: group sizes, changed settings, chips' totals.

**Path and presence dots** (not status). An 8 dot for how a device is reached: `--focus` solid
for a live direct path ("Tailscale · direct 12 ms"), `--label` solid for relayed or stopped
("Relay · 80 ms from the box"), `--label` hollow for none. Relayed is normal, never a warning.

Devices, hosts, agents and projects never get a colour. They are named ("alex's iPhone"), so a
colour can only ever mean status.

## Sizes

Dots 8 everywhere (14 only in the Settings attention-colour picker). Ring 10. Failed glyph 12.
Badge and count 18 on desktop and phone. On an avatar, a mark sits at the bottom right with a 2 px
ring of the surface colour behind it.

## States

- **Needs you empty.** No dot, no badge, and the mark's dot goes back to `--mark-dot`.
- **Selected row** (`--signal-wash`). Marks keep their colours; the word steps up to `--text-2`
  if it was `--label`.
- **Offline.** Marks show the last known status; no mark animates.
- **Where the model drives:** rail and phone page labels (badge), tabs (dot before the label),
  favicon and app icon badge (needs you count), the Mac mark and menu bar dot (beacon dot), the CLI
  (the same five words).

## Keyboard and touch

Not interactive. Marks never take focus; the row or tab does.

## Motion

Static. The ring does not spin (it is the running mark, not a spinner). A status change swaps the
mark with no transition. Only the elapsed time ticks, once a second under a minute, then once a
minute.

## Copy

The five words exactly: needs you, failed, running, unread, done. Session state words: starting,
idle, running, waiting, stopped, failed. Never "error", "warning", "alert", "urgent" or "!".
Failed never pushes a notification; it waits in the list.

## Accessibility

- Every mark has its word as its accessible name (`aria-label`, `accessibilityLabel`), unless the
  word is printed beside it, in which case the mark is hidden.
- Colour is never the only signal: each status has its own shape (solid, ring, cross, hollow).
- Badge: "3 need you" as its label, not "3". "99+" reads "more than 99 need you".
- Contrast: every mark colour must hold 3:1 against `--bg`, `--panel` and `--signal-wash` in
  both themes.

## Gaps

- [ ] Deck: no running ring, crossed circle or hollow done dot in `deck.css`; failed state words
  use `--beacon-ink` in `chat.css`; `.dot.recall` and relayed health dots use gold.
- [ ] Deck: rail count is violet text, not a badge; `.needs-pill` is a violet wash.
- [ ] Deck (work/pwa): the phone tab bar badge is 16 tall, 10 px text; use 18 and meta size.
- [ ] App: `StatusMark` has no badge, count or status word; done uses a 1 px border (1.5); the
  failed mark is a slashed circle, not the cross; no elapsed time on running.
- [ ] Lumen: waiting dot uses `Theme.attention` at 7 px; tool rows use SF Symbols; Pulse is a
  bone 7 px dot, not the ring; no badge; relayed health is not neutral.
