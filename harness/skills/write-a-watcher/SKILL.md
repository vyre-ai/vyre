---
name: write-a-watcher
description: Use when the user wants something checked, polled or followed on a schedule and filed into a project, such as "watch this inbox", "check X every hour", "tell me when Y changes", "file every Z into the Harlow project". Turns the request into a Vyre watcher, dry-runs it, and only then turns it on.
---

# Write a watcher

Vyre hosts watchers; you write them. A watcher is a small program the Vyre runtime runs on a
schedule. It fetches what changed since last time and emits one item per new thing. The runtime
handles everything else: the schedule, credentials, the `since` cursor, retries, filing items
into the project, logs, pause and resume. Do not rebuild any of that inside a watcher.

## 1. Pin down four things before writing code

Ask only for what you cannot find out:

1. **Source**: what is being watched (an inbox, an API, a page, a folder, a feed).
2. **What counts as an item**: one email, one invoice, one changed row. Pick the natural unit.
3. **Project**: which Vyre project items file into. `vyre projects` (or the `projects_list`
   tool) lists them. Default to the project of the current folder.
4. **Schedule**: cron syntax. Default `*/15 * * * *`. Use less often when the source is slow
   or rate limited.

## 2. Credentials come from the Vault, by name

Never put a key, token or password in the watcher, in `watcher.json`, in a command line or in
your reply. List the Vault item names the watcher needs under `needs`. Check they exist with the
`vault_list` tool (names only). If one is missing, tell the user the exact name to add with
`vyre vault put <name>` and stop there. You never see or handle the value yourself.

## 3. Write two files in `~/.vyre/watchers/<name>/`

Name the watcher `<project>-<thing>`, kebab-case: `harlow-invoices`.

`watcher.json`

```json
{
  "name": "harlow-invoices",
  "project": "harlow-legal",
  "schedule": "*/15 * * * *",
  "needs": ["billing-inbox"],
  "emits": "invoice.seen"
}
```

`watch.js`

```js
// Watches the billing inbox for new invoices and files each one into Harlow Legal.
export default async function watch({ vault, since, emit, log }) {
  const token = await vault.fetch("billing-inbox");        // the runtime releases it; never log it
  const res = await fetch(`https://mail.example/api/messages?after=${since ?? 0}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`inbox answered ${res.status}`);   // the runtime retries with backoff
  for (const m of await res.json()) {
    if (!/invoice/i.test(m.subject)) continue;
    emit({ id: m.id, at: m.date, title: m.subject, from: m.from, url: m.link });
  }
}
```

Rules for `watch.js`:

- One default export, `async function watch({ vault, since, emit, log })`. Plain ES module; Node
  built-ins and global `fetch` only, no npm installs.
- `since` is the cursor the runtime saved last time (`null` on the first run). Fetch only newer
  items. Every emitted item needs a stable `id` so a repeat is never filed twice.
- `emit` takes small plain objects: `id`, `at`, `title`, and whatever the user will want to
  see. Never secrets, never whole documents; link to them.
- Throw on failure. Do not catch and hide errors, do not retry by hand, do not sleep.
- Do not send, post or reply to anything. A watcher reads. Anything outbound goes through the
  user, and the Vyre rules will hold it.

## 4. Dry-run, show, then turn it on

1. Run `watchers_test` with the watcher's name. It runs once with `since: null`, files nothing,
   and returns the items it would have emitted.
2. Show the user the first few items, one line each, and the schedule in words ("every 15
   minutes").
3. Only when they agree, call `watchers_create` to turn it on. Tell them `vyre watchers` lists
   it, and `vyre watchers logs <name>` shows its runs.

If the watcher tools are not available, the watcher runtime is not running on this machine.
Write the two files anyway, say so plainly, and stop before any dry run.
