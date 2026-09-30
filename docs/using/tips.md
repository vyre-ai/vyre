---
title: Tips
summary: One short line at a time about the part of Vyre you are using, the parts you have not tried, and what an update brought. Where tips show, how often, and how to turn them off.
audience: users, agents
owner: docs
status: stable
---

# Tips

Vyre does a lot, and most of it is a key or a command away. Tips teach it one line at a time, in
the place you are already working: a key in Lumen while you use Lumen, a command
after you run its neighbour in the terminal, a feature you have never opened when you pause.

A tip is one short line with the key or command in it, like this:

> Type `vyre remind "call juno" at 6` and it rings on every device with push on.

## Where tips show

| Surface | Where | When |
| --- | --- | --- |
| Lumen | a dim line under the empty box | when you open it and pause |
| Deck and Chat | a small chip at the foot of the view | while you use that view, or when you pause |
| Phone | a line in the Places sheet | when you open it |
| CLI | one dim `tip:` line after a command finishes | after an interactive command that worked |
| Glass | never during a take-over | |

A tip never takes focus, never covers what you are reading, and never uses the colour Vyre keeps
for things that need you. The CLI prints its line on stderr, and never with `--json`, when the
output is piped, or after an error.

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
- A tip shows at most twice. Press **Show me** or run its command and it is done for good.
- Press **×** on a tip and it never comes back. **Hide tips about this** hides every tip about
  that part of Vyre.

## After an update

When Vyre moves to a new version, the tips that came with it count as new. `vyre update` prints up
to five "New in" lines after the changelog, and the Deck shows one quiet card in Now that goes
away in one tap. Run `vyre tips new` to see the list again. A module you added from outside gets
the same treatment when its own version moves.

## Turn tips off, or bring them back

Settings has a **Tips** group:

- **Show tips**: on by default. Off hides every tip, on every device.
- **Time between tips**: 15, 30, 60 or 240 minutes.
- **Show tips again**: brings back every tip you dismissed or used.

From the terminal, put a `tips` block in config.json, and bring every tip back with a call:

```json
{ "tips": { "enabled": false, "gap_minutes": 60 } }
```

```sh
vyre call tips.reset
```

> [!GAP]
> The Settings hub, and a terminal command for every setting, land with the native-core work;
> until then the config.json block above is the switch. The surface lines (Lumen, Deck, phone,
> CLI) arrive with each surface's next release. The tips module, its tools and `vyre tips` are in
> now.

## For scripts and agents

`vyre call tips.list` lists every tip with how often it was shown and whether you dismissed it.
Agents may read the list. Only your own screens pick, dismiss or reset tips. The tools are in the
[tools reference](../reference/tools.md#tips).

Every module ships its own tips, including ones you add yourself. See
[Tips for your module](../build/tips.md).
