---
name: write-a-watcher
description: Use first, before asking the user anything, whenever they want something watched, checked, polled or followed over time and filed into a project, such as "watch this inbox", "check X every hour", "tell me when Y changes", "file every Z into the Harlow project". Use it instead of /loop, cron, scheduled agents or a hand-rolled poller: a Vyre watcher keeps running in vyred after this session ends. This skill says where items go, how often to check and what to capture, so those are not questions for the user. Writes the watcher, dry-runs it, and only then turns it on.
---

# Write a watcher

Vyre hosts watchers; you write them. A watcher is a small program the Vyre runtime runs on a
schedule. It fetches what is there now (or what changed since last time) and emits one item per
thing. The runtime handles everything else: the schedule, credentials, the `since` cursor,
dedupe, retries, filing items into the project and into its memory, logs, pause and resume. Do
not rebuild any of that inside a watcher.

## The steps, in order

Each is a tool call. The Vyre tools are MCP tools (`mcp__plugin_vyre_vyre__<name>` in Claude
Code; load them with ToolSearch when they are deferred). Call them directly, never from a shell.

1. `watchers_list` → its `dir` is where watchers live on this machine.
2. `projects_of` with `{ "cwd": "<the current folder>" }` → the project's `slug`.
3. Write `<dir>/<name>/watcher.json` and `<dir>/<name>/watch.js` (section 3).
   If it needs a credential, give the user the grant command for this watcher and wait
   (section 2).
4. `watchers_test` with `{ "name": "<name>" }` → fix and repeat until it returns `ok: true`.
5. Show the user the items and the schedule; on their yes, `watchers_create` with `{ "name" }`.

The sections below say how to decide each part.

## 1. Pin down four things before writing code

Each has a default. Ask the user only when the request leaves one truly open and no default
fits; "watch X and file it into this project" leaves nothing open.

1. **Source**: what is being watched (an inbox, an API, a page, a folder, a feed). Prefer a
   JSON API or feed over scraping HTML when the source has one.
2. **What counts as an item**: one email, one invoice, one post. Pick the natural unit.
3. **Project**: which Vyre project items file into. The `projects_of` tool with the current
   folder gives its project's `slug`; `projects_list` lists them all. Use the slug.
4. **Schedule**: cron syntax (five fields, `*`, `*/n`, ranges, lists, or `@hourly`, `@daily`).
   Default `*/15 * * * *`. Use less often when the source is slow or rate limited. A step
   cannot exceed its field: every two hours is `0 */2 * * *`, never `*/120 * * * *`. For a source
   that pushes (a form, a webhook), use `"webhook"`.

## 2. Credentials come from the Vault, by name, granted to this one watcher

Never put a key, token or password in the watcher, in `watcher.json`, in a command line or in
your reply. A public source needs nothing: leave `needs` out. Otherwise:

1. `vault_list` (names only) to find the item. If it is missing, tell the user the exact name to
   add with `vyre vault put <name>` and stop there. Never ask them to paste a value.
2. List the item's name under `needs` in `watcher.json`.
3. Before the dry run, give the user the exact command that lets this one watcher use it, and
   wait for them to run it:

   ```
   vyre vault grant <item> watchers --watcher <watcher name>
   ```

   A grant can only come from a person. A grant is for one watcher, never for every watcher; a
   second watcher that needs the same item needs its own. If you call `vault_grant` yourself,
   the grant stays `pending` and the watcher still cannot use the item until a person approves
   it in a terminal: `vyre vault pending` lists what waits, `vyre vault approve <id>` allows
   one. You cannot approve it; `vault_approve` is not open to Claude. The command above is
   one step for them instead of two.
4. Until they have run it, the dry run fails with "<item> is not granted to watchers/<name>".
   That is expected, not a bug in the watcher: remind them of the command, then dry-run again.

In `watch.js`, `await vault.fetch("<item>")` returns the value (`value`, a login's `password`, a
card's `number`, a note's `text`). Pass `{ field: "username" }` for another field; an env set
always needs a field. You never see or handle the value yourself.

## 3. Write two files in the watchers folder

Call the `watchers_list` tool first. It is an MCP tool, not a shell command: Claude Code names
it `mcp__plugin_vyre_vyre__watchers_list` (load it with ToolSearch if it is deferred). Its `dir`
is the watchers folder on this machine. Write into `<dir>/<name>/` and nowhere else; the folder
moves with `VYRE_HOME`, so never guess it. Name the watcher `<project>-<thing>`, kebab-case:
`harlow-invoices`.

`watcher.json`: exactly these keys, nothing else.

```json
{
  "name": "harlow-invoices",
  "project": "harlow-legal",
  "schedule": "*/15 * * * *",
  "needs": ["billing-inbox"],
  "emits": "invoice.seen"
}
```

`name` must match the folder. `emits` names the kind of item (`noun.past-verb`). Optional:
`timeout` in seconds (default 60, at most 300).

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

- One default export, `async function watch({ vault, since, emit, log, hook })`. Plain ES
  module; Node built-ins and global `fetch` only, no npm installs. It runs in a sandbox with no
  environment variables, read access to its own folder only, and no writes or child processes.
- `since` is `null` on the first run. After each successful run it becomes whatever `watch`
  returned, or, if it returned nothing, the time that run started (ms since the epoch). Return
  the source's own cursor (a last id, a page token) when it has one. A ranked list (a front
  page, a top-100) has no such cursor: an old id can climb onto it later, so skipping ids
  below the highest one seen loses items. Emit what is on the list and let dedupe work.
- Every item needs a stable `id` from the source, so a repeat is never filed twice. Emitting
  everything currently visible each run is fine; the runtime files only ids it has not seen.
- `emit` takes small plain objects (under 4 KB): `id`, `title`, `url`, `at` (a date string or
  ms), and whatever the user will want to see. `about` (optional) names the person or
  organisation an item concerns, so memory links it there. Never secrets, never whole
  documents; link to them.
- `hook` is the JSON body of the webhook call for a `"webhook"` watcher, and `null` otherwise.
- `log(...)` one line of what each run read ("checked 30 stories, 2 match"), so a run with no
  items still shows the source was reached. Throw on failure. Do not catch and hide errors, do
  not retry by hand, do not sleep.
- A run has 60 seconds by default. When one listing needs a request per entry, fetch them
  together (`Promise.all`) rather than one after another.
- Do not send, post or reply to anything. A watcher reads. Anything outbound goes through the
  user, and the Vyre rules will hold it.

## 4. Dry-run, show, then turn it on

1. Run the `watchers_test` tool with the watcher's name. It runs once with `since: null`,
   files nothing, and returns the items it would have emitted, with its logs. Do not run
   `watch.js` yourself with `node`: only `watchers_test` runs it as it will really run,
   sandboxed and with the vault. If it returns `problems` or an `error`, fix the files and run
   it again. Zero items is a fine answer when nothing matches today; the logs show whether
   the source was read. Never widen the filter past what the user asked for just to get items
   (a SQLite watcher does not file Postgres posts); say nothing matches yet and carry on.
2. Show the user the first few items, one line each, and the schedule in words (the result's
   `every`, such as "every 15 minutes").
3. Only when they agree, call `watchers_create` to turn it on, after `watchers_test` has
   returned, never in the same batch of tool calls. It turns on exactly what was
   dry-run: if you edit either file afterwards, dry-run again first. It runs once straight away,
   then on the schedule. Tell them `vyre watchers` lists it, `vyre watchers items <name>` shows
   what it filed, and `vyre watchers logs <name>` shows its runs.

If the watcher tools are not available, the watcher runtime is not running on this machine.
Say so plainly and show the two files in your reply. Do not write them to a guessed folder.
