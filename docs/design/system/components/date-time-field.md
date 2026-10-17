---
title: Date time field
summary: One input for a day and a time of day, read in a named zone: the browser's own calendar and clock on the web, two checked boxes elsewhere.
audience: builders
owner: app-design
status: draft
---

# Date time field

For every date a person picks: a record's date and date-time fields, a Flow's Wait until a date and time. One component, so the app has one kind of date input. Built on the [field](form-controls.md).

| Surface | Implementing file | Status |
|---|---|---|
| App, web | `apps/app/ui/components/DateTimeField.web.tsx`: the browser's date input and time input in the app's tokens | built |
| App, other | `apps/app/ui/components/DateTimeField.tsx`: two fields, a day (2026-10-28) and a time (14:30) | built |
| Both | `apps/app/ui/components/datetime.js`: the day and time as a moment, in a zone (lib/time) | built |

## Anatomy

A label above, then a day box and a time box side by side (the time box is left out for a day alone, `dateOnly`). Under them the help line, or in the error tone what is wrong ("Use a date like 2026-10-28.", "Use a time like 14:30.").

## Value and zone

The value is an ISO instant (a day alone is 2026-10-28). The day and the time are read in the zone the caller names, the viewer's own when none is named, and the help line says which. Nothing is sent while a part is not a real date or time; clearing both sends nothing but an empty value. A time the clocks skip moves forward as a phone does, and one that happens twice takes the first.

## States

Empty, filled, one part wrong (the error line, the box border in the error tone, no value sent), disabled.

## Accessibility

Each box has its own accessible name ("Wait until, day", "Wait until, time"). On the web the browser's inputs bring the calendar and clock and keyboard entry.

## Gaps

- [ ] No range (from, to) form yet.
