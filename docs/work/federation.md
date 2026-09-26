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

- (none yet)

## Doing

- Task A: the channel (design 1 to 3) and its tests.

## Next

- Task B: federated reads (design 4) and onboarding (design 5, first half).
- Task C: Deck chips and picking (design 5, second half), with the deck owner.
- perf-check on the test box; docs; CHANGELOG.

## Needs from others

- lead: an ADR number.
- deck: review the machine and offline chips (Task C).
- projects, recall, switchboard owners: review the `machines` input and the row labels.

## Changed contracts

- (filled as tasks land)
