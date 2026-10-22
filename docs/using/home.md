---
title: Home
summary: Home is the first place in the app: ask, the agents you made, what needs you, and a task field. Tasks live here. There is no Planner page.
audience: users
owner: docs
status: stable
---

# Home

Home is the first place in the sidebar. The column is the date and a greeting, then **Ask anything, or @ an agent**. Enter sends. The arrow sends too.

Face chips under the field are your assistant and the agents you made. Engineer is never a chip.

**Needs you**, **Doing**, **Today** and **Recent** show only when they have something. Today has a Day and Week toggle on that label. A quiet day reads **All clear. Nothing needs you today.**

The task field reads **Add a task, like remind me at 7**. Tasks and reminders live on Home.

Your profile photo is under **Settings**, **Your profile**: a photo or your look, **Change photo**, your name, your @username, and your role in this Space. A photo is centre-cropped and scaled on this computer before it is saved. After a Space is online, the first run asks for your name, a photo from this computer (GitHub sign-in offers **Use my GitHub photo**, and **Skip for now**), your assistant, a model, and a first chat.

An agent that sits idle for 15 minutes sleeps. Its process stops. The next message resumes the same conversation, with one short line that says waking.

The other places are [Chats](chat.md), [Projects](projects-and-threads.md), [Records](../architecture/features/records.md) and [Files](files.md). [Vault](vault.md) and Settings sit at the foot. See [Sidebar](sidebar.md).

## Set an alarm, a timer or a reminder from the terminal

`vyre alarm`, `vyre timer` and `vyre remind` still add one. Times are read in your zone. The reminder shows on Home.

```sh
vyre alarm 7am
vyre timer 25m bread
vyre remind "call juno" at 6
```

## Keep todos and notes

```sh
vyre todo add send the Northwind Bakery invoice by friday !high
vyre notes add kit prefers mornings
```

`vyre todo` lists open todos. A task you type on Home uses the task field.

## Answer something that is ringing

Answer a ring once, on any device. Done or Snooze stops it on the others. `vyre snooze <id> 15` rings again in 15 minutes.

## See your day

Home shows Today when the day has something. `vyre agenda` lists today's alarms, reminders and todos from a terminal. The same command with `tomorrow` is the next day.

## Show the words on your lock screen

To show the reminder's own words on the lock screen, not only "Reminder":

```sh
vyre call push.settings '{"planner_label": true}'
```

## Let your agents use it

Ask an agent to remind you. It adds the reminder. You do not get an extra prompt, and it does not ask for a passkey.

## Settings

An alarm nobody answers rings again every 5 minutes, three more times. Change both with `vyre call planner.settings`.
