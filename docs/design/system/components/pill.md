---
title: Pill
summary: The one floating status pill for a box that does not answer, and the quiet queued line for what waits in the outbox; never a wall.
audience: builders
owner: app-design
status: draft
---

# Pill

When the box stops answering, content stays on screen and one small pill says so, top centre,
over the page. What you send meanwhile waits in the outbox and says so on a quiet queued line
where you sent it. Drawn on the boards "States, every list, every size" (Offline and
reconnecting) and "Planner, phone and desktop".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/reconnect.js`, `deck/js/pwa.js` `.reach`, `deck/css/deck.css` (work/pwa); `deck/chat/chat.css` `.cv-queued-row` (work/chat) | partial |
| App | `apps/app/src/state/connection.ts` (work/mobile): state only, nothing drawn | partial |
| Lumen | `local/capsule/native/Sources/UI/AgentDeskView.swift` OfflineBanner (work/capsule-pro) | partial |

## Anatomy

**Pill.** Height 28 (`--control-xs`), padding 0 12, radius 14 (`--radius-full`), fill `--panel`,
1 px `--rule-strong`, shadow `--float`, gap 8. Content: a 14 spinner (or a 12 no-signal icon),
the words in meta size `--text-2`, and after 60 s a middle dot in `--label` and "Retry now" in
600 `--text` (the whole pill is the button then). One line, no wrap.

Position: fixed, top centre of the content column, 8 below the top bar (desktop) or the phone
header, `z-index` above the page and below sheets. It floats over content; nothing moves down.

**Queued line.** Inline, right-aligned under the message or control it belongs to: a 12 clock
icon and meta size `--label`, gap 6: "Queued · sends when the box is back". Under a thread, one
meta line in `--label` says what this device kept: "Outbox 1 · this thread was saved on this phone
at 14:02". An answer given offline reads, in its card footer, "Will send when online" (600, clock
icon) with the presence line under it (see presence-line).

## States

Reads `link.health {reach: "direct"|"relay"|"none", why, since, fix?: {action, label}}` (C5,
agreed with native-core, tailnet, windows and pwa in CHAT.md, 30 Sep - this replaces the pill's
own earlier elapsed-time-only logic below the table, kept here as history since the timer
mechanics still apply, just driven by `since` instead of a locally started clock):

| `reach` | Pill |
|---|---|
| `direct` | nothing (the healthy case, matching the old "stream open" row) |
| `relay`, first 60 s | nothing - a failover that resolves quickly stays quiet, unchanged from before |
| `relay`, after 60 s | the quiet note, no icon colour change: "Through the relay" (meta, `--text-2`), no spinner, no urgency - this is working, just slower |
| `none`, before the first failed retry | nothing |
| `none`, after the first failed retry (~2 s) | spinner, "Reconnecting…" |
| `none`, 60 s since `link.health.since` | no-signal icon, "No answer from the box since 14:02" (the literal time, computed from `since`, not a guess) - plus `fix.label` as part of the pill (the whole pill becomes the button, e.g. "Turn on Tailscale") when `fix` is present, else "Retry now" as before |
| `why` present | shown as the pill's second line, tap/hover to expand from the collapsed one-liner - tailnet/native-core supply it pre-written, never a raw error string |
| Phone width, 60 s | "No answer since 14:02 · Retry now" (or `fix.label`), one line |
| The device has no network | no-signal icon, "This phone is offline" ("This Mac is offline") - a local fact, not read from `link.health` |
| Retry now / `fix.label` pressed | spinner, "Reconnecting…", the 60 s clock restarts |
| Back to `direct` | the pill fades out; queued lines send in order and each turns into its sent state |

The words change once at 60 s by one timer started when the pill shows (or reset on retry), never
an interval.

## Motion

In and out: opacity and 4 px of translate over `--motion-panel` (220), `--ease`. The spinner
stops under reduced motion; the pill then fades only.

## Keyboard and touch

The pill is a button only once it offers Retry now (44 tall hit area on the phone, the drawing
stays 28). Before that it is status text, not focusable.

## Copy

"Reconnecting…", "No answer from the box since 14:02", "Retry now", "Queued · sends when the box
is back", "Will send when online", "Outbox 1 · this thread was saved on this phone at 14:02".
Held items and the vault are never cached, so their pages say "Needs you needs the box." and
"The vault opens only when the box answers" instead. Never "Connection lost", "Error", "You are
offline!" or a full-screen wall; never red or amber.

## Accessibility

`role="status"`, polite. Announce "Reconnecting" once, then "No answer from the box since 14:02"
once; do not re-announce the same words. Retry now is a real button with that name. The queued
line is text beside the item, read with it.

## Gaps

Deck (work/pwa, work/chat)
- [ ] The reconnect state draws as `.reach`, a full-width line above the view with a bottom rule;
      make it the floating pill.
- [ ] 60 s words read "Reconnecting since 14:32"; use "No answer from the box since 14:02 ·
      Retry now".
- [ ] `.cv-queued-row` is a dashed bordered box for a queued chat message; the offline queued
      line is the plain clock and words above.

App (work/mobile)
- [ ] `toConnection` and the outbox list exist; no pill or queued line is drawn.

Lumen (work/capsule-pro)
- [ ] OfflineBanner is a 30 tall line with "OFFLINE" in caps and "vyred is not running on this
      Mac. Start it with vyre up."; use the pill words, sentence case, no caps label.
