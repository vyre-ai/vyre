---
title: Time zones
summary: How the Vyre app and a space read and show times: your own zone, a space's home zone, and how schedules behave around daylight saving.
audience: users
owner: docs
status: draft
---

# Time zones

Vyre stores every time as one moment in UTC. A time zone is only used to read a time you typed and to show one. Three clocks matter: yours, the space's home zone, and the server's, which Vyre never shows and never uses.

## Your zone

Your device tells the server which zone it is in with every call, so your times are read in it and follow you when you travel. The Vyre app shows every time in your own zone.

## A space's home zone

A space can have a home zone. Times that belong to the space, such as business hours, team meetings and deadlines, show in the space's zone beside yours, for example:

```
9:00 am PT · 9:00 pm your time
```

When the two clocks agree, only yours shows. An owner or an admin sets the home zone: open the space in the Vyre app, then **Time zone**, then **Home time zone**.

## Schedules

A flow's schedule runs in the space's zone, never the server's. A space with no zone set runs its schedules in UTC. A daily 07:00 stays 07:00 across daylight saving:

- A time the clocks skip (02:30 on the spring-forward night) runs once, moved on by the gap, at 03:30.
- A time that happens twice (the fall-back night) runs once, the first time.

### Business hours and holidays

A schedule can keep to business hours. `hours: true` means Monday to Friday, 9:00 to 17:00 in the schedule's zone. Give `days`, `from` and `to` for other hours. A cron time outside the hours is skipped. An interval that lands outside waits for the next time the hours open and counts again from there.

A schedule never runs on a holiday. List them on the schedule (`holidays: ["2026-12-25", "07-04"]`: a full date, or month and day for every year), or set the space's own list in Settings, Flows, Holidays. A schedule with business hours uses the space's list unless it has one of its own.

### After the server was off

Say what a schedule does about the times it missed: `catch_up: once` (the default) runs it one time and the run says how many it skipped, `all` runs it once for every time missed (at most 50 at a time), and `skip` runs nothing for the missed times and carries on with the next one. A run that is only late, by under two minutes, is never counted as missed.

## Next

- [Spaces](spaces.md): what a space is.
- [Planner](planner.md): reminders and to-dos.
