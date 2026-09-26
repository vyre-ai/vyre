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
integrations: Claude writes each watcher, and vyred runs it after the session that wrote it has
ended. The runtime handles the schedule, credentials from the [Vault](vault.md), the `since`
cursor, dedupe, retries with backoff, filing items into the project and teaching them to its
[memory](memory.md), logs, pause and resume.

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
  "needs": ["billing-inbox"],
  "emits": "invoice.seen"
}
```

- `name` matches the folder. `project` is the slug of the project items file into.
- `schedule` is five-field cron in the machine's local time (`*/15 * * * *`, `0 */2 * * *`,
  `@hourly`, `@daily`), or `"webhook"` for a source that pushes.
- `needs` lists Vault item names. `emits` names the kind of item (`noun.past-verb`).
- Optional: `timeout` in seconds (default 60, at most 300) and `description`. Any other key is
  refused.

`watch.js` exports one function:

```js
export default async function watch({ vault, since, emit, log, hook }) {
  const token = await vault.fetch("billing-inbox");
  const res = await fetch(`https://mail.example/api/messages?after=${since ?? 0}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`inbox answered ${res.status}`);
  for (const m of await res.json()) {
    if (/invoice/i.test(m.subject)) emit({ id: m.id, at: m.date, title: m.subject, url: m.link });
  }
}
```

Each run happens in a child process with no environment variables, read access to its own folder
only, and no writes or child processes. It can reach the network. Every item needs a stable `id`,
so a repeat is never filed twice.

## Give a watcher a credential

A grant is for one item and one watcher. A second watcher that needs the same item needs its own
grant.

```
vyre vault put billing-inbox --kind api-key          # if it is not in the Vault yet
vyre vault grant billing-inbox watchers --watcher harlow-invoices
```

Until you run it, the dry run fails with "billing-inbox is not granted to
watchers/harlow-invoices". If Claude asked for the grant itself, it waits as pending: run
`vyre vault pending` and `vyre vault approve <id>`. Any value released during a run is scrubbed
from the run's logs and errors, and an item that carries one fails the run, so a credential never
reaches a project or memory.

## Look after running watchers

```
vyre watchers                          # every watcher: state, project, schedule, items filed, next run
vyre watchers test harlow-invoices     # dry-run it now
vyre watchers create harlow-invoices   # turn on what was just dry-run
vyre watchers pause harlow-invoices
vyre watchers resume harlow-invoices   # also clears its failure count
vyre watchers logs harlow-invoices     # recent runs: when, why, items seen and filed, errors
vyre watchers items harlow-invoices    # what it filed; a project slug lists that project's items
```

States are `draft`, `on`, `paused`, `changed` and `invalid`. After three failed runs in a row a
watcher pauses itself and says why.

For a `"webhook"` watcher, `vyre watchers create` prints the route (`POST
/v1/watchers/<name>/hook`), the header name and the token the sender must use. The request body
reaches the watcher as `hook`.

In the Deck, an agent's board (`/agents/<name>`) lists its watchers with a pause switch. Filed
items appear in the project and in its memory room.

## Which surface does what

| Task | Terminal | Deck | Claude |
| --- | --- | --- | --- |
| Write a watcher | | | the write-a-watcher skill |
| Dry-run | `vyre watchers test` | | `watchers.test` |
| Turn on | `vyre watchers create` | | `watchers.create`, after your yes |
| List | `vyre watchers` | an agent's board | `watchers.list` |
| Pause, resume | `vyre watchers pause`, `resume` | the pause switch | `watchers.pause`, `watchers.resume` |
| Runs and items | `vyre watchers logs`, `items` | the project | `watchers.logs`, `watchers.items` |

## What it will not do

- Send, post or reply to anything. A watcher reads. Anything outbound goes through you.
- Run a watcher that changed since you saw its dry run.
- Hand a watcher a Vault item it does not list under `needs`, or one not granted to it.
- Put a credential into an item, a log or a project.

## Next

- [Vault](vault.md): grants, and what a watcher can fetch.
- [Projects and threads](projects-and-threads.md): where filed items go.
- Every tool: [watchers](../reference/tools.md#watchers). Every command:
  [`vyre watchers`](../reference/cli.md#vyre-watchers).
