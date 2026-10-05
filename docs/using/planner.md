---
title: Planner
summary: Alarms, timers, reminders, todos and notes kept on your box, so they ring on your phone and in the Vyre app even when your Mac is shut, and your agents can add them too.
audience: users, agents
owner: docs
status: draft
---

# Planner

The planner keeps your alarms, timers, reminders, todos and notes on your box, with one clock
that rings them. When something is due, every surface hears it at once: a notification on each
device that has push on, and a banner in the Vyre app. Answer it on one and it stops on all of them.
Your connected Google calendars are copied in too, so the agenda shows your whole day and an
event reminds you before it starts. A Mac paired with a box sends every change to the box; a Mac
on its own runs the planner itself.

## Set an alarm, a timer or a reminder from the terminal

```sh
vyre alarm 7am
vyre alarm 6:30 weekdays
vyre timer 10m
vyre timer 25m bread
vyre remind "call juno" at 6
vyre remind me in 20 minutes to check the oven
```

`vyre alarm` on its own lists the alarms to come, and `vyre alarm off <id>` turns one off. Times
are read in the planner's zone, which `vyre agenda` prints. An alarm follows the zone when you
travel; a reminder keeps the zone it was made in.

When the words do not say a time the planner can place, nothing is added and you are told why,
for example "how long a timer?" or "that time has already passed today".

## Keep todos and notes

```sh
vyre todo add send the Northwind Bakery invoice by friday !high
vyre todo
vyre todo done <id>
vyre notes add kit prefers mornings
vyre notes
```

`vyre todo` lists open todos by list. Priority is `!low`, `!!` or `!high`. A todo due on a day with
no time never rings; it shows on that day's agenda and stays there until it is done.

## See your day

```sh
vyre agenda
vyre agenda tomorrow
vyre agenda 2026-10-01
```

The agenda shows alarms, timers, reminders, the planner's own events and every connected
calendar's events in time order, then the todos due by the end of the day, overdue ones included.

In the Vyre app, open **Planner** (`/u/planner`, under Settings, More places). It shows a box to add
an item in words, today's agenda, your alarms, your open todos with **Done** to finish each, and
your notes.

## Answer something that is ringing

A ring shows as a card in the Vyre app with **Done** and **Snooze**, and as a notification on each
device where you turned push on. The notification says only what kind of thing it is (Alarm,
Timer finished, Reminder, Starting soon, Todo due); tap it to open the item in the app. From the
terminal:

```sh
vyre snooze <id>
vyre snooze <id> 15
```

A snooze is 9 minutes unless you give a number. The first answer wins: once you press Done or
Snooze anywhere, the card goes from the app and the notification closes on your other
devices. An alarm you do not answer rings again every 5 minutes, 3 more times.

Alarms and timers ring through quiet hours, since you set them. Reminders and todos wait until
quiet hours end.

## Show the words on your lock screen

By default a notification never carries the words you typed, because it passes through Apple's,
Google's or Mozilla's push service and anyone holding your phone can read the lock screen. To see
"Call kit" under "Reminder", turn on the label:

```sh
vyre call push.settings '{"planner_label": true}'
```

Set it to `false` to go back to the fixed words.

## Let your agents use it

Anyone may add alarms, timers, reminders, todos and notes, you and your agents alike, with no
prompt and no Touch ID. When your assistant, juno, promises to remind you, it adds the reminder
itself.

- You edit, finish, snooze and delete any item, whoever added it, with no prompt.
- An agent changes, finishes, snoozes or deletes only the items it added. kit cannot move your
  alarm or tick off juno's todo.
- Agents do not add events. An event with other people is an invite, and an agent can only ask
  for one: it waits at the Gate for you (see [Connectors](connectors.md)).
- Agents cannot change the planner's settings.

Agents reach the planner through the `planner.*` tools. `planner.add` takes `at` as an ISO time
or in words: `{ "kind": "reminder", "title": "Call Juniper Studio", "at": "6pm" }` is the next 6pm
in your zone, and "tomorrow at 9" and "in 20 minutes" work too. `planner.parse` reads words like
"remind me to call the printer at 6" into `{ kind, title, at, tz }` without adding anything, and
on a paired Mac it answers on the Mac. `planner.add` with `text` reads and adds in one step.

## Connected calendars

When a Google account is connected (see [Connectors](connectors.md)), the planner reads its
calendars from a day back to 14 days ahead, every 15 minutes, and when you connect or remove an
account. A timed event rings 10 minutes before it starts; all-day events never ring. The copy is
read-only: Done, Snooze and dismiss work on its ring, and the event itself stays as it is in
Google.

## Settings

```sh
vyre call planner.settings '{"timezone": "Europe/London"}'
vyre call planner.settings '{"escalate_after": 5, "escalate_max": 3, "event_lead": 10}'
```

`timezone` is the planner's zone. `escalate_after` is the minutes between rings of an unanswered
alarm, `escalate_max` how many more times it rings, and `event_lead` how many minutes before an
event its reminder rings. `vyre call planner.settings` with no input shows the current settings.

## What it will not do

- It does not email or text you when nothing answers a ring. Not built yet.
- It never puts the words you typed in a push unless you turn on the label.
- It does not write to your Google calendar without you: invites wait at the Gate.

## Next

- [Agents](agents.md): your assistant and the agents you make.
- [CLI](cli.md): every `vyre` command.
