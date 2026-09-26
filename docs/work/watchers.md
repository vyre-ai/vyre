# watchers

Branch: work/watchers · Worktree: ../vyre-watchers · Milestone: M4 · Wave 1

## Scope

Owns `core/watchers/`, `core/cli/commands/watchers.js`, and `harness/skills/write-a-watcher/`
(it exists; refine it once the runtime is real).

A runtime, not integrations. Claude writes watchers (the skill), Vyre runs them. Do not build a
Gmail or Slack integration. The contract is in spec 7.6 and in the skill:
`~/.vyre/watchers/<name>/watcher.json` + `watch.js` exporting `async watch({ vault, since, emit, log })`.

- **Scheduling.** Cron expressions (write a small parser: 5 fields, `*`, `*/n`, lists, ranges)
  and `webhook` (a route under `/v1/watchers/<name>/hook`, secret-token checked).
- **Isolation.** Each run in a child process (`node --permission` with fs read limited to the
  watcher's folder where the Node version supports it), with a timeout, no inherited env. Values
  come only through `vault.fetch` from that watcher's own `needs` (the module declares
  `needs.vault: ["per-watcher"]` and must check each watcher's list itself).
- **Cursor, dedupe, retries.** `since` saved after a successful run; items deduped by `id`; failures
  retried with backoff; three failures in a row pauses the watcher and emits `watcher.failed`.
- **Filing.** Each item becomes a `watcher.item` row in the watcher's project and is taught to
  Memory with `ctx.memory.teach("watcher.item", ...)` (declare it under teaches).
- **Dry run.** `watchers.test` runs once with `since: null`, files nothing, and returns the items.

## Tools

`watchers.create {name}` (validates and enables a folder Claude wrote), `watchers.test`,
`watchers.list`, `watchers.pause`, `watchers.resume`, `watchers.logs`, `watchers.items {name|project}`.

## Events

`watcher.created`, `watcher.fired {name, items}`, `watcher.failed`, `watcher.paused`.

## Needs

`ctx.vault` is in core already. Until the vault stream merges, test with a stub vault module
that registers internal `vault.release`.

## Done when

A real Claude Code session with the Harness, asked "watch the Hacker News front page for posts
about SQLite and file them into a project", writes a watcher through the skill, dry-runs it, and
it runs on schedule under vyred (a public source, so no credentials are needed for the demo).
