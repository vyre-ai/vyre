# ADR 0025 · The planner: time, alarms, reminders, todos, notes and a calendar on the box

Status: proposed, 27 Sep 2026 · Workstream: planner (module `planner`, `core/planner`) · Spec: sections 2, 5, 9

## The problem

Alarms, reminders and todos live on the Mac today, in Apple's apps. When the Mac sleeps, is
closed or is broken, nothing rings. The box is always on, so the box should keep time, keep the
user's calendar and todo list, and ring whatever device is up: the phone, the Capsule on the Mac,
the Deck in a browser. Every surface should be able to add, snooze and finish the same items.

## Decision

1. **One core module, `planner`, owns time-based items.** It runs on both roles. On the box it
   is the source of truth. On a Mac paired with a box, its tools forward to the box
   (`ctx.remote`) and its own scheduler stays idle; an unpaired Mac runs it standalone.
2. **One store, `planner_*` tables, one item shape.** Kinds are `alarm`, `timer`, `reminder`,
   `todo`, `note` and `event` (the planner's own calendar). Every item may link a `project` and a
   `thread`. Todos have a `list`, a `priority` (0 to 3), a `due`, `done` and subtasks (`parent`).
   Notes are markdown with `pinned` and `tags`. Deleting is a soft delete for 30 days.
3. **Time is stored as UTC plus a zone.** An item keeps `at` (UTC ms) and `tz`. Repeating items
   keep the wall time (`07:00`), the rule and the zone, and the next time is computed in that
   zone, so a daily 07:00 stays 07:00 across a DST change. Alarms and timers are *floating* by
   default: they follow `planner.timezone` from config, the way a phone alarm follows you when you
   travel. Reminders and events are fixed to the zone they were made in unless `floating: true`.
   Changing the zone recomputes every floating item.
4. **One timer, no polling.** The scheduler holds a single `setTimeout` to the earliest due
   moment (fire, escalation or calendar sync), recomputed on every change. The wait is capped at
   6 hours, so a clock that jumps is noticed. When the timer wakes, the scheduler compares the
   clock with what it expected; a jump over 60 s is logged as drift and everything is recomputed.
   Nothing runs more often than every 60 s. `now()` is injected, so tests use a fake clock.
5. **Missed while offline.** At start, anything that fell due while vyred was down fires once,
   marked `missed: true`. A repeating item fires once for the latest missed time, not once per
   missed day. Items more than 24 hours stale are recorded as missed without ringing.
6. **A firing goes to every live channel, once each.** A due item makes a *firing*
   (`planner_firings`) and the event `planner.fired`. From that one event:
   - the `push` module sends Web Push to every subscribed device (kind `planner`);
   - the Capsule on a paired Mac sees it on the box's event stream (`/v1/link/events`);
   - the Deck sees it on `/v1/events/stream`.
   The firing id is the dedupe key: push uses tag `planner-<firing>`, so a second ring replaces
   the first on the same device, and the Capsule and Deck keep one banner per firing.
7. **Escalation.** A firing nobody acknowledges rings again after `escalate_after` minutes (5 by
   default), up to `escalate_max` times (3). Each ring is `planner.fired` with `ring` counting up.
8. **Acknowledgement from anywhere.** `planner.done`, `planner.snooze` and `planner.dismiss` take
   a firing id or an item id from any surface, the push notification's actions included. The
   first acknowledgement wins; it stops escalation and emits `planner.acked`, which tells the
   other surfaces to drop their banner.
9. **Push stays content-free (ADR 0011).** The push payload for kind `planner` has a fixed
   title per item kind ("Alarm", "Reminder", "Timer finished", "Starting soon", "Todo due") and a
   path `/planner/<firing>`. The label the user typed never crosses the push service. Alarms and
   timers ring through quiet hours (the user set them); reminders and todos respect quiet hours.
10. **Email and SMS fallback are off.** A later option: if no surface acknowledges after the last
    ring, send a message. It is outbound, so it goes through the Gate and needs the user to turn
    it on. Not built in the first slice.
11. **Calendar: an own calendar plus read-only copies.** Items of kind `event` are the
    planner's calendar. Connected Google calendars are read through the google module's tools
    (`google.calendar.list`), never its tokens, every 15 minutes while any account is connected,
    and cached in `planner_calendar`. The agenda merges both. Each timed event gets a reminder
    (10 minutes before by default) that feeds the scheduler. Making an event on a connected
    calendar calls `google.calendar.create`, whose invite sending is held at the Gate.
12. **Who may call.** People's surfaces (`cli`, `local`, `deck`, `capsule`) may use every tool.
    Agents (`mcp`, `module`) may read the agenda and items and add or change todos, reminders and
    notes. Anything that leaves the box goes through the Gate as it does today.
13. **Natural language stays on the surface side.** `planner.parse` turns "alarm 7am",
    "timer 10 min", "remind me to call the printer at 6" into a proposed item with a resolved
    time, using the same time words as the Capsule's apps router. Apple Clock, Notes and
    Reminders become optional adapters in the Capsule, not the default.

## Contract

Tools: `planner.add`, `planner.list`, `planner.get`, `planner.update`, `planner.done`,
`planner.snooze`, `planner.dismiss`, `planner.delete`, `planner.agenda`, `planner.parse`,
`planner.settings`, `planner.calendar.sync`, `planner.calendar.create`.

Events (all carry `item`, the item id; titles are the user's own words and stay on their devices):

| Event | Payload |
|---|---|
| `planner.added` | `{ item, kind, title, at? }` |
| `planner.changed` | `{ item, kind, fields }` |
| `planner.removed` | `{ item, kind }` |
| `planner.fired` | `{ firing, item, kind, title, due, ring, missed, actions: ["done","snooze"] }`; a connected calendar's event also carries `account` and `start`, and its `item` is the cache row id (`c_...`) |
| `planner.acked` | `{ firing, item, action: "done"\|"snooze"\|"dismiss", by, until? }` |

Calendar tools and the agenda:

| Tool | Input | Output |
|---|---|---|
| `planner.calendar.sync` | `{}` | `{ synced_at, accounts: [name], events, added, changed, removed, errors?: [{ account, error }] }` |
| `planner.calendar.create` | `{ title, start, end?, where?, attendees?, account?, tz?, why?, project?, thread? }` | no account: the planner's own event (an item of kind `event`); with account: what `google.calendar.create` returns, `{ event }` or `{ held, message }` |
| `planner.agenda` | `{ from?, to?, busy?, next? }` | `{ tz, from, to, entries, todos }`; `busy: true` gives `{ tz, from, to, busy: [{ start, end }] }`; `next: n` gives `{ tz, from, entries }` (the next n from now) |

An agenda entry: `{ source: "planner" | <account name>, item, kind, title, at, start, end, all_day,
where, url, ... }`; a calendar entry also has `account` and `event` (Google's id). People may use
`planner.calendar.create` in full; an agent may only ask for an invite (an account and attendees),
which the google module holds at the Gate.

Push payload (kind `planner`): `{ kind: "planner", title, path: "/planner/<firing>", tag:
"planner-<firing>", at, actions: ["done", "snooze"] }`. A notification action posts
`planner.done` or `planner.snooze` with `{ firing }`.

## Consequences

- An alarm rings when the Mac is off, as long as the box and one device are up.
- The lock screen shows "Alarm", not the label. Showing labels would need its own opt-in.
- A box with the wrong clock rings at the wrong time. The box image keeps NTP on; the drift
  check logs a jump but cannot fix the clock.
