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

- Calendar slice (core/planner/calendar.js): planner.calendar.sync reads google.calendar.list per
  account (a day back to 14 days ahead; a full page of 100 is read again in halves) into
  planner_calendar, drops what is no longer returned, keeps a failing account's copy, forgets a
  removed account, records synced_at. A scheduler wake hook syncs every 15 minutes while any
  account is connected and not at all otherwise; google.added and google.removed sync at once.
  Each timed cached event rings event_lead minutes before its start (kind event, with account and
  start), once per (account, event, start); all-day events never ring. planner.agenda entries carry
  source (planner or the account), start, end, all_day, where, url; `busy: true` and `next: n`.
  planner.calendar.create makes the planner's own event, or calls google.calendar.create (attendees
  held at the Gate). Tests: core/planner/calendar.test.js (6, fake clock, fake google over ctx.call).
  On the test box: 36 of 36 pass with `node --test core/planner/*.test.js core/push/push.test.js`.

## Done (later)
- Capsule path test over the link (38b26c1): a paired Mac forwards planner.add to the box and hears planner.fired and planner.acked on /v1/link/events.
- CLI (3e8bf28): vyre alarm, timer, remind, todo, notes, agenda, snooze.
- Calendar (80e071f): planner.calendar.sync every 15 min while Google is connected, event reminders, agenda busy/next, planner.calendar.create through the Gate.
- Minimal Deck panel (ee1b97d): /planner and /planner/<firing>, live banner, no polling.
- planner.ringing: what is ringing now, shaped like planner.fired, for surfaces that connect late.
- Tests on the test box: 58 of 58 across core/planner, push, the Deck panel and the CLI.

## Done (2026-09-27, session 3)
- Agent rule (1437a6b): anyone adds alarms, timers, reminders, todos and notes with no prompt;
  the person changes anything; an agent changes, finishes, snoozes, dismisses and deletes only
  what it added (item.source === its source); agents never add events; settings stay the
  person's. source is `cli`/`deck`/..., `mcp` (unnamed session), `agent:<name>`, `module:<name>`;
  `added_by` (migration 3, source_name) is the agent's name unless it is the assistant (read from
  agents.list, cached a minute) or an unnamed session. planner.added/fired/ringing carry
  added_by; the Deck shows "from kit". Silent cap: 200 adds an hour per source, code `busy`.
  A paired Mac forwards with `as { source, name }`, honoured only on a person's call; the old
  Mac-side checks (kindOnBox) are gone.
- One parser (1437a6b, subagent): parse.js returns { kind, title, at (ms), tz, duration?, repeat? }
  plus the old fields add() reads, { ambiguous, reason }, or null; `kind` hint; the capsule-apps
  router's rules and route.test.js time cases as fixtures (170f3dd). planner.parse is `local`:
  answers on the Mac, never forwarded. add() refuses ambiguous text (code `ambiguous`); a
  reminder at the current minute is accepted.
- Push (b8089dc): `planner-ack` { kind, tag } once per pushed firing on planner.acked, normal
  urgency; push.settings planner_label (off by default) adds the item's words as `body`.
- deck/sw.js (d54d2c1, pwa's file, smallest change): planner-ack closes the tag and shows
  nothing; `body` shown when present. Test in deck/test/pwa.test.js.
- Docs (96df03a): docs/using/planner.md (draft, owner docs) in the nav; ADR 0025 front matter and
  nav; reference regenerated. docs-check: only the 180 shots mtime warnings remain (not planner).
- Presence: confirmed no planner tool is on presence HUMAN_ONLY and none declares presence.
- cc-plugin's planner test (test/cc-plugin.test.js, real planner) passes against this branch.
- Tests on the test box: 63 of 63 (core/planner/*, push, deck planner + pwa, CLI planner).
- Perf (the test box, load average 16 to 19): CPU p95 0.00%, RSS mean 130.2 MB, max 155.7 MB
  (budget 150; FAIL as before, at the budget's edge with or without the planner).

## Done (2026-09-27, session 3, later)
- at in words (the lead's ask): "6pm", "tomorrow at 9", "7:30", "in 20 minutes" through the
  parser, read in the item's zone; Date.parse only with a year. parse reads "6pm call Harlow
  Legal" as a reminder. 65 of 65 on the test box. Main merged (650a1e5).

## Done (2026-09-27, session 4)
- RSS trim (6a04bc8, a5b8f44): the zone is read lazily, so an idle planner never loads ICU's
  zone data. The planner started on an empty store adds 4.0 MB RSS (was 11.5 MB), measured in
  isolation on the test box. perf-check at load 9.3: CPU p95 0.00%, RSS mean 131.9 MB, max
  154.2 MB (FAIL at max as before; the planner's share is now 4 MB, the rest is other modules).
- Resilience (ADR 0029, R6 and R1): ring key `planner-<item>-<due s>` on fired, acked, ringing,
  upcoming and the push tag (+ item, due); planner.upcoming (48 h of keyed rings, last_event);
  done/snooze/dismiss by key, including a ring the box never rang (recorded answered, never rung,
  ack `unrung: true` pushed as planner-ack); planner.schedule event on zone/lead change and a
  calendar sync that changed the copy; last_event on agenda/upcoming, list/ringing with cursor.
- Sessions (ADR 0030): `mcp:thread:<id>` counts as the assistant in the planner's ownership rule.
  The registry's callerKind does not strip `:thread:` yet (sessions owns it).
- Tests on the test box: 80 of 80 (core/planner/*, push, deck planner + pwa, cc-plugin), docs 61 of 61.

## Doing
- Nothing in flight. Resume from Next.

## Next
1. Answers from resilience, sessions, pwa, capsule-pro, mobile (sent 2026-09-27, session 4).
2. If sessions wants it: a planner rules text for the session's append prompt, and the in-process
   MCP tool list (planner.add/list/agenda/done/snooze/dismiss/upcoming; never settings).
3. CLI prints the parser's `reason` on ambiguous words (if the user wants it).
4. Email/SMS fallback (later, needs the user's go and the Gate).
5. Known limit: a planner-ack push goes out only for firings pushed since vyred started (and every
   unrung answer).

## Contracts owed
- None open. Sent: cc-plugin shapes, capsule-apps parse branch + hash, pwa presence + ack + label.

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

## Decisions made in the calendar slice
- Cache rows have a stable id `c_<hash(account, event)>`; a firing for a calendar event has that id
  as `item`. Dedupe: `rung_start` on the row, plus a firing with the same due for that id.
- A calendar ring does not escalate (it rings once, and again only when snoozed). An event that has
  begun by the time its ring is due (vyred was down) stays quiet. One found inside its lead rings at once.
- done, snooze and dismiss work on a calendar ring (the copy stays read-only); agents cannot
  finish an event.
- Busy time counts timed events only (the planner's with a length, and every calendar's): not
  all-day events, alarms or reminders.
- An agent may only use planner.calendar.create to ask for an invite (account and attendees), so it
  always waits at the Gate. It cannot make the planner's own events or write to a calendar unasked.
- A planner event made without an end lasts an hour (as Google's default). planner_items gains
  where_ (migration 2), shown as `where`.
- If google.accounts is missing at start (the google module not up yet), the planner looks once
  more a minute later and then waits for google.added.

## Needs from others
- pwa: service worker handles push kind `planner` with `done`/`snooze` actions; Now shows agenda, todos, alarms, notes.
- capsule-pro / capsule-apps: banner on `planner.fired`, drop on `planner.acked`; "timer 10 min" and "alarm 7am" call `planner.add` by default.
- mobile, chat: read the same tools and events.
- switchboard (push owner): the `planner` kind in core/push (listed under Changed contracts).

## Changed contracts
- planner (own): agents add alarms and timers; snooze, dismiss and delete open to agents for
  their own items; items gain added_by; planner.parse returns at (ms), tz, duration and
  {ambiguous, reason}, takes kind, answers locally; forwarded calls carry `as`.
- core/push (switchboard): planner-ack push; push.settings planner_label.
- deck/sw.js (pwa): planner-ack closes the tag; body shown when present.
- docs/nav.json (docs): using/planner.md and adr/0025-planner.md.
- planner.agenda (own): a calendar entry's `source` is the Google account name, no longer
  "calendar"; entries gain start, all_day, where, url on planner entries too. ADR 0025 contract
  table updated. planner.fired for a calendar event adds `account` and `start`.
- Session 4: planner (own) ring key on fired/acked/ringing, planner.upcoming, `key` on
  done/snooze/dismiss, planner.schedule event, last_event / cursor. core/push (switchboard): the
  planner push tag is the ring key, with item and due; planner-ack by key and for unrung answers.
- core/push/index.js (switchboard owns push): `planner.fired` maps to kind `planner` with a fixed
  title per item kind (alarm "Alarm", timer "Timer finished", reminder "Reminder", event "Starting
  soon", todo "Todo due"), path `/planner/<firing>`, tag `planner-<firing>`, `actions: ["done",
  "snooze"]` carried in the message. `planner` joins KINDS (push.settings can switch it off), is
  sent at high urgency, and alarms and timers ignore quiet hours while reminders and todos respect
  them. No title the user typed is ever in the payload. Test in core/push/push.test.js.
- docs/SPEC.md folder tree lists core/planner.
