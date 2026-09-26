---
title: Capsule
summary: Open the Capsule on your Mac with Control twice, and use it to find things, ask your assistant or an agent, drive a session, and answer what is waiting on you.
audience: users
owner: capsule-pro
status: draft
---

# Capsule

The Capsule is Vyre's command bar on the Mac. Press Control twice, anywhere, and a bar opens over
whatever app you are in. One box does two jobs: it finds local things (apps, settings, files,
contacts, sums) the way Spotlight does, and it sends words to your assistant, an agent or a
running session. It also holds the list of what is waiting on you: permission questions from
sessions and drafts held at the Gate. The Capsule is a module with role `local`, so the vyred on
your Mac runs it. The local half works when vyred or your box is down.

## Install and open it

On a Mac, `vyre up` opens the Capsule if it is installed, and tells you to install it if not:

```
vyre capsule install
```

That downloads `Vyre-mac.zip` for your version, checks it against the published `SHA256SUMS`
and the hash shipped in the npm package, and puts `Vyre.app` in `~/Applications`. It never
uses `/Applications` or sudo.

After that:

```
vyre capsule          # open it (starts vyred first if it is not running)
vyre up --no-capsule  # start vyred without opening the Capsule
```

The Capsule lives in the menu bar. Click the mark for its menu: open it, how many things are
waiting on you, whether double-Control works, and whether vyred is running. To start it with
vyred every time, add a `capsule` key to `~/.vyre/config.json` and restart vyred (`vyre down`,
then `vyre up`):

```
{ "capsule": { "autostart": true } }
```

### Allow double-Control

The double-Control listener needs Input Monitoring. macOS grants it to `Vyre.app` (or to the
terminal you ran `vyre capsule --dev` from). If the menu says "Double-Control is off", open
System Settings, Privacy and Security, Input Monitoring, and turn on Vyre. Only two bare taps of
Control within 450 ms count, so Control-C and Control-arrow keep working as before.

## Find something on this Mac

Type in the box without `@`. The list ranks, in one list:

- apps and System Settings panes;
- a sum or a unit conversion (`12 * 18`, `5 km in mi`);
- contacts (the first time, a "Show contacts here" row asks macOS for access; typing never does);
- a definition: `define ledger`;
- files and folders, through Spotlight's index (`mdfind`);
- your agents, projects and threads, from vyred;
- clipboard history: type `clipboard`, `clip` or `paste`. Items that look like secrets are
  never kept.

Things you pick often rise over time. Enter opens the top match unless your words read as a
question; then the ask row is highlighted instead. Tab always asks.

## Ask your assistant, or a model

Type a question and press Enter. The row under the box, "Sends to", shows where it will go
before anything is sent, and Enter uses exactly that destination:

- A question about your own work ("what did I promise Harlow Legal?") goes to your assistant,
  which has your memory.
- Any other question goes to a fast model (haiku). The down arrow offers the assistant and a
  deeper model (sonnet).
- With no assistant made yet, memory answers on its own, with no model.

Answers render in place as markdown, with a copy button and the cost. Anything that came from
memory is drawn in gold, with its source.

## Talk to an agent or a session

Type `@` to name one. It completes agents, projects and threads:

- `@juno what is left on the intake form?` asks the agent juno, in its current thread
  (`agents.ask`). If your words match another of juno's threads, "Sends to" offers that one too.
- `@harlow-intake run the tests` types into that session as you (`threads.send`). While you type
  you hold the session's keyboard (its lease). If another surface holds it, the Capsule says who,
  and Command-Enter takes it.
- `@` a project starts a new thread in it, or sends to a matching thread there.

Two phrases work without `@`:

```
tell the intake thread to run the tests
watch the intake thread and tell me
```

A watch sends a notification when that thread finishes, stops or asks something, then a short
report.

## Answer what is waiting on you

When a session asks permission or the Gate holds a draft, the menu-bar mark turns to the Beacon
colour. The Capsule never opens itself and never takes your keyboard for this: you open it when
you choose.

- **A permission question**: Allow or Deny. Command-Enter allows.
- **A held draft** (an email, for example): To, Subject and body read as text and become editable
  when you click them. Command-Enter sends exactly what is on screen, through `gate.approve`.
  Discard drops it. Escape leaves a field.

## Open Glass

For a thread whose agent has a computer, the Capsule offers "Open Glass", which opens that
agent's screen in the Deck. Typing `glass` lists what you can open. See [Glass](glass.md).

## Keys

| Key | Does |
| --- | --- |
| Control, Control | open or close the Capsule |
| Enter | open the top match, or send to the "Sends to" destination |
| Tab | ask, whatever the top match is |
| Down arrow | choose another destination |
| Command-Enter | send a held draft, allow an ask, or take a session's keyboard |
| Escape | hide the Capsule and give the keyboard back to the app behind |

## Offline

When vyred on your Mac is not running, everything that came from it is cleared from the Capsule
and it says so. Local results (apps, settings, files, sums, clipboard) keep working. When your box
is out of reach, box features say the box is not reachable; they never hang.

## Sight

Asking about your screen, and reading text on it, are coming. They are not on this branch yet.

## What it will not do

- It will not open or take focus on its own. Only your double-Control opens it.
- It will not send anywhere other than the destination the "Sends to" row showed.
- It runs on macOS only. On Linux or Windows, use `vyre` in a terminal or the [Deck](deck.md).

## Build from source

For work on the Capsule itself:

```
vyre capsule build         # the Swift helpers (double-Control, launcher, local search)
vyre capsule build --app   # also package and sign Vyre.app
vyre capsule --dev         # run from source in this terminal; Control-C quits
```

`vyre capsule` runs a packaged build only while it matches the source it was made from; if the
source changed, it runs the source and says why.

## Next

- [Deck](deck.md), the same work in a browser and on your phone.
- [Projects and threads](projects-and-threads.md), what `@` completes.
- [Agents](agents.md), who you can talk to.
- [CLI reference](../reference/cli.md#vyre-capsule) for every `vyre capsule` form.
