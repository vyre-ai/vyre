---
title: Agenda
summary: The day agenda with hour rows, event blocks and the now line, plus the ringing card, the missed banner and the phone's firing screen.
audience: builders
owner: app-design
status: draft
---

# Agenda

Today at a glance: your events and read-only Google events on an hour grid, reminders and todos
due as thin chips at their time, and a now line. When something fires it rings on every device
and the first answer clears it everywhere. Drawn on "Planner"; Today also appears on Now on the
phone.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/views/planner.js`, `deck/css/views/planner.css` (main) | partial |
| App | none in `apps/app` (work/mobile) | not built |
| Lumen | `Host/Planner.swift` under `local/capsule/native/Sources/` (work/capsule-pro), banner only | partial |

## Anatomy

**Today card** (`card`): header 44 with "Today" (12/600 `--label`) and the status "Live" (a
`--focus` dot, 12 `--text-2`) at the right.

1. **All-day strip**, padding 0 16, bottom 1 px `--rule`: "All day" 12 `--text-2`, the title
   13/600 truncating, the source 12 `--text-2` ("Google · work · read-only").
2. **Grid**: two columns, 52 px of hour labels and the lane; padding 0 12 0 16. Each hour is 48
   tall with a 1 px `--rule` top line; the label is 12/16 `--label`, 2 from the top, "09:00".
3. **Event block**, positioned by time (top = minutes from the first hour × 48 / 60; height = the
   duration, minimum 46): radius 8, `--hover`, padding 6 10, gap 2. Line one: title 13/600
   truncating and "11:00 to 12:00" 12 `--text-2`. Line two: the source or place 12 `--text-2`,
   and "Join" (12/600 link) when there is a meeting link.
4. **Current event**: inset 1 px `--focus` and `--signal-wash`.
5. **Held invite** on an event: the needs dot and "Invite held in Needs you" in `--beacon-ink`.
   This is the only violet on the agenda.
6. **Point items** at their minute: a ringing reminder is 24 tall, radius 6, `--panel`, inset 1
   px `--focus`, padding 0 10: the running ring, "Reminder · Chase the Harbor Cafe invoice" 12,
   "from kit" 12 `--text-2`. A todo due is 22 tall with inset 1 px `--rule-strong` and a 12 px
   checkbox icon: "Todo due · Send Q3 report" and "17:00".
7. **Now line**: 2 px `--focus`, from 6 px into the hour gutter to the lane's right edge.

**Ringing card** (desktop, beside the agenda): `card` with border `--focus`, padding 12 16 10:
the ring, "Reminder · 14:00" 12 `--text-2`, the title 13/600, "Ringing again · 2 of 4 · from
kit" 12 `--text-2`; then Done (primary 28), Snooze 9 min (secondary 28), Dismiss (ghost 28).

**Missed banner**: `banner`, column, padding 10 16 12: alarm icon, "Missed while the box was
down" and "Alarm · 06:30 · Early bake" 12 `--text-2`; Done (secondary 28), Dismiss (ghost 28).

**Phone firing screen** (full screen): icon tile 40, "Reminder · 14:00" 13/600 `--text-2`, the
title at 22/600, "from kit" 13 `--text-2`, the ring and "Ringing again · 2 of 4 · on 3 devices";
three 54 buttons stacked: Done (primary), Snooze 9 min (secondary), Dismiss (ghost); then "Rings
on every device. The first one you answer clears the rest." (13 `--text-2`) and "If nobody
answers, it rings again every 5 min, 4 rings in all." (12 `--label`).

**Phone Today list**: `ph-card` rows: time 13 `--text-2`, title 17, meta 12 `--label`; a ringing
row's title is 600 and its meta reads "Reminder · ringing on this device · from kit".

## States

- **Ring count**: "Ringing again · N of M", where M = 1 + `escalate_max` (default 3, so 4) and
  rings repeat every `escalate_after` minutes (default 5), both from `planner.settings`. The first
  ring reads "Ringing now". With `escalate_max` 0 there is no count. Events ring once, never
  again.
- **Live** shows only while the stream is connected. Offline, the pill takes its place and each
  device still rings from its own 48 h schedule.
- **Missed**: rings that fell due while the box was down come back as the missed banner.
- "from kit" shows only when an agent other than the assistant added it.
- Empty day: "Nothing today" and the quick-add field stays (see states).

## Keyboard and touch

Desktop: with the ringing card focused, D is Done, S snoozes, Esc dismisses (proposed). Blocks open
their item on click or Enter. Phone: rows 44 minimum; the firing screen's buttons are 54.

## Motion

The now line moves once a minute, no animation. A new ringing card slides in over
`--motion-panel`; the answer clears it on tap through the outbox with a 4 s Undo. The running ring
spins; it stops under reduced motion.

## Copy

- "Today", "All day", "Live", "Join", "Invite held in Needs you", "Ringing now", "Ringing again ·
  2 of 4", "Snooze 9 min", "Missed while the box was down".
- Lock screen push: a fixed title ("Alarm", "Reminder"), never your words unless labels are on.
- Never "Overdue!", never colour for late.

## Accessibility

- The grid is a `list` of events in time order for screen readers ("Supplier call, 11:00 to
  12:00, Google work, read-only"), not a table of empty hours.
- The ringing card is `role="alert"` once per ring; the firing screen's title is the heading.

## Gaps

Deck (main)
- [ ] No hour grid, event blocks or now line; the agenda is rows.
- [ ] The firing banner labels the ring " · ring 2" in beacon, not "Ringing again · 2 of 4" in `--text-2`.
- [ ] Snooze has no duration in its label, and there is no Dismiss.
- [ ] No "Live" status; no missed banner copy "Missed while the box was down".

Lumen (work/capsule-pro)
- [ ] The banner says "Missed: Timer"; no ring count.

App (work/mobile)
- [ ] No planner.
