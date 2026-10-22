---
title: Watchers
summary: Ask an agent to set up a Routine (on a schedule) or a Watcher (when something new appears) for itself, and look after them on the agent's page and in its panel beside a chat.
audience: users, agents
owner: docs
status: stable
---

# Watchers

An agent can keep working for you after the chat goes quiet, in two ways. Both belong to the
agent, and you make either one only by asking that agent in its chat.

- **A Routine runs on a schedule.** "Every weekday at 9, summarise my inbox." At its time it
  starts the agent with the instructions it was given, and the agent posts the result in the chat.
- **A Watcher runs when something new appears.** "Tell me when an invoice from Northwind
  arrives." It checks a source and wakes the agent only when there is something new.

Both run for the person who asked, on that person's own AI account (Claude, Codex, Grok,
OpenRouter or a key, from Settings, AI accounts). Neither ever runs on the owner's account for
someone else. You see them on the agent's page, and in the agent's panel beside
a chat, under **Routines and watchers**, with Pause, Resume, Run now and Delete. There is no form:
to change one, ask the agent again. Flows do not show watchers.

Vyre is the runtime: it handles the schedule, credentials from the [Vault](vault.md), the
`since` cursor, dedupe, retries with backoff, logs, pause and resume. A teammate's standing
duties are the same thing: a duty on a schedule is a Routine, a duty on an event is a Watcher, and
they are listed with the rest.

## Ask for a watcher

Ask the agent in its chat:

> Tell me when an invoice from Northwind arrives.

The agent uses the **write-a-watcher** skill. It:

1. writes the Watcher with `watchers.write`, only because your own words in this chat asked;
   Vyre records it as that agent's, for you, in this chat;
2. dry-runs it with `watchers.test`. It starts paused and turns on when that first test passes;
3. tells you in one line what it set up, and the card shows in the chat.

When it finds something new, the agent gets one message in that chat with what is new, quoted as
outside data it must not obey, at most five times a day. It decides what to do: tell you, or start
a Flow with the items as untrusted outside data.

A Watcher uses only the Vault items and Connections already lent to its agent. If it needs one
that is not, its card says **Needs access to** the item, with a button to let the agent use it
without seeing it.

For a Routine, say when:

> Every weekday at 9, check my inbox and tell me what needs me.

The agent calls `watchers.routine.create` with the time and the instructions. A Routine's code is
Vyre's own, so it is on at once and first runs at its next time, at most every 15 minutes.

Watchers made before 0.6.4 (folders written by hand or by a preset, and a project's watchers) keep
running and are looked after the same way below. A watcher's webhook address is retired: a webhook
starts a Flow (Flows, the trigger **A webhook is called**).

## What a watcher is made of

`watcher.json`:

```json
{
  "name": "juniper-invoices",
  "project": "juniper-legal",
  "schedule": "*/15 * * * *",
  "net": { "mail.example": { "vault": "billing-inbox" } },
  "emits": "invoice.seen"
}
```

- `name` matches the folder. `project` is the slug of the project items file into.
- `schedule` is five-field cron in the machine's local time (`*/15 * * * *`, `0 */2 * * *`,
  `@hourly`, `@daily`). An agent's own watcher needs no `project`, and its `owner` is set by Vyre.
- `net` lists the hosts the watcher reads, each with an optional Vault item that Vyre attaches to that host's requests; the watcher's code never sees it. `emits` names the kind of item (`noun.past-verb`).
- Optional: `timeout` in seconds (default 60, at most 300) and `description`. Any other key is
  refused.

`watch.js` exports one function:

```js
export default async function watch({ since, emit, log, hook }) {
  const res = await fetch(`https://mail.example/api/messages?after=${since ?? 0}`);   // Vyre adds the credential
  if (!res.ok) throw new Error(`inbox answered ${res.status}`);
  for (const m of await res.json()) {
    if (/invoice/i.test(m.subject)) emit({ id: m.id, at: m.date, title: m.subject, url: m.link });
  }
}
```

Each run happens in a child process with no environment variables, read access to its own folder
only, and no writes or child processes. It has no network of its own: it runs inside a wall
(bubblewrap on Linux, a sandbox profile on a Mac) so it cannot open a socket, see your home, or
reach other processes. `fetch` is run by Vyre for it, GET and HEAD only, to the public hosts listed
under `net`. If a machine cannot build that wall, no watcher runs there and Vyre says why. Every item
needs a stable `id`, so a repeat is never filed twice.

## Ask a model for a judgment

A watcher that cannot decide by rule may call `await ask(prompt)`. It returns text from a model with
no tools, and only if `watcher.json` sets a daily budget, like `"ask": { "dailyUsd": 0.25 }`. A
watcher that has used its day's budget is refused until tomorrow. The answer goes back into the
watcher's own code: it can decide whether to file an item, never whether to send anything.

## Give a watcher a credential

A grant is for one item and one watcher. A second watcher that needs the same item needs its own
grant.

```
vyre vault put billing-inbox --kind api-key          # if it is not in the Vault yet
vyre vault grant billing-inbox watchers --watcher juniper-invoices
```

Until you run it, the dry run fails with "billing-inbox is not granted to
watchers/juniper-invoices", followed by the grant command to run. If Claude asked for the grant
itself, it waits as pending: run `vyre vault pending` and `vyre vault approve <id>` (see the
[Vault](vault.md) page for a known problem with `approve`). Any value released during a run is scrubbed
from the run's logs and errors, and an item that carries one fails the run, so a credential never
reaches a project or memory.

## Look after running watchers

```
vyre watchers                          # every watcher: state, project, schedule, items filed, next run
vyre watchers test juniper-invoices     # dry-run it now; files nothing
vyre watchers create juniper-invoices   # turn on what was just dry-run
vyre watchers pause juniper-invoices
vyre watchers resume juniper-invoices   # also clears its failure count
vyre watchers logs juniper-invoices     # recent runs: when, why, items seen and filed, errors
vyre watchers items juniper-invoices    # what it filed; a project slug lists that project's items
```

A dry run says what it would file, then lists up to ten items:

```output
  juniper-invoices would file 3 items into juniper-legal · every 15 minutes · 640ms
  · Invoice 1042 from Northwind Bakery  https://mail.example/m/81
      invoice.seen · 2026-09-26 09:14

  vyre watchers create juniper-invoices to turn it on
```

States are `draft`, `on`, `paused`, `changed` and `invalid`. `vyre watchers items` with no name
lists every watcher's items.

> [!SNAG] A watcher paused itself after three failed runs
> After three failed runs in a row a watcher pauses itself and says why. Read the runs with
> `vyre watchers logs <name>`, fix the cause (often a revoked grant, or a source that answered
> with an error), then `vyre watchers resume <name>`, which also clears the failure count.

> [!SNAG] A run fails with "the vault is not running on this machine"
> The watchers runtime starts without the Vault, so a watcher that needs an item fails until the
> vault module runs. Check `vyre modules`.

> [!SNAG] A watcher shows `changed` and does not run
> One of its files changed after you turned it on. Dry-run it again with
> `vyre watchers test <name>`, check the items, then `vyre watchers create <name>`.

In the Vyre app, an agent's page and its panel beside a chat list its
Routines and Watchers, with Pause, Resume, Run now and Delete. Filed items appear in the project and in its memory room.

## Which surface does what

| Task | Terminal | Vyre app | Claude |
| --- | --- | --- | --- |
| Write a watcher | | | the write-a-watcher skill |
| Dry-run | `vyre watchers test` | | `watchers.test` |
| Turn on | `vyre watchers create` | | `watchers.create`, after your yes |
| List | `vyre watchers` | an assistant's page | `watchers.list` |
| Pause, resume | `vyre watchers pause`, `resume` | the pause switch | `watchers.pause`, `watchers.resume` |
| Runs and items | `vyre watchers logs`, `items` | | `watchers.logs`, `watchers.items` |

## Standing duties are watchers too

A teammate's standing duty ("review every finished session", "note each morning what is stale") is a
watcher owned by that teammate, not a second system. It lives in the same project as the teammate.
Vyre writes the watcher folder from the plain words and fixed code, so no model writes duty code; it
runs on the same runtime and the same wall, and shows the same card.

- **A duty is off until you turn it on, if a model proposed it.** A duty a teammate, an agent or a
  session creates is a proposal: it has no watcher at all, so it cannot run or spend anything. You
  turn it on from the card in the project's **Team** tab, or a model turns it on only when your own
  words asked for exactly that duty. A duty you create yourself starts at once.
- **Enable and pause.** In the **Team** tab, a duty's button switches it on or off, and **Run now**
  fires an enabled duty once. `vyre watchers pause <name>` and `vyre watchers resume <name>` work on
  its watcher too (its name is `duty-<role>-<id>`). Changing a running duty asks you again.
- **Whose duty it is.** A duty runs as the person who made it running, or who last turned it on or
  changed what it does, on that person's own AI account. A duty made before Vyre recorded that is
  paused and says "Paused: made before Vyre recorded who it runs for. Turn it on to run it as you."
  Turning it on makes it yours. One you made yourself on this computer keeps running as yours.
- **What a firing does.** The duty's fixed code files one item per firing, so what it did shows in
  `vyre watchers items` like any watcher's. The teammate reads what its duties filed with its next
  request. A firing does not start the teammate by itself.
- **It still cannot reach out.** A duty marked "Can make changes" still holds anything outward you did
  not ask for, exactly as a watcher would, and every duty runs inside the wall.
- **Deleting.** Delete a duty from its teammate, which removes its watcher. Retiring a teammate
  switches its duties off.

See [Teammates](teammates.md).

## Vyre does not poll where it can listen

A watcher runs when something happens, on a schedule, or when a source pushes:

- **An event** ("a session finished") costs nothing until it happens.
- **A push** (a connected Gmail account) arrives by itself from the Vault's connection, with no polling. A watcher sees only that message ids arrived, never the sender or subject, and only for the projects that connection is granted to.
- **A schedule** (`daily 07:00`, `every 30 minutes`, cron) never runs faster than every five minutes.

## Important mail into memory

If you connected Google in the Vault, `watchers.preset {kind: "mail", project, credential}` sets up a
watcher for a project. When Gmail says new mail arrived, it reads only the sender, subject and first
lines, a model answers yes or no on whether it matters by your rule (by default: clients, courts and
agencies, anything with a deadline; not newsletters or receipts), and each yes becomes a short quoted
note in that project's memory, marked as from outside so it is never treated as an instruction. It
sends and changes nothing. It starts off: you see its card, run the one grant command it shows, and
turn it on.

## A watcher that wakes a session

A watcher made for one session (a PR's review comments, say) can post what it finds into that session.
Its `watcher.json` names the session (`about`), is owned by it (`owner`), says `act: true`, and may set
`wake.maxPerDay` (default 5, at most 20). Each run that files something new posts one note to the
session, and the note is quoted data: Vyre says so in its own words first, then puts the items inside a
marked block the item cannot close, so a comment from outside can be read but never obeyed. It posts only
to its own session, only in its own project, and never more than the day's limit. The card shows this
before you turn it on.

## Presets for common sources

`watchers.preset` writes a ready watcher from a few fields. Each starts off with its card, reads
only, sends and changes nothing, and files short quoted notes marked as from outside.

| Kind | Fields | Reads | Runs |
|---|---|---|---|
| `mail` | project, credential | new mail a Gmail push announces | on a push |
| `calendar` | project, credential, calendar, match, days | new or changed events in the next days | hourly |
| `repo` | project, repo, credential (optional), match, only | issues and pull requests | every 30 minutes |
| `slack` | project, credential, channel id, match | new messages in one channel | every 15 minutes |
| `feed` | project, url, match | a public RSS, Atom or JSON feed | hourly |

`match` is a short list of words; an item must mention one. It is a plain text match, with no
model, so only `mail` costs anything.

## The card before you turn it on

Before anything runs on its own, you see a card: when it runs, what it checks, what it does, the
hosts it reads, whether it can act and what a model would cost at most. The last three are worked
out by Vyre from the watcher's files, not from what its author wrote about it. Turning it on
turns on exactly the code the card described; if the files change first, it asks again.

## What it will not do

- Be turned on by Claude on its own. `watchers.create` runs for a model only when your own words asked for it, after you have seen the card; deleting, running and resuming a watcher are yours.
- Send, post or reply to anything. A watcher reads. Anything outbound goes through you.
- Run a watcher that changed since you saw its dry run.
- Hand a watcher a credential at all. Vyre attaches a Vault item to the one host a watcher names under `net`, and only if the item was granted to that watcher; the watcher's code never sees the value.
- Read a host it did not list under `net`, or reach your machine, your tailnet or anything private.
- Put a credential into an item, a log or a project.

## Next

- [Vault](vault.md): grants, and what a watcher can fetch.
- [Projects and threads](projects-and-threads.md): where filed items go.
- Every tool: [watchers](../reference/tools.md#watchers). Every command:
  [`vyre watchers`](../reference/cli.md#vyre-watchers).
