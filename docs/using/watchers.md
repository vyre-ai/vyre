---
title: Watchers
summary: Ask Claude to watch something and file what it finds into a project, see the dry run before it turns on, and look after running watchers from the terminal and the Deck.
audience: users, agents
owner: docs
status: stable
---

# Watchers

A watcher is a small program that checks a source on a schedule (an inbox, an API, a page, a
feed) and files one item per new thing into a project. Vyre is the runtime, not a set of
integrations: Claude writes each watcher, and Vyre runs it after the session that wrote it has
ended. The runtime handles the schedule, credentials from the [Vault](vault.md), the `since`
cursor, dedupe, retries with backoff, filing items into the project and teaching them to its
[memory](memory.md), logs, pause and resume.

A watcher belongs to one project. A session or an agent sees only the watchers of its own project (or
the projects it was given), and you see all of them. Its items are filed into that project's memory
room and nowhere else.

## Ask for a watcher

In any Claude Code session with Vyre, say what to watch and where it goes:

> Watch the billing inbox for new invoices and file them into Harlow Legal.

Claude uses the **write-a-watcher** skill. It:

1. writes two files in the watchers folder, `~/.vyre/watchers/<name>/` (it moves with
   `VYRE_HOME`; `vyre watchers` prints it);
2. if the source needs a credential, gives you the exact grant command and waits;
3. dry-runs the watcher with `watchers.test`, which files nothing;
4. shows you the first items and the schedule in words;
5. turns it on with `watchers.create`, only after you agree.

`watchers.create` turns on exactly what was dry-run. If either file changes afterwards, the
watcher pauses until it is dry-run and created again, so nothing you did not see runs on a
schedule, and a watcher cannot widen its own credentials after you approved it.

## What a watcher is made of

`watcher.json`:

```json
{
  "name": "harlow-invoices",
  "project": "harlow-legal",
  "schedule": "*/15 * * * *",
  "net": { "mail.example": { "vault": "billing-inbox" } },
  "emits": "invoice.seen"
}
```

- `name` matches the folder. `project` is the slug of the project items file into.
- `schedule` is five-field cron in the machine's local time (`*/15 * * * *`, `0 */2 * * *`,
  `@hourly`, `@daily`), or `"webhook"` for a source that pushes.
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
vyre vault grant billing-inbox watchers --watcher harlow-invoices
```

Until you run it, the dry run fails with "billing-inbox is not granted to
watchers/harlow-invoices", followed by the grant command to run. If Claude asked for the grant
itself, it waits as pending: run `vyre vault pending` and `vyre vault approve <id>` (see the
[Vault](vault.md) page for a known problem with `approve`). Any value released during a run is scrubbed
from the run's logs and errors, and an item that carries one fails the run, so a credential never
reaches a project or memory.

## Look after running watchers

```
vyre watchers                          # every watcher: state, project, schedule, items filed, next run
vyre watchers test harlow-invoices     # dry-run it now; files nothing
vyre watchers create harlow-invoices   # turn on what was just dry-run
vyre watchers pause harlow-invoices
vyre watchers resume harlow-invoices   # also clears its failure count
vyre watchers logs harlow-invoices     # recent runs: when, why, items seen and filed, errors
vyre watchers items harlow-invoices    # what it filed; a project slug lists that project's items
```

A dry run says what it would file, then lists up to ten items:

```output
  harlow-invoices would file 3 items into harlow-legal · every 15 minutes · 640ms
  · Invoice 1042 from Northwind Bakery  https://mail.example/m/81
      invoice.seen · 2026-09-26 09:14

  vyre watchers create harlow-invoices to turn it on
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

For a `"webhook"` watcher, `vyre watchers create` prints the route (`POST
/v1/watchers/<name>/hook`), the header (`x-vyre-token`) and the token the sender must use. The
request body reaches the watcher as `hook`.

In the Deck, an agent's board (`/agents/<name>`) lists its watchers, each with a switch that pauses
it and turns it back on. Filed items appear in the project and in its memory room.

## Which surface does what

| Task | Terminal | Deck | Claude |
| --- | --- | --- | --- |
| Write a watcher | | | the write-a-watcher skill |
| Dry-run | `vyre watchers test` | | `watchers.test` |
| Turn on | `vyre watchers create` | | `watchers.create`, after your yes |
| List | `vyre watchers` | an agent's board | `watchers.list` |
| Pause, resume | `vyre watchers pause`, `resume` | the pause switch | `watchers.pause`, `watchers.resume` |
| Runs and items | `vyre watchers logs`, `items` | the project | `watchers.logs`, `watchers.items` |

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
