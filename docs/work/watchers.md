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

## Done
- Runtime, module, CLI and skill on `work/watchers` (commits listed in the branch log).
- Tests: `core/watchers/cron.test.js`, `runtime.test.js` (real children, stubbed clock, vault,
  projects, Memory), `module.test.js` (a real vyred with a stub vault module registering internal
  `vault.release`, real projects and Memory, the webhook route over the socket).
- Real, with a temp `VYRE_HOME` under `/tmp/vy-w-demo`: `claude -p --model haiku --plugin-dir
  harness`, asked "Watch the Hacker News front page for posts about SQLite and file them into this
  project", loaded the skill, called `watchers_list` and `projects_of`, wrote the folder, dry-ran
  it (0 items: no SQLite post on the front page today), and on "yes, every 5 minutes" edited,
  re-tested and created it. A second session wrote a Show HN watcher that filed a real post,
  which `memory.facts {project_cwds: [the project folder]}` returned as `taught by watchers`.
  Both ran on schedule under vyred (`watcher.fired` with trigger `schedule`).
- Five real sessions shaped the skill; see the changelog.
- Merged main: the stub vault is gone. Fetches carry `{ watcher, field? }`; the module test puts
  an item in the real vault (file keystore), shows the dry run refused until
  `vault.grant {name, module: "watchers", watcher}`, that a second watcher listing the same item
  is still refused, and that `vault.released` names the watcher.

## Doing

## Next
- A Deck panel (`panel:watchers` is declared) once the deck stream wants it.
- Webhooks from outside the machine arrive once networking (box stream) serves vyred on the
  tailnet; today the route is on the local socket only.

## Needs from others
- vault: nothing outstanding. On main the runtime fetches with `{ watcher }` and grants are per
  watcher. The use-the-vault skill still says a watcher "lists it under needs and calls
  vault.fetch", which is true but leaves out the per-watcher grant; worth one line there.
- projects: nothing adds a watcher to a project's `project.json` `watchers` list yet (spec 7.2).
  The runtime files by `watcher.json`'s `project`, so nothing depends on it; a
  `projects.add-watchers` tool would let the brief mention them.
- harness: the brief could say this machine runs watchers, so a model reaches for the skill
  before `/loop`. Haiku picked `/loop` once when the description was weaker.

## Changed contracts
- Registry (`core/modules/index.js`): a tool registered with `hook: true` is callable only by
  caller `"hook"` and is left out of `listTools`. Every other tool refuses caller `"hook"`.
  vyred maps a socket client's claim to be `"hook"` to `"local"`, so only the route can make it.
- vyred (`core/daemon/index.js`): `POST /v1/<module>/<name>/hook` calls `<module>.hook` with
  `{ name, token, body }` (token from `x-vyre-token` or `?token=`), as caller `"hook"`; 202 on
  success, 403 when the tool refuses, 404 when there is no hook tool.
- `watch({ vault, since, emit, log, hook })`: `hook` is new (the webhook body, else null), and
  `watch` may return the next cursor.
- Items: `{ id, title?, url?, at?, about? , ... }` under 4 KB. `about` names what an item concerns;
  it becomes the taught fact's subject (default: the watcher's name).
- `watcher.json` accepts `timeout` (seconds, at most 300) and `description`; any other extra key
  is refused, so a credential cannot be parked there.
- Taught fact per item: `{ subject: { name: about || watcher }, text: "title · url", at, key:
  "<watcher>/<id>", project_cwds: <project folders> }`, kind `watcher.item`.
- Events: `watcher.created {name, project, schedule}`, `watcher.fired {name, items, seen,
  trigger}` (items = newly filed), `watcher.failed {name, error, failures, paused}`,
  `watcher.paused {name, why}`, `watcher.resumed {name}`. Each carries the project.
