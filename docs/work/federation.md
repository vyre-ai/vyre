# federation

Branch: work/federation · Worktree: ../vyre-federation · Owner session: tailnet teammate ·
Decisions: [ADR 0021](../adr/0021-box-reads-the-mac.md)

## Scope

The box reads the paired Mac's sessions through the link. ADR 0008 step 3 says "the Mac's
sessions stay on the Mac ... the box reaches them through the link", and nothing built that: the
link only runs Mac to box (`ctx.remote`, `link.call`, the events proxy). This workstream adds the
box-to-Mac direction and federates the box's catalog, search, sessions and threads with the
Mac's, labelled by machine, degrading to "Mac offline", and never storing a Mac transcript on the
box.

## Design

1. **Reverse channel, no listener on the Mac.** A paired Mac holds one long-poll to the box, the
   box tool `link.serve { key }`: the box answers with the next queued request, or `null` after
   `HOLD` (60 s, a seam in tests). The Mac runs it and answers with `link.reply { key, id, result }`,
   then polls again. Both tools check the pairing key and the pinned stableId (`byKey`), as
   `link.hello` does. No new port on the Mac, so no macOS firewall prompt. Idle cost: one held
   request a minute. When a call fails the loop stops, and the next successful heartbeat
   (60 s) starts it again, so a box that is away costs nothing extra.
2. **`link.macs.call { tool, input, timeout? }`** (box, `internal`: modules only). Fans out to
   every paired Mac and answers `[{ mac, name, ok, data?, error? }]`. A Mac with no `serve`
   waiting and none in the last 3 s answers `mac_offline` at once; otherwise the request waits
   up to `timeout` (default 5 s, max 15 s) and answers `timeout`.
   **`link.macs`** (box): `[{ mac, name, node, online, lastServe }]`, for surfaces.
3. **Allowlist, both sides.** Box refuses anything else before queueing; the Mac refuses anything
   else before running: `projects.catalog`, `projects.list`, `recall.search`, `recall.sessions`,
   `recall.thread`, `threads.list`. The Mac runs them as `module:link`. `recall.thread` is the
   only one that returns transcript turns, and only when a surface opens that session.
4. **Federated reads on the box.** `projects.catalog`, `projects.list`, `recall.search`,
   `recall.sessions`, `recall.thread`, `threads.list` gain `machines: "all"|"local"`.
   Federation runs only for the person (callers `deck`, `cli`, `local`, `capsule`, and
   `tailnet:<login>` that is not an agent node or a guest) with `machines` not `"local"`, or for a
   module that passes `machines: "all"`. Agents, guests and MCP get the box's own rows as today.
   Every row gains `source: "box"|"mac"` and `machine` (the box's or the Mac's name). Return
   shapes are otherwise unchanged; objects (`projects.catalog`) also gain
   `sources: [{ source, machine, ok, error? }]`. `recall.thread` asks the Mac only when the
   session is not on the box, or when `source: "mac"` is given. Nothing from the Mac is written
   to the box's store.
5. **Surfaces.** Onboarding's history step counts the Mac's sessions and says
   "Your Mac (<name>) is offline" when paired but not polling. The Deck shows a machine chip on
   Mac rows and an offline chip from `link.macs`. Picking a Mac session into a box project keeps
   its id; the project's thread list resolves it through the Mac.

## Done

- Task A, the channel (design 1 to 3), ac9df2d. `link.serve`/`link.reply` on the box, the Mac's
  serve loop, `link.macs.call` and `link.macs`, the allowlist at both ends. Tests on the test box:
  test/link.test.js 8/8, test/link-federation.test.js 7/7 (twice), core/link/transport.test.js
  3/3, test/hygiene.test.js 1/1. Choices beyond the design: a Mac working on a question counts as
  online (it answers one at a time, so a slow search must not make it look gone); an unknown key
  on `link.serve`/`link.reply` answers `{ paired: false }` like `link.hello`; the box's `allow` and
  `hold` are test seams; `transport.open` takes an AbortSignal so stopping or unpairing the Mac
  ends its held request at once.

- Task B, federated reads and onboarding (design 4, design 5 first half). Main merged in first
  (e3eb0cb); work in 442bab7, a8663d1 (ci's snapshots of it before the history rewrite), 9d69183
  and the feat commit after it. `core/modules/federate.js` holds who federates (`wantsMacs`), the
  ask (`askMacs`, never throws, `[]` without the link) and the labelled merge (`mergeRows`,
  `sourcesOf`). Tests on the test box, one file at a time: test/federation-reads.test.js 6/6,
  core/modules/federate.test.js 3/3, test/link.test.js 8/8, test/link-federation.test.js 7/7,
  core/modules/modules.test.js 22/22, core/projects/projects.test.js 17/17,
  core/recall/recall.test.js 29/29, core/recall/module.test.js 5/5, core/recall/eval.test.js 5/5,
  core/switchboard/switchboard.test.js 24/24, test/onboard.test.js 11/11,
  test/onboard-page.test.js 0 (1 skipped: no Chrome there), test/hygiene.test.js 1/1,
  core/harness/floor.test.js 8/8, core/learn/learn.test.js 43/43, core/learn/signals.test.js
  26/26, core/memory/access.test.js 4/4, core/memory/scope.test.js 10/10,
  core/watchers/runtime.test.js 9/9, deck/test/memory.test.js 15/15, test/projects-cli.test.js
  4/4. federation-reads ran 25 more times green (10 of them 5 at once, load 9.9); one earlier run
  had 1 failure that did not repeat and was not captured, and the onboarding test now waits for
  the Mac's answer rather than the first status. perf-check: CPU p95 0.00%, sustained 0.00%, RSS
  mean 88.2 MB, max 136.0 MB, no timer under 60 s.
  Choices beyond the design:
  - Rows are labelled only in a federated answer. `machines: "local"`, agents, MCP, guests and
    modules that do not ask get today's rows unchanged, so no existing caller sees a new field.
  - `projects.list` is an object (`{ projects, problems }`), not an array: box projects then each
    Mac's, not re-sorted; `problems` merged the same way; `sources` added as on the catalogue.
  - The catalogue sorts the merged rows as it sorts its own: title match, then how often said, then
    `last` (newest first; without q only `last` differs). Its `sources` carry each machine's
    `total`, which onboarding uses.
  - `threads.list` rows are switchboard records; merged by `last` (newest first), no cap (each
    machine caps at 200). `recall.sessions` merges by `ended`; `recall.search` by `score` (the two
    machines' scores come from different corpora: good enough for one list, not a strict ranking).
  - `recall.thread` falls through to the Macs only on "no session ..." from the box; an ambiguous
    prefix on the box is still an error. Found nowhere: `no session <id> (test-mac: failed)`, with
    the Mac's code (`mac_offline`, `timeout`) in place of `failed`.
  - Onboarding asks the catalogue with `limit: 1` (total does not depend on the limit; it asked for
    100000 rows before). Done-ness compares the box's index with the box's own sessions only; the
    Mac indexes its own.

- Onboarding holds the box's federated catalogue answer for 30 s, keyed on the Macs' online
  state from `link.macs` (the box's own record), so the page's 2 s poll asks the Mac at most twice
  a minute and still says "offline" at once. The federation-reads spy counts only tailnet callers:
  it used to count the box's own background module calls, the likely cause of Task B's one
  unexplained failure. Tests on the test box: onboard + federation-reads + core/onboard +
  hygiene 18/18 three times at load 14.8; federation-reads + link-federation + link 21/21 three
  times.

- Task C, picked Mac sessions and the Deck (design 5, second half). 129e747 (core), 002533b
  (Deck), and the docs commit after them. Tests on the test box, one file at a time:
  test/federation-reads.test.js 7/7, core/recall/recall.test.js 29/29, core/recall/module.test.js
  5/5, core/recall/eval.test.js 5/5, core/projects/projects.test.js 17/17,
  core/modules/federate.test.js 3/3, test/link.test.js 8/8, test/link-federation.test.js 7/7 (10
  of 11 runs; one run had 1 failure that did not repeat in the next 10 (load 8 to 10) and was not captured; the
  file is untouched here), test/projects-cli.test.js 4/4, core/cli/commands/home.test.js 7/7,
  test/onboard.test.js 11/11, test/fixtures.test.js 1/1, test/hygiene.test.js 1/1,
  deck/test/machine.test.js 5/5 (new), deck/chat/lib/sessions.test.js 4/4 (one new),
  deck/test/memory.test.js 15/15, deck/test/memory-presence.test.js 16/16, deck/chat/lib diff 8/8,
  highlight 11/11, markdown 14/14. `node --check` clean on every Deck file touched. No
  screenshots: the test box has no Chrome.
  Core:
  - `recall.sessions { ids }`: exact ids (at most 1000; an empty list is no sessions), combined
    with the other filters.
  - The box's `projects.threads`: when `wantsMacs` holds and the project has picks the box has no
    session for, it asks the Macs once (`askMacs`, `recall.sessions { ids, limit }`). Found rows
    take name, title, cwd, started, last (the Mac's `ended`), turns and human from the Mac, a
    fresh `label`, `missing: false`, `source: "mac"`, `machine`. The box's rows are labelled
    `source: "box"` (a federated answer); a pick no machine has stays `missing: true` with no
    label. Order: newest first, missing last. `projects.context` still reads `threadsOf` directly
    and drops missing picks, so the brief never carries a Mac session.
  Deck (every action made read-only for a Mac row is listed under "Changed contracts"):
  - `deck/js/machine.js`: `isMac`, `machineChip` (a `.tag.machine` with the machine's name),
    `readOnlyNote` ("On alex-mac. Open it there to continue."), `offlineNames`, `offlineChip`
    ("alex-mac offline", dashed), `readMacs(attempt, prev)` (link.macs; keeps `prev` while the
    page is hidden; no link means no Macs). CSS in deck.css next to `.tag`.
  - Chips on: Chat's recent rows, project rows and header, the rail's thread links and project
    groups; Now's working rows and recent sessions; search results; a project board's threads; the
    loose thread page header. Offline chip: Chat's header (list and project) and Now's Working
    head, read in the same load as the view's other reads.
  - Choices beyond the brief: a Mac project in /projects is listed with the chip and the note but
    no board and no pin, and the rail's pins and Now's recent projects leave Mac projects out
    (each opens a board on the box). The board reads `threads.list` with `machines: "local"` (a Mac
    thread names the Mac's projects). Now's "learned today" reads the catalogue with
    `machines: "local"` (it maps Memory's sessions, and asked the Mac for 500 rows on every
    `memory.curated`). A Mac row in Now links to `/threads/:id`, not the Mac's project slug.
    "Add to a project" on a Mac thread offers the box's projects only.

- A race on main, surfaced by these tests' 100 ms heartbeat: a heartbeat in flight while the Mac
  unpaired wrote `{ revoked: true }` with no box into link.json, and the Mac's `link.status`
  threw until the file was fixed. `hello()` now drops an answer about a pairing that is gone
  (core/link/mac.js). link-federation + federation-reads, three at once, four rounds: 12 of 12
  (2 of 9 failed before). link + hygiene 9/9.

## Doing

- (nothing; Task C is done)

## Next

- A browser pass on the fixture Deck (`?fixtures=1` on a machine without the link, or a box with
  a paired Mac): chips in Chat, Now, search and a project board; a Mac thread in Chat and at
  /threads/:id shows no composer and the note; the offline chip in Chat and Now. Screenshots
  from a test world only.
- Chat's rail groups by project slug, and a Mac project whose slug is also a box project's shares
  that group (both chips show). Worth a decision with the deck owner if it confuses.

## Needs from others

- lead: ADR 0021 assigned (done).
- deck: review the machine and offline chips, the read-only rule and the choices above (Task C).
- projects, recall, switchboard owners: review the `machines` input and the row labels.

## Changed contracts

- New box tools: `link.serve { key }` (answers `{ id, tool, input }`, `null` after the hold, or
  `{ paired: false }`), `link.reply { key, id, result }` (`{ ok }`, or `{ paired: false }`),
  `link.macs.call { tool, input?, timeout? }` (internal: modules only; refuses a tool outside the
  list with `denied`; answers `[{ mac, name, ok, data?, error? }]`, errors `mac_offline`,
  `timeout`, `unpaired`, `stopped` or the Mac's own), `link.macs` (`[{ mac, name, node, online,
  lastServe }]`, visible like `link.peers`).
- The allowlist `ALLOW` in `core/link/allow.js`: `projects.catalog`, `projects.list`,
  `recall.search`, `recall.sessions`, `recall.thread`, `threads.list`.
- The Mac's `link.status` gains `serving`. `boxCall` takes `{ timeout, signal }`; the connector's
  `open`/`json` take `signal`. The link seams gain `hold` (both sides) and `allow` (box).
- Tests: `pair()`, `tailnet()`, `until()`, `wait` and the OWNER/MAC/PHONE/BOX constants moved to
  `test/link-harness.js`. `pair()` takes `hold` (default 300 ms), `allow` and `macTranscripts`,
  and returns `boxRoot` too.
- `machines: "all" | "local"` on the input of `projects.catalog`, `projects.list`,
  `recall.search`, `recall.sessions`, `recall.thread`, `threads.list` (every role accepts it; only
  the box acts on it). `recall.thread` also takes `source: "box" | "mac"`.
- In a federated answer every row gains `source` ("box" | "mac") and `machine` (the box's
  `config.name`, else "box"; the Mac's paired name). `projects.catalog` and `projects.list` gain
  `sources: [{ source, machine, ok, error?, total? }]` (box first; `error` is the Mac's code, such
  as `mac_offline` or `timeout`; `total` on the catalogue only). `recall.thread` gains top-level
  `source` and `machine`.
- Onboarding's `detail.history` gains `machines: [{ machine, source, sessions, ok }]` on the box,
  and `sessions` counts the Mac's too.
- New shared file `core/modules/federate.js` (`wantsMacs`, `askMacs`, `mergeRows`, `sourcesOf`,
  `boxLabel`, `macLabel`, `label`). `pair()` takes `boxTranscripts` (sessions in the corpus's
  shape for the box to index).
- `recall.sessions` takes `ids: string[]` (exact ids; `sessions(db, { ids })` in
  core/recall/search.js). `projects.threads` takes `machines` and, on the box for the person,
  resolves missing picks through the Macs: those rows gain `source: "mac"`, `machine` and
  `missing: false`; the other rows gain `source: "box"`, `machine`.
- Deck: new `deck/js/machine.js` (the chip helper and the read-only rule), `.tag.machine`,
  `.machine-offline`, `.readonly-note` in deck/css/deck.css, `.now-count` in now.css. Chat's `Row`
  (deck/chat/lib/sessions.js) gains `source` and `machine`, and so does its offline snapshot.
  `mountSession` takes `source` and `machine`. Projects' `drawComposer` takes `machine`.
- Deck actions a Mac row no longer offers (hidden, with the note in their place):
  - Chat session view (deck/chat/session.js): the composer (threads.send, and threads.lease on
    typing) is never mounted; the lease bar's "Take" (threads.lease) and "Sending resumes this
    session here" give way to the note; threads.get is skipped and recall.thread is asked with
    `source: "mac"`; readMore on session.indexed is off.
  - Projects thread pane (deck/views/projects.js `threadPane`, `drawComposer`): the reply box
    (threads.send), "Take the keyboard" (threads.lease) and the lease follow are replaced by the
    note; a Mac switchboard thread is not opened with threads.get.
  - /projects list: a Mac project has no board link and no pin button.
  - Now (deck/views/now.js `workRow`): no Watch link (it pointed at the Mac's agent or project);
    the row opens /threads/:id read-only.
  - Rail pins (deck/js/app.js `drawRail`) and Now's recent projects: Mac projects are left out.
  - Not touched, and why: Chat's `threadRow`/rail links only open a session (read); needs cards,
    asks and the Gate are the box's own (a Mac's asks never reach the box); the agents view lists
    the box's agents and uses threads.list only to name their threads.
- Fixtures: `deck/fixtures/threads.json` `threads.list` gains one Mac thread (source "mac",
  machine "alex-mac"); new `deck/fixtures/link.json` answers `link.macs` with alex-mac online and
  alex-air offline. There are no projects, recall or catalogue fixtures (those modules are live
  wherever the Deck runs), so none were added.

## Notes for Task B

- The Mac runs the box's input as given, as `module:link`. Once the Mac's own tools federate
  toward the box, a module caller without `machines: "all"` must stay local, or the Mac would
  ask the box, which asks the Mac.
- The Mac answers one question at a time. Fanning out catalog and search together from the box
  queues the second behind the first; fine for reads this size, worth measuring with a large
  corpus.
- A Mac that drops off while holding a request keeps looking online on the box until the hold
  runs out (60 s): a question in that window times out rather than answering `mac_offline`.
- Pre-existing, not ours: core/cli/commands/box.test.js "box add: sudo with a password ..." fails
  on the test box on this branch without these changes too.

## Notes for Task C

- A Mac row is told apart by `source: "mac"` and `machine`. Ids are Claude Code session ids, the
  same on the Mac. Picking one into a box project with `projects.add-threads` stores the bare id,
  as today. The box's `projects.threads` builds its list from the box's own recall rows
  (`threadsOf`), so a picked Mac id comes back `missing: true` with no name. Resolving it means
  asking the Mac for those ids: `recall.sessions` has no id filter, `recall.thread` per id moves
  turns, and `projects.catalog` with a large limit moves every row. A small `ids` filter on
  `recall.sessions` (already on the allowlist) is the cheapest fix.
- A Mac row's `projects` in the catalogue are the Mac's own project slugs, not the box's.
- The onboarding page polls `onboard.status` every couple of seconds; on the box each poll now asks
  the Mac for one catalogue row. Cheap, but it is traffic while the page is open; the Deck's
  offline chip should read `link.macs` rather than ask again.
- The Mac answers one question at a time, so a busy Mac delays the next read up to the link's 5 s
  timeout; the Deck should show the box's rows first if it ever waits on that.

