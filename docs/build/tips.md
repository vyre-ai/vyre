---
title: Tips for your module
summary: Ship tips with a module under teaches.tips in module.json. The fields, the rules a tip must pass, how the tips module picks one, and how a surface shows it.
audience: builders, agents
owner: docs
status: stable
---

# Tips for your module

A module teaches people how to use it best with tips: short lines that Vyre shows one at a time, in
the place they are working. Vyre's own modules ship theirs the same way, so a module you write or
add from outside gets tips on every surface with no UI code.

## Declare them

Tips live in `module.json` under `teaches.tips`:

```json
{
  "name": "bakery",
  "version": "1.0.0",
  "teaches": {
    "tips": [
      { "id": "count", "text": "Run `vyre call bakery.count` for today's Northwind Bakery orders.",
        "surfaces": ["cli"], "level": "first-use", "trigger": "on-use", "since": "1.0.0",
        "command": "vyre call bakery.count" },
      { "id": "rye", "text": "Rye orders now show in Now, above the rest.",
        "surfaces": ["deck", "phone"], "level": "discovery", "trigger": "after-update", "since": "1.1.0" }
    ]
  }
}
```

| Field | Required | What it holds |
| --- | --- | --- |
| `id` | yes | lowercase letters, digits and dashes, unique in the module. The full id is `<module>/<id>` |
| `text` | yes | the tip itself, at most 140 characters. Put a key or command in backticks |
| `surfaces` | yes | where it makes sense: `capsule`, `deck`, `chat`, `phone`, `cli`, `glass` |
| `level` | yes | `first-use` (the basics), `power` (shortcuts for regular users), `discovery` (why to try it) |
| `trigger` | yes | `on-use` (while the person is in this module), `idle` (when they pause), `never-used` (for people who have not tried it), `after-update` (only as news in a release) |
| `since` | yes | the version that brought it. First-party tips use Vyre's version; yours use your module's |
| `key` | no | a shortcut, drawn as a key chip, like `⌥⏎` |
| `command` | no | a command the surface can offer to copy or run, like `vyre call bakery.count` |
| `docs` | no | a docs page for Show me, like `using/planner.md#reminders` |
| `about` | no | what the tip is about, when it isn't the module itself (Vyre's surface tips use `deck`, `chat`, `phone`, `cli`) |

Keys that start with `x-` are free for your own notes. Any other key is refused.

## Write a good tip

- Lead with the action: "Press", "Type", "Run". One idea per tip.
- Show the key or command. A tip nobody can act on right away is a paragraph.
- Plain words. No em dashes, no hype, no "you can".
- Use the sample world in examples (alex, Harlow Legal, Northwind Bakery, juno, kit), never a real
  person or client.
- Give a module 6 to 10 tips: two or three first-use, a few power, one or two discovery, and one or
  two idle.

A tip that breaks a rule is dropped and logged (`vyre logs tips`); the module's other tips still
show. Vyre's own tips are held to the same rules by `test/tips-content.test.js`, which also checks
that each `docs` link lands on a real heading.

## How one is picked

A surface calls `tips.next {surface, context: {module, idle, busy}}` and gets one tip or none. The
rules are in `core/tips/pick.js`, and every rule has a test.

1. Nothing when tips are off, when `busy` is set (an ask, a draft waiting, a running turn, typing),
   within the gap since this surface's last tip (30 minutes by default), within two minutes of a
   tip on any surface, or once six were shown in 24 hours.
2. Tips about the module named in the call's `context` with trigger `on-use`: `first-use` while the person has used it
   fewer than three times, then `power` first.
3. When `idle`: `never-used` tips about modules they have not touched, starting with the module
   that went longest without a tip.
4. When `idle`: tips newer than the version the person last saw.
5. When `idle`: `idle` tips about modules they use.

On a surface's very first open (`context.first: true`), one `never-used` discovery tip may show
without `idle`, once per surface, as a welcome. Every rule in step 1 still applies to it.

Within a step, manifest order decides, so put your best tip first. A tip retires after two
showings, when the person acts on it, or when they dismiss it.

## Show one on a surface

A surface that shows tips does three things:

- asks `tips.next` with the module in front of the person, `first: true` on its very first open,
  `idle: true` after a pause, and
  `busy: true` while anything else wants their attention;
- calls `tips.seen {id, surface}` when it draws the tip, and `tips.seen {id, surface, acted: true}`
  when they press Show me or run the command. The CLI passes `mark: true` to `tips.next` instead,
  since it prints at once;
- calls `tips.dismiss {id}` on ×, or `tips.dismiss {module}` for "Hide tips about this".

Calling `tips.used {module}` when the person opens a module's view, even with no tip on screen,
keeps the "used" count right. The tips module never pushes anything; it only answers.

`tips.whatsnew {since}` lists what came after a version, newest first. `vyre update` calls it
after the changelog, and `tips.whatsnew {ack: true}` marks the news as seen. When the running
version moves, the tips module emits `tips.updated {module, from, to, count}` once.

## Where the pieces are

- `core/tips/check.js`: the rules a tip must pass (`checkTips`).
- `core/tips/pick.js`: the selection rules.
- `core/tips/index.js`: the tools, the store and the version check.
- The loader hands the tips module every running module's tips (`ctx.declaredTips()`); the tips
  module never reads another module's files.
