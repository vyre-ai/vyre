# watchers

Branch: work/watchers · Worktree: ../vyre-watchers · Milestone: 0.2 · Wave A (per team/0.2/PLAN.md
and team/0.2/plans/watchers.md, reviewed and revised through reviewer-2's pass; not yet re-reviewed)

## Scope

0.1.x scope below stays true; 0.2 adds: `lib/sandbox` (shared with platform's module host, build
step 2b of plans/watchers.md — the uid isolation and mediated-fetch firewall), the structured
`when`/`check`/`do`/`owner`/`lifetime` shape in `folder.js`, the connection/owner scope model (You/
Project/Teammate, `vault.push` consumption), duties-as-watchers with `team.duties.*`, and the
authenticated-trigger + C25-extraction checks for standing permissions (3.1f/3.1g of the plan). The
preview card UI is app-design's, not built here; this worktree builds the runtime it reads from.

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
- Rerun 2026-09-26 after the vault and gate-chat merges, temp `VYRE_HOME` under `/tmp/vyre-lab`,
  `claude -p --model haiku --plugin-dir harness`: the skill loaded, the session wrote
  `hn-demo-sqlite` (HN Firebase API, top 30, parallel fetches), dry-ran it (30 stories read, 0
  match today) and stopped to ask before `watchers_create`, as the skill says, even though the
  prompt had said to go ahead. Turned on with `vyre watchers create`; it then fired on schedule
  under vyred (`schedule` run, 0 filed). Haiku used the highest story id as its cursor, which
  drops older stories that climb onto the front page; the skill now warns against that. The
  grant command was checked against a real vault: `vyre vault grant <item> watchers --watcher
  <name>` prints `granted <item> to watchers/<name>`.

## Doing

lib/sandbox built (2b): addr.js (public-address check), fetch.js (mediated GET/HEAD, DNS pinned, redirects
rechecked, parent-attached credential), identity.js (vyre-sandbox uid when root), wired into run.js/runner.js
(`fetch` IPC verb, child globalThis.fetch replaced) and `net` in watcher.json (declared hosts plus a vault
item attached per host). 27 watchers + sandbox tests pass (note: module.test.js boots an in-process vyred
in a temp home; I ran it once on the Mac before the lead's runners-only rule reached me; from here it runs
on a runner or the test box only). NOT done: the uid/iptables IM1 check (integrator's box image, needs a runner),
retiring raw vault.fetch for plain watchers (still allowed via `needs`). Next: When/Check/Do in folder.js.

Duties (teammates' exact calls, CHAT 09:21): watchers.create with owner/when/instruction/act writes a
duty folder from a fixed template (core/watchers/duty.js), when.js reads the trigger words,
watchers.update/delete/run added, callers limited to module:team or the person. Tests in
runtime.test.js and when.test.js pass; the tool-level caller check is in index.js and is NOT covered
by a test yet (module.test.js boots a daemon: runner only). Still open: ask() for model judgment
(threads.quick), `vault.push` (vault must emit it), filing to the teammate's notes (team.notes refuses
module callers; items go to watchers.items for now, teammates can read them into its brief).

Raw vault release retired (lead's order, reviewer-2 H1): `needs` refused in watcher.json, `vault.fetch` refused
in the child, credentials only via `net` (parent-attached, scrubbed in body/logs with base64/hex/url forms), no
`net` means no network. Skill, use-the-vault line and docs/using/watchers.md updated. module.test.js edited to
the net shape but not run here (daemon: runner only).

ask(): runner verb + run.js handler + runtime.askModel; model via threads.quick (on stage, internal, module-only,
purpose helper); watcher.json `ask: {dailyUsd}`. FINDING: the switchboard's quick answer rides a thread.finished with
cost_usd (core/switchboard/index.js:921) and core/spend's listener records every thread.finished cost, so a quick is
ALREADY in the ledger; recording again under watcher:<name> would double count. So watchers only calls spend.check and
keeps a per-watcher day tally (watchers_spend) for dailyUsd. Attribution by watcher in the ledger needs core/spend to
take a purpose for a quick (asked of iq/lead). Real-tool test of ask() still to write and run on a runner.

Card (3.1c): `summary` in watcher.json, runtime.card + watchers.card, create pinned to the shown hash. The
structured when/check/do PRESETS (mail and the rest, step 6b/9) are not built; the card reads `summary` or derives.

Mail preset (core/watchers/presets.js, watchers.preset, createPreset): runs on vault.push, reads through
vault.request via `net.<host>.credential` (viaRequest in run.js/runtime.js), ask() yes/no, files quoted notes.
Tested against fakes (36 pass). NOT verified against the real vault.request or Gmail: needs a runner with a
throwaway Google account (plan G1). Asked vault to add `gmailId` to vault.push meta rows (saves a search call).

## Next

Build order agreed with the lead (GO message): lib/sandbox first, jointly with platform and the
integrator (2b: own uid, no network namespace of its own, the third mediated `fetch` verb, GET/HEAD
only, parent-attached credentials, private/CGNAT/loopback/link-local refusal after DNS + on every
redirect — platform's module host reuses the identical lib, so land it as a shared library, not a
watchers-only one) — then the When/Check/Do runtime (structured `when`/`check`/`do` in `folder.js`,
the instant card-summary path, no live fetch) — then the connection/owner scope model (3.0/3.8:
`owner`/`lifetime` fields, the zero-setup default, `vault.push` consumption as one more event type
on the already-built `on`/`where` mechanism). The preview card itself waits for app-design's screen.
Do not start the preview card, the authenticated-trigger/C25-extraction step (11b — needs C25 to
exist first), or duties (needs teammates' `team_duties` table) before those dependencies land;
check CHAT.md before resuming in case any of that changed while on hold.

Concrete first steps once unblocked:
1. Confirm with platform/integrator where `lib/sandbox` lives and who's already touched it (CHAT.md
   06:10/01:10 agreed the shape; check for a branch before starting a second one).
2. `run.js`/`runner.js`: add the network-namespace isolation and the mediated `fetch` IPC verb;
   retire raw `vault.fetch` release for plain/standing-permission watchers; separate uid for the
   child.
3. `folder.js`: the structured `when`/`check`/`do`/`owner`/`lifetime` fields, spec/check additions,
   the `summary` field, instant card-text derivation.
4. Real-Registry tests for both, not the fake registry reviewer-2 flagged in platform's own review
   (reviews/platform.md CR-H1..H4) — same fail-closed lesson applies here if lib/sandbox is shared
   code.

## Needs from others
- **platform + integrator**: where `lib/sandbox` lands and its exact module boundary (this worktree
  needs to land 2b against it, not duplicate it).
- **vault**: the CONNECTIONS layer's grant-shape reuse (`{projects, agents}`, plans/watchers.md 3.0/
  3.8) is still open as of the last plan revision — check CHAT.md for an answer before building the
  owner-scoped grant check.
- **sessions/vault/assistant**: C25's real contract name and shape (this plan used the placeholder
  `threads.said`) — needed before build step 11b (authenticated triggers, permission-field refusal)
  can be more than a stub.
- **teammates**: `team_duties` table + `team.charter`'s context-composing pattern, needed before
  duties-on-the-runtime (build step 9).
- vault: nothing outstanding on the 0.1.x per-watcher grant path. On main the runtime fetches with
  `{ watcher }` and grants are per watcher. The use-the-vault skill still says a watcher "lists it
  under needs and calls vault.fetch", which is true but leaves out the per-watcher grant; worth one
  line there.
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
