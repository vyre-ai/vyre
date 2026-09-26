# federation

Branch: work/federation · Worktree: ../vyre-federation · Owner session: tailnet teammate ·
Decisions: ADR number requested from the lead (0015 is capsule-sight)

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

## Doing

- (nothing; Task B is next)

## Next

- Task B: federated reads (design 4) and onboarding (design 5, first half).
- Task C: Deck chips and picking (design 5, second half), with the deck owner.
- perf-check on the test box; docs; CHANGELOG.

## Needs from others

- lead: an ADR number.
- deck: review the machine and offline chips (Task C).
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
