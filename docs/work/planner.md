# planner

Branch: work/planner · Worktree: ../vyre-planner · Decisions: [ADR 0025](../adr/0025-planner.md)

Scope: module `planner` (core/planner): alarms, timers, reminders, todos, notes and a calendar
on the box; one scheduler; delivery to push, the Capsule and the Deck; CLI verbs; a minimal Deck
view. Surfaces (phone, Capsule rows and banners, native apps, chat) are built by their teams on
the contract in ADR 0025.

## Done
- ADR 0025 drafted, number claimed.
- Slice 1 (core/planner): time.js (Intl zone math, DST gaps and repeats, repeat rules), store.js
  (planner_items, planner_firings, planner_calendar cache, planner_state), scheduler.js (one
  unref'd timer, 6 h cap, drift log, catch-up, escalation, snooze), index.js (11 tools, 5 events,
  agent limits, Mac forwarding when paired). parse.js is wired in by a guarded import.
- Delivery: push kind `planner` (see Changed contracts).
- Tests: core/planner/time.test.js (4), planner.test.js (11, fake clock), module.test.js (1, real
  vyred), and one push test. On the test box: 21 of 21 pass with
  `node --test core/planner/time.test.js core/planner/planner.test.js core/planner/module.test.js core/push/push.test.js`.
- Perf (the test box, load average about 9): scripts/perf-check with planner: CPU p95 0.00%, RSS mean
  120.0 MB, max 151.6 MB (budget 150; FAIL), no timer under 60 s. The same check on this branch
  without core/planner: RSS mean 132.3 MB, max 145.9 MB. RSS max is at the budget's edge either
  way and moves by more than the planner's share between runs. A vyred holding 1000 planner items
  (alarms, daily repeats, reminders, todos, notes), idle 60 s: CPU 0.00%, RSS mean 103.1 MB, max
  105.5 MB; adding them took 9.5 ms each over the socket; planner.agenda 16 ms.

## Doing
- Nothing in flight. Slice 1 is committed.

## Next
1. CLI: `vyre alarm`, `vyre remind`, `vyre todo`, `vyre notes`, `vyre agenda` (on planner.add/parse/agenda).
2. Calendar: planner.calendar.sync (google.calendar.list every 15 min as a scheduler wake hook,
   into planner_calendar), event reminders for cached events, planner.calendar.create through the Gate.
3. Minimal Deck view (panel:planner).
4. Later: email/SMS fallback after the last ring (off, through the Gate).

## Decisions made in slice 1 (not in the ADR text)
- escalate_max counts rings after the first: 3 means 4 rings in all.
- `due` for a todo is a date (YYYY-MM-DD) kept in its own column for the agenda; a due with a time
  also rings at that time (at). A todo due on a day with no time never rings.
- Items keep `date` (the local date of a one-off) beside `wall`, so a floating one-off alarm
  re-reads "07:00 on the 25th" in a new zone.
- planner.done on a repeating item with nothing ringing is done for this time round: it moves to
  the next occurrence. To stop a repeat: planner.update state cancelled, or planner.delete.
- planner.dismiss ends a one-off alarm, timer, reminder or event; a todo stays open.
- Deleting an item that is ringing cancels the firing and emits planner.acked (action dismiss) so
  surfaces drop the banner.
- A month or year repeat on a day a month lacks (the 31st, 29 Feb) rings on that month's last day.
- planner.calendar.sync and planner.calendar.create are not declared yet: they come with the
  calendar slice.

## Needs from others
- pwa: service worker handles push kind `planner` with `done`/`snooze` actions; Now shows agenda, todos, alarms, notes.
- capsule-pro / capsule-apps: banner on `planner.fired`, drop on `planner.acked`; "timer 10 min" and "alarm 7am" call `planner.add` by default.
- mobile, chat: read the same tools and events.
- switchboard (push owner): the `planner` kind in core/push (listed under Changed contracts).

## Changed contracts
- core/push/index.js (switchboard owns push): `planner.fired` maps to kind `planner` with a fixed
  title per item kind (alarm "Alarm", timer "Timer finished", reminder "Reminder", event "Starting
  soon", todo "Todo due"), path `/planner/<firing>`, tag `planner-<firing>`, `actions: ["done",
  "snooze"]` carried in the message. `planner` joins KINDS (push.settings can switch it off), is
  sent at high urgency, and alarms and timers ignore quiet hours while reminders and todos respect
  them. No title the user typed is ever in the payload. Test in core/push/push.test.js.
- docs/SPEC.md folder tree lists core/planner.
