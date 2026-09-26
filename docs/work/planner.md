# planner

Branch: work/planner · Worktree: ../vyre-planner · Decisions: [ADR 0025](../adr/0025-planner.md)

Scope: module `planner` (core/planner): alarms, timers, reminders, todos, notes and a calendar
on the box; one scheduler; delivery to push, the Capsule and the Deck; CLI verbs; a minimal Deck
view. Surfaces (phone, Capsule rows and banners, native apps, chat) are built by their teams on
the contract in ADR 0025.

## Done
- ADR 0025 drafted, number claimed.

## Doing
- Slice 1: store, time math, scheduler, tools.

## Next
1. Store + time + scheduler + tools (slice 1).
2. Delivery: push kind `planner`, acks, escalation (slice 1).
3. CLI: `vyre alarm`, `vyre remind`, `vyre todo`, `vyre notes`, `vyre agenda`; `planner.parse`.
4. Calendar: google sync, agenda, event reminders, create through the Gate.
5. Mac role forwarding to the box when paired.
6. Minimal Deck view.

## Needs from others
- pwa: service worker handles push kind `planner` with `done`/`snooze` actions; Now shows agenda, todos, alarms, notes.
- capsule-pro / capsule-apps: banner on `planner.fired`, drop on `planner.acked`; "timer 10 min" and "alarm 7am" call `planner.add` by default.
- mobile, chat: read the same tools and events.
- switchboard (push owner): the `planner` kind in core/push (listed under Changed contracts).

## Changed contracts
- (none yet)
