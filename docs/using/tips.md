---
title: Tips
summary: One short line at a time about the part of Vyre you are using, the parts you have not tried, and what an update brought. Where tips show, how often, and how to turn them off.
audience: users, agents
owner: docs
status: stable
---

# Tips

Vyre does a lot, and most of it is a key or a command away. Tips teach it one line at a time, in
the place you are already working. In 0.2.0 that place is the terminal: a command after you run
its neighbour.

A tip is one short line with the key or command in it, like this:

> Type `vyre remind "call juno" at 6` and it rings on every device with push on.

## Where tips show

In 0.2.0 tips show in the terminal: one dim `tip:` line after an interactive `vyre` command
that worked. The CLI prints it on stderr, and never with `--json`, when the output is piped,
after an error, or after `vyre up`, `vyre down` and `vyre tips` themselves. Set `VYRE_NO_TIPS=1`
to silence it for one shell.

Tips do not show in Lumen, the Deck or the phone yet. Every tip already says which surface it
is for, so they can appear there later without a change to the tips you have dismissed.

A tip never takes focus, never covers what you are reading, and never uses the colour Vyre keeps
for things that need you.

## Which tip you get

Vyre picks at most one, in this order:

1. **What you are using.** A tip about the module in front of you. The first few times, the
   basics. After that, the shortcuts.
2. **What you have not tried.** When you pause, a tip about a part of Vyre you have never used,
   so you find out what it is for.
3. **What is new.** After an update, the tips that came with it.
4. **Handy things.** When you pause, a tip about something you already use.

The very first time you open a screen, it may show one tip about something worth trying, as a
welcome. That happens once per screen, and never when something is waiting for you.

The choice is fixed by these rules, never by chance, so the same moment gives the same tip.

## It never nags

- Nothing shows while Vyre asks you something, while a draft waits for Send, or while a turn is
  running or you are typing.
- At most one tip per screen every 30 minutes, two minutes apart across all your screens, and six
  a day in all.
- A tip shows at most twice, and once you use what it teaches it is done for good.
- A tip you dismissed never comes back until you run `vyre tips reset`.

## After an update

When Vyre moves to a new version, the tips that came with it count as new. `vyre update` prints
"New in" lines after the update, one for each new tip. Run `vyre tips new` to see the list
again. A module you added from outside gets
the same treatment when its own version moves.

## Turn tips off, or bring them back

Settings has a **Tips** group:

- **Show tips**: on by default. Off hides every tip, on every device.
- **Time between tips**: 15, 30, 60 or 240 minutes.

You can set the same two in `config.json`, and bring every tip you dismissed or used back with
`vyre tips reset`:

```json
{ "tips": { "enabled": false, "gap_minutes": 60 } }
```

## For scripts and agents

`vyre call tips.list` lists every tip with how often it was shown and whether you dismissed it.
Agents may read the list. Only your own screens pick, dismiss or reset tips. The tools are in the
[tools reference](../reference/tools.md#tips).

Every module ships its own tips, including ones you add yourself. See
[Tips for your module](../build/tips.md).
