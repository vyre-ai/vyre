---
title: "ADR 0025: The planner on the box"
summary: Alarms, timers, reminders, todos, notes and a calendar kept on the box with one scheduler, delivered to push, the Capsule and the Deck, and open to agents.
audience: builders, agents
owner: docs
status: draft
---

# ADR 0025: The planner on the box

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
   other surfaces to drop their banner. The push module then sends every device a push with
   only `{ kind: "planner-ack", tag }` for a firing it had pushed, so the notification closes on
   phones with no page open. Done and Snooze need no presence proof.
9. **Push stays content-free (ADR 0011).** The push payload for kind `planner` has a fixed
   title per item kind ("Alarm", "Reminder", "Timer finished", "Starting soon", "Todo due") and a
   path `/planner/<firing>`. The label the user typed never crosses the push service unless the
   user turns on `push.settings { planner_label: true }` (off by default), which adds it as the
   notification's `body` for the lock screen. Alarms and timers ring through quiet hours (the
   user set them); reminders and todos respect quiet hours.
10. **Email and SMS fallback are off.** A later option: if no surface acknowledges after the last
    ring, send a message. It is outbound, so it goes through the Gate and needs the user to turn
    it on. Not built in the first slice.
11. **Calendar: an own calendar plus read-only copies.** Items of kind `event` are the
    planner's calendar. Connected Google calendars are read through the google module's tools
    (`google.calendar.list`), never its tokens, every 15 minutes while any account is connected,
    and cached in `planner_calendar`. The agenda merges both. Each timed event gets a reminder
    (10 minutes before by default) that feeds the scheduler. Making an event on a connected
    calendar calls `google.calendar.create`, whose invite sending is held at the Gate.
12. **Who may call (the user's rule).** Anyone, a person or an agent, adds alarms, timers,
    reminders, todos and notes with no permission, prompt or Touch ID. The person (`cli`, `local`,
    `deck`, `capsule`, their own devices over the tailnet) edits, completes, snoozes and deletes
    any item with no prompt. An agent (`mcp`, `harness`, `module`) changes only the items it added,
    and never adds an event: an event with other people is an invite, held at the Gate through
    `planner.calendar.create`. Each item keeps its `source` (the caller: `cli`, `mcp`,
    `agent:<name>`, `module:<name>`) and shows `added_by` (the agent's name) only when it was
    neither the person nor their assistant (an unnamed MCP session, or the agent whose kind is
    assistant). A paired Mac forwards an agent's call with `as: { source, name }`, honoured only
    on a person's call (the Mac's link arrives as the owner), so the box applies the agent's
    rules. A silent guard stops one agent after 200 adds in an hour (code `busy`); it is not a
    limit anyone should meet and is not shown. Settings stay the person's.
13. **Natural language: one parser.** `planner.parse` (core/planner/parse.js) turns "alarm 7am",
    "timer 10 min", "remind me to call the printer at 6" into `{ kind, title, at (UTC ms), tz,
    duration?, repeat? }`, `{ ambiguous, reason }` when the words cannot be placed, or null. It
    takes `kind` as a hint and holds the Capsule's apps router's tested time rules. A time said
    first ("6pm call Harlow Legal") is a reminder. planner.add's `at` takes the same words ("6pm",
    "tomorrow at 9", "in 20 minutes"), read in the item's zone. It is pure and
    answers on the Mac where it is asked, never forwarded to the box; only writes forward. Apple
    Clock, Notes and Reminders become optional adapters in the Capsule, not the default.

## Contract

Tools: `planner.add`, `planner.list`, `planner.get`, `planner.update`, `planner.done`,
`planner.snooze`, `planner.dismiss`, `planner.delete`, `planner.agenda`, `planner.upcoming`,
`planner.parse`, `planner.settings`, `planner.calendar.sync`, `planner.calendar.create`,
`planner.ringing`.

The ring key (ADR 0029, R6): `planner-<item>-<due>`, `due` in epoch seconds, names one ring of an
item at one moment. `planner.fired`, `planner.acked`, `planner.ringing`, `planner.upcoming` and the
push all carry it. `planner.done`, `planner.snooze` and `planner.dismiss` take `{ key }` as well as
`{ firing }` or `{ item }`: a device that rang a moment from its own schedule while the box was out
of reach answers by key, and the box records the answer (`unrung: true` on the ack) and never rings
that moment. A repeat answered by key again is `{ already: true }`.

Events (all carry `item`, the item id; titles are the user's own words and stay on their devices):

| Event | Payload |
|---|---|
| `planner.added` | `{ item, kind, title, at? }` |
| `planner.changed` | `{ item, kind, fields }` |
| `planner.removed` | `{ item, kind }` |
| `planner.fired` | `{ firing, key, item, kind, title, due, ring, missed, actions: ["done","snooze"] }`; a connected calendar's event also carries `account` and `start`, and its `item` is the cache row id (`c_...`) |
| `planner.acked` | `{ firing, key, item, due, action: "done"\|"snooze"\|"dismiss", by, until?, unrung? }` |
| `planner.schedule` | `{ reason: "settings" \| "calendar" }`: the rings moved without an item changing (a zone or lead change, a calendar sync that changed the copy) |

Calendar tools and the agenda:

| Tool | Input | Output |
|---|---|---|
| `planner.calendar.sync` | `{}` | `{ synced_at, accounts: [name], events, added, changed, removed, errors?: [{ account, error }] }` |
| `planner.calendar.create` | `{ title, start, end?, where?, attendees?, account?, tz?, why?, project?, thread? }` | no account: the planner's own event (an item of kind `event`); with account: what `google.calendar.create` returns, `{ event }` or `{ held, message }` |
| `planner.upcoming` | `{ hours? }` (48 by default, 1 to 72) | `{ tz, from, to, last_event, entries: [{ key, item, kind, title, due (s), at (ms), loud, snoozed?, start?, account?, added_by? }] }`: every ring the box expects, less what is answered or ringing. A device schedules these as local notifications and refreshes on any planner event but `planner.fired`, and on foreground |
| `planner.agenda` | `{ from?, to?, busy?, next? }` | `{ tz, from, to, entries, todos, last_event }`; `busy: true` gives `{ tz, from, to, busy: [{ start, end }] }`; `next: n` gives `{ tz, from, entries }` (the next n from now) |

An agenda entry: `{ source: "planner" | <account name>, item, kind, title, at, start, end, all_day,
where, url, ... }`; a calendar entry also has `account` and `event` (Google's id). People may use
`planner.calendar.create` in full; an agent may only ask for an invite (an account and attendees),
which the google module holds at the Gate.

`planner.list` and `planner.ringing` take `cursor: true` and then return `{ items, last_event }`
and `{ ringing, last_event }`: the event cursor the read is current to (ADR 0029, R1).

Push payload (kind `planner`): `{ kind: "planner", title, path: "/planner/<firing>", tag: <key>,
item, due (s), at, actions: ["done", "snooze"], body? }` (body only with planner_label on). Native
pushes use the key as `apns-collapse-id` and the Android notification tag. A notification action
posts `planner.done` or `planner.snooze` with `{ firing }` (or `{ key }` for a local ring). On an
ack: `{ kind: "planner-ack", tag: <key>, at }`, normal urgency, sent once per pushed firing and for
every `unrung` answer.

## Consequences

- An alarm rings when the Mac is off, as long as the box and one device are up.
- The lock screen shows "Alarm", not the label. Showing labels would need its own opt-in.
- A box with the wrong clock rings at the wrong time. The box image keeps NTP on; the drift
  check logs a jump but cannot fix the clock.

## Amendment (5 Oct 2026): the planner is built on Vyre Records

The user decided the planner has no place of its own. Its data is the Space's records, with one mechanism for each part:

- Alarms, timers, reminders and `/later` tasks are `reminder` records; notes are `note` records. Both are plain record types the module declares (`needs.kernel.types`), so Records lists them and a Kit can link to them. Times a person reads (`at`, `snooze_until`, `done_at`) are datetimes; the engine's own moments (`next_fire`) are numbers.
- Todos are the kernel's Tasks, assigned to the person (doer: the owner, output: a note). What a Task has no field for (list, priority, tags, pinned, project, repeat) rides in the Task's `form.planner`. The kernel's Tasks gained `edit` (words, note, due time, form, parent: the doer, a person, or whoever assigned it), `reopen` (done or skipped, no checker, no outward act) and `parent` (a sub-item); `task.edited` and `task.reopened` are events, and done and skipped stay terminal in the transition table (reopen is its own act, `TASK_REOPENS`). A repeating todo is a series: finishing one makes the next. The person may give a todo to an assistant (`assignee`), which then finishes it as its doer; a todo an assistant made for the person is the person's to finish, which the kernel enforces.
- The calendar is the Space's `event` records: a connector's sync writes them, and the planner's own events are made as source `vyre`. The planner keeps no copy of any calendar (`planner_calendar` is gone) and no poll: it reads a window (a day back to 14 days ahead) and follows the kernel's `event.*` events.
- Rings (`planner_firing`) and settings (`planner_state`) are system record types.

The scheduler stays in the engine. It reads a working set loaded from the records at start, so every ring is as exact as before, and every change is queued to the gateway in order (a tool answers once it is saved). A record changed from outside is read back through the kernel's `reminder.*`, `note.*`, `task.*` and `event.*` events. `planner.fired`, `planner.acked`, the ring keys and the box ringing when the Mac is shut are unchanged. The planner needs the kernel; with it off every tool but `planner.parse` answers `unavailable`. `planner_items`, `planner_firings`, `planner_calendar`, `planner_state` and their migrations are deleted; there was no data to migrate. Decisions 1 to 11 above that name those tables describe the earlier store.
