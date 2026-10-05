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

## Next

- [Spaces](spaces.md): what a space is.
- [Planner](planner.md): reminders and to-dos.
