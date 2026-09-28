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

- The browser look (the pass "Next" asked for). `deck/test/mac-world.js` (a box and a Mac in one
  process, paired as the link tests pair them; Mac: Harlow intake, Northwind invoices, weekly
  planning; box: the Harlow site rebuild and its subagent, the headless Northwind summary; a box
  project Harlow Legal) and `deck/test/mac-shots.js` (asserts each chip or note, no sideways
  scroll, no page errors). Run on the test box's shared headless Chrome. Shots, 1440 and 390 each
  (in <team-dir>/shots/federation/): chat-list, chat-mac-session, now, search, board,
  onboard-history, chat-offline, now-offline. 15 of 16 checks pass; no console errors on any page.
  The offline chip appeared within about 7 s of `/__mac/off` (hold 2 s plus the 5 s window).
  Right: Mac rows carry the alex-mac chip in Chat, Now, the header search and the board; box rows
  carry none; a Mac session reads its turns with no composer and the note "On alex-mac. Open it
  there to continue."; the picked Mac session resolves on the board with the chip and the note;
  the dashed "alex-mac offline" chip sits beside Chat's title and in Now's Working head, and Mac
  rows drop out while it shows.
  Wrong, for the pwa / deck owners (none fixed here):
  - Find page (/find, the phone's search): Mac sessions have no machine chip (the check that
    fails), and it says "Files on your Mac show here when your Mac is online." while the Mac is
    online.
  - Onboarding history (deck/onboard/onboard.js): the meter reads `recall.status`, the box's own
    index, so it says "3 sessions" while `onboard.status` counts 6 (3 box, 3 Mac); it never shows
    `detail.history.machines` or "Your Mac (alex-mac) is offline". The picker lists the Mac's
    sessions with no chip. On the phone it read "Reading sessions" at about a third, the desktop
    load a moment earlier said done.
  - Chat's project row says "Harlow Legal 1 session" while the board lists 2 threads (the picked
    Mac session is not counted).
  - Now on a phone: the chip sits on its own line between title and meta, so Mac rows are a line
    taller than box rows; on the laptop it sits inline after the title. The chips are below two
    setup cards (passkey, assistant), off the first screen.
  - The rail footer shows the machine's OS hostname (`system.info` host) with "On this machine
    only", not the box's name (harlow-box); onboarding's header says "Setting up alex-box" (the
    fake tailnet's name). Three names for one box.
  - Board thread pane header says "on alex-mac" in plain text while everywhere else uses the
    chip; Chat's session header has the chip plus a grey status dot that means nothing for a Mac
    session.
  - Not ours: at 1440 the address pill wraps a long /chat/thread/<id> path onto two lines.

- Sending to a Mac session (ADR 0021, "Sending to a Mac session"). Main merged first (8b5dabe);
  work in d15d21c. The person on the box types into a Mac's session; a session busy in a
  terminal queues the words on the Mac; the thread's events come back to the box's bus labelled
  with the Mac. Tests on the test box: test/federation-send.test.js 7/7, three runs in a row and
  two copies at once (7/7 each); test/link.test.js 10/10, test/link-federation.test.js 7/7,
  test/federation-reads.test.js 7/7, core/switchboard/switchboard.test.js 31/31,
  core/harness/floor.test.js 8/8, core/harness/harness.test.js 12/12, test/harness.test.js 15/15,
  test/hygiene.test.js 1/1. Choices: the box remembers which Macs it sent a thread to at queue
  time (not at the answer), since the Mac's first batch can beat its reply; a Mac that answered
  with an error other than a timeout is struck off at once. A widened test `allow` list sends
  `threads.send` as a read, without `as`, which is how the Mac's own refusal is tested. A timeout
  answers `timeout`, "<name> did not answer in time; your message may not have been sent". The
  Mac's `link.status` gains `following`. `threads.unqueue` does not exist on main, so WRITE is
  `threads.send` alone.

  What the Deck sees from `threads.send` for a Mac thread (as the person, on the box):
  - sent: `{ sent: true, thread, source: "mac", machine: "alex-mac" }`
  - busy in a terminal: `{ sent: false, queued: true, open_elsewhere: true, thread, name,
    busy: "terminal", note, source: "mac", machine }`, note "<name> is busy in your terminal on
    alex-mac. I'll hand it your message when this turn ends."
  - another surface on the Mac holds the keyboard: queued the same way, `busy: "<holder>"`, note
    "<name> is in use in <holder> on alex-mac. ..." (the box never takes the keyboard).
  - Mac offline: error `{ code: "mac_offline", message: "alex-mac is offline; your message was not sent" }`
  - no machine has it: the box's own error `{ code: "failed", message: "no thread <id>" }`
  Then, on the box's event stream, with `thread` in the envelope, `project` null and the source
  module "link": `thread.queued { queued, text, surface: "box:deck" }`, `thread.sent { text,
  surface, queued?, via? }`, `thread.text { message, delta }` and `{ message, text, done: true,
  notice? }`, `thread.finished { ok, cost_usd?, via? }`, `thread.stopped { code, reason }`,
  `thread.contended`, `thread.limit`; every payload also carries `thread`, `source: "mac"` and
  `machine`.

- **Answering a Mac's ask from the box** (ADR 0021 "v2", ADR 0030 step 7). The box's Ed25519
  key (core/link/assert.js, `link-assert-key.json` at 0600 in its home), pinned by the Mac at
  pairing or once over the pinned channel by a Mac paired before. Every Mac ask reaches the box
  (`ask.raised`, `ask.answered`, labelled `source`, `machine`, `node`). `threads.answer` on the
  box, for the person, forwards to the Mac that raised the ask with an assertion bound to that
  Mac, ask and exact input for 60 s and one use; the Mac checks all of it before running as
  `link:box`, and refuses with `denied` otherwise. Decisions:
  - How the box knows an ask is a Mac's: the relayed `ask.raised` (the box remembers ask -> Mac),
    with a `machine` input as the fallback after a box restart. No hint and no record means the
    box's own answer; an assertion never goes to every Mac.
  - Asks are forwarded for all Mac threads, not only followed ones: the phone must see every
    ask, asks are few, and it costs a listener and the existing batches, no timer.
  - No follow for an answer: `write()` follows `input.thread`, which an answer has none of, so it
    is free and nothing was added.
  - `machine` on relayed ask events is the Mac's name (as mergeRows and the relayed thread events
    label them), and `node` carries its stableId.
  - The Mac learns its own node from the box (`you.stableId` in pair.poll and hello), since the
    Mac never asks Tailscale about itself; A.mac is checked against it.
  - The box's learn module ignores relayed asks (`source: "mac"`); the Mac's learn counts them.
  - A socket client may not claim a `link:` caller label (core/daemon FORBIDDEN_LABEL), now that
    `threads.answer` lists `link:box`.
  - The lead's conditions (after 06441c6f): an owner device forwards only in a person session
    (`person_session_required` otherwise, nothing signed); gated asks (`gatedAsk`: a HUMAN_ONLY
    tool by exact name or exact Vyre MCP name, or `presence.required: true`) need a fresh proof
    on the box (`presence_required`; a presence session is not one) and the Mac checks it again
    from its own ask. An unseen ask named by `machine` counts as gated. A carries `person` and
    `presence`. The spent-nonce set already kept each nonce until its exp and refused when full.
  - Held: the Mac-owned default (the Deck answering Mac asks for owner devices) stays held until
    e2e's person session is live on the box; until then only the socket's callers and a
    device already carrying a person session get through.

## Doing

28 Sep 2026, later the same day: the user overruled a condition — unpairing, turning sync off, or
losing a device deletes nothing; what it brought is the person's. Reworked: `sync.consent { on:
false }` and `link.unpaired` now only stop new uploads and emit `sync.revoked` informationally.
New `sync.delete { machine }` (person-only) is the one thing that deletes `synced/<machine>/`,
emitting `sync.deleted`. Built `sync.send { files, mode }` too (agreed with memory-iq: they own
`import.start`/`import.scan`/`import.plan`, module-only door into this) — walks a file list
through `sync.upload.plan/start/finish`, acking each file and a done summary (`sync.sending`,
`sync.sent`), which is also cohesion's "synced" status-event ask (interaction.md, sha 5debc1bc)
folded in rather than built twice. New carrier `link.upload` on the Mac (core/link/mac.js) for the
one thing `link.remote`'s JSON-only channel can't send: the chunk bytes, as a Buffer, straight to
the box's raw route. `link.pair`/`link.pair.request` take `kind`.

New test core/sync/sync-send.test.js: a real file, over a real paired link (test/link-harness.js's
`pair()`, `router: true`), through the actual daemon route — the HTTP-level gap flagged in the
previous entry is closed for the common path (resume-after-restart and Windows are still
untested, no client exists yet). core/sync/sync.test.js updated for the keep-everything behavior.
Tests on the test box, nice -n 15, load under 5: 113/113 across core/sync + core/link + link +
link-federation + federation-answer + federation-send + federation-reads + boundaries + hygiene +
docs-build. Sent to e2e, memory-iq, and the lead. Replied to memory-iq's module-ownership question
(sync.deleted, sync.revoked and the acks are all core/sync's, confirmed) and cohesion's ask
(folded into sync.send rather than answered separately).

Still open: whether `import.start` records consent by calling `sync.consent` itself (my
recommendation, so the box's copy of the switch stays the one and only record — see the message
to memory-iq) or some other path; the plan-hash re-consent question memory-iq raised (not built:
`sync.consent` is on/off only, no plan binding yet); "Replace this device" (whose folder name the
new device's files land under is undecided — flagged back to memory-iq); Drive onboarding
(docs/design/drive-onboarding.md, the lead's ask) not started this round.

28 Sep 2026: session import (ADR 0008 5a) pulled forward to 0.1.1, memory-iq leading, this stream
owning the transport. Built the box side: new module core/sync (`sync.consent`,
`sync.upload.plan/start/chunk/finish`), core/sync/scrub.js (content secret scan at ingest,
quarantine not redact), `link_peers.kind` ("mac"|"device", capability lives on the peer row per
e2e's review, not a second identity path) plus `link.peer-of` for core/sync to resolve a
connection's own tailnet node without reaching into link's table, and a dedicated daemon route
(`POST /v1/sync/upload/<id>`, raw octet-stream body, never JSON). Design doc:
docs/design/federation-plan.md (work/federation-transcript, f7108e07) has the full ownership split
with memory-iq's import.* tools (they own the device-facing surface and consent recording;
`import.start` calls our sender). CHANGELOG has the file-by-file detail.

Not built yet: the device-side sender (`sync.send`, which walks a plan and calls
`sync.upload.start/chunk/finish` against the box — this is what `import.start` actually calls),
a Windows client (this protocol works for any client; nothing Windows-specific was needed on the
box side), and a real HTTP-level test of the new daemon route (the tool logic underneath it is
tested directly and thoroughly; the route itself is a small, mechanical body-reading and
status-code layer). Refactor note for whoever builds `sync.send` next: an earlier draft put the
sync.* tools inside core/link/box.js directly, using link_peers columns (sync_on, used_bytes,
quota_bytes, a link_synced_files table) — this failed the registry's own naming rule (a tool must
start with its module's name) and would have coupled sync's data to link's schema besides. It's a
separate module now, on purpose; don't merge it back into link.

Tests on the test box, nice -n 15, load under 6: 13/13 on core/sync/sync.test.js, 4/4 on
core/sync/scrub.test.js, 110/110 across core/sync + core/link + link + link-federation +
federation-answer + federation-send + federation-reads + boundaries + hygiene + docs-build. One
run caught my own mistake: two secret-shaped literals in the new tests tripped hygiene's own
scanner, since it scans all of core/ (fixed: built at run time instead, as the existing switchboard
redaction fixture already does).

28 Sep 2026: e2e signed off work/federation at aa9cb40c, with one nit: `!cfg.receive` counts the
string "false" as on. Fixed (`cfg.receive !== true`), with a test trying several truthy-but-wrong
values. Also tried adding files.receive as a real declared setting (core/files/module.json
"settings", ADR 0035) so it would show in Settings, not just config.json — reverted: a
device-level setting has no `store.config` (settings.set refuses it, "a device's value is kept in
the hub, so a setting set per device has no store"), which broke every drop.test.js test since
the files module failed to start. Wiring files.receive through the hub properly is follow-up work
for whoever picks up Settings-facing polish, not a blocker: the config.json switch is what both
reviewers signed off on. Tests on the test box, nice -n 15, load under 5: 18/18 on drop.test.js
(1 new) + hygiene, 96/96 on `core/files/**/*.test.js` + docs-build. Sending the sha to the
integrator next.

28 Sep 2026: e2e amended their f712e7d7 review after reading 0c645473 (files.deliver) more
closely — not signed off for that part, since it wasn't flagged as included when asked to review.
Note for next time: name every commit in a sha handed over for review. Fixed: a Mac's own inbox
receiver is off by default (config files.receive; without it, pairing changes nothing about a
Mac's existing Tailscale file flow, MEDIUM); files.deliver drops "module" from its callers (LOW,
no first-party need); the tool description now says a stableId gap answers no_link (LOW, already
handled in code, just undocumented). CHANGELOG has the exact wording. Along the way, found and
fixed an unrelated markdown bug this doc's own "Doing" text introduced: a bare `**/*.test.js`
glob outside backticks reads as unmatched bold to the markdown renderer, which
test/docs-build.test.js's "every Markdown file... renders" catches (any doc using a `**` glob
must backtick it). Tests on the test box, nice -n 15, load under 2: 14/14 on drop.test.js (2 new:
default-off, and the LOW's dropped caller), 115/115 on core/files + hygiene + docs-build +
federation-answer + assert.

28 Sep 2026: e2e reviewed 0f2a8752, then the lead asked for the LOWs too if small. All three
fixed: core/link/mac.js's `answer()` fails closed ("could not read this ask") when threads.asks
errors or does not have the ask, instead of `gatedAsk(null)` calling it ungated (MEDIUM); the
box's `gatedOnMac` treats an unknown ask as gated by default, not ungated (LOW 1); core/link/
assert.js's `Nonces` now persists what it has seen to the Mac's home (`link-assert-nonces.json`,
0600, best-effort write, pruned on load), so a Mac restart inside a used assertion's 60 s window
still refuses a replay (LOW 2). test/federation-answer.test.js: 2 new tests, plus the first test's
tail updated (an ask the box never saw now needs a fresh proof before it is even forwarded, and
the Mac's fail-closed message replaces the switchboard's "no ask" for one it can't find).
core/link/assert.test.js: a new test for the persisted nonces, which needed `Nonces` to take a
test seam `now` for load-time pruning (the file's real timestamps vs. the test's simulated clock
otherwise looked expired on "restart" and the first version of this test caught nothing — fixed
before it shipped). CHANGELOG has the detail. Tests on the test box, nice -n 15, load under 2:
8/8 on assert, 9/9 on federation-answer, 106/106 on link + link-federation + federation-reads +
federation-send + assert + link/transport + switchboard + hygiene + federate.
Sending the sha to e2e for sign-off next.

28 Sep 2026, after the merge (below): built the "Mac and box as one" pieces the lead ordered for
0.1.x from docs/design/federation-plan.md (work/federation-transcript).

- 1a (chat's Mac-session boot from recall.transcript): already done, by another stream, before
  this merge landed it here. deck/chat/session.js's `boot()` already calls `recall.transcript`
  with `source: "mac"` for a Mac session and falls back to `legacyBoot` only when the box has
  neither the Switchboard record nor the transcript. No work needed; federation's own doc was
  stale (it still listed this under "Next").
- 1b (box→Mac file placement, the reverse of Taildrop): built. `files.deliver { path, mac }` on
  the box; a Mac now also runs a receiver into its own inbox. `link.macs` gained `stableId` so
  the box can find a named Mac among its own tailnet peers (see CHANGELOG). Tests: 13/13 on
  core/files/drop.test.js (6 new), 97/97 on `core/files/**/*.test.js` + hygiene + docs-build,
  on the test box, nice -n 15, load 1.6-2.6. `npm run docs:ref` regenerated for the new tool.
  Not built (deferred to 1c/cohesion, per the plan): any drag-and-drop UI, and Chat/Deck surfacing
  files.deliver — this round is the tool and the Mac's inbox only.

28 Sep 2026: merged origin/main (a3a844e4, 0.1.0-rc.1 plus the post-rc `packages/module-sdk` fix)
into work/federation (cd646008). Conflicts: CHANGELOG.md (append, both sides kept),
core/daemon/index.js (FORBIDDEN_LABEL gained both `link:` and main's new `device:`; kept main's
new `callId` export), core/link/mac.js (import merge only — checkAnswer/Nonces/gatedAsk plus
main's HUMAN_ONLY/PERSON_ONLY/inputHash/enclave/signed/PEOPLE, no functional overlap),
core/link/module.json (tool/event lists unioned: ours plus main's link.signin/signout and
ask.raised/answered events), core/switchboard/index.js (threads.answer: Mac-forward check first,
then main's `device` param on sb.answer; callers list unions `tailnet` (main) with `link:box`
(ours); `stop()` runs both cleanups), core/switchboard/testing/fake-claude.js (comment-only,
implementations for both sides were already present unconflicted). docs/reference/* and
docs/index.json taken from main then regenerated with `npm run docs:ref` against the merged code.
Ran node --check on every touched core file.

Compat check for the per-thread socket (e9a6bebd) and the caller-label fix (1941f2cf): `sb.send`,
`queuesFor`, `fromLink`, `surfaceOf`, `guard` all merged with no conflicts (git's line-level merge
succeeded cleanly, confirming the two branches touched adjacent, non-overlapping parts of the
same functions) — reviewed by hand too. Tests on the test box (nice -n 15, load 2.9-4.4, under
the RULES cap of 6): test/link.test.js, test/link-federation.test.js,
test/federation-reads.test.js, test/federation-send.test.js, core/link/transport.test.js,
core/switchboard/switchboard.test.js, core/harness/floor.test.js, core/harness/harness.test.js,
test/harness.test.js, test/hygiene.test.js, core/modules/federate.test.js: 129/129. Separately:
test/docs-build.test.js, test/docs-index.test.js, test/onboard.test.js,
core/projects/projects.test.js, core/recall/recall.test.js, core/recall/module.test.js:
105/106 (1 skipped, none failed).

Sent to e2e for security review (presence gates on threads.answer's Mac forward,
person_session_required, gatedOnMac) before the integrator, targeted for 0.1.x after rc.2.

27 Sep 2026: answering a Mac's ask from the box is built (Done, above). Before that, the Mac-send
loose ends (below); next is rich Mac transcripts (chat's ask), then Taildrive on work/tailnet.

- capsule-now's answers, applied (d86afcc): 1 was already built (WRITE allowlist, `as: "person"`
  checked on the Mac). 2: `fromLink` in core/switchboard/index.js, an explicit caller kind for
  `link:box` in guard(), surfaceOf() (always `box:<surface>`) and queuesFor(); the box's note
  names the Mac. 3: already the rule (a finish while queued words wait does not end the follow;
  test "a thread.finished while queued words wait"). 4: `send(..., { wait })` queues while any
  Mac surface holds the lease and never takes it; answers carry `busy`. The Harness says a box
  message came "via the Deck on the box". New test: "a Mac session another surface holds".
- Find (b7526a3): the machine chip on Mac rows (sessions, Recent, "Type into"), beside the title
  rather than inside its ellipsis (a long Mac title hid it). The files note now says the box does
  not search the Mac's files. mac-shots ONLY=search: 1440 and 390 both pass once; later runs
  failed on timing while the test box sat at load 40 from another run (a blank page, then no
  `.search` input on 1440), so re-run it when the box is quiet.
- ADR 0021: the queue rule (4a) and v2 of threads.answer (a presence assertion signed by the
  paired box, for that one ask only). v1 says "Answer it on <mac>".
- Chat's labels: chat reads `projects.catalog {limit}`, `threads.list {all: true}` and
  `projects.list` without `machines`, as `deck` or the owner over the tailnet; both federate and
  label rows (test/federation-reads.test.js covers deck, cli, capsule and `tailnet:<owner>` on
  the catalogue, and threads.list {all: true}).
- Tests on the test box: federation-send 8/8, switchboard 31/31, core/harness 12/12,
  test/harness 15/15, link 10/10, link-federation 7/7, federation-reads 7/7, floor 8/8,
  hygiene 1/1.

## Next

- Rich Mac transcripts: done on work/federation-transcript (off work/chat, which has
  recall.transcript; main does not yet). Box side: `recall.transcript` federates like
  recall.thread. Chat's side still to do in deck/chat/session.js: a Mac session boots from
  `recall.transcript { session, source: "mac" }` instead of legacyBoot. Tests: federation-reads
  8/8, recall transcript 3/3, recall module 5/5, link 10/10, link-federation 7/7,
  federation-send 8/8, hygiene 1/1. Limit: a page travels in one link.reply, and vyred takes
  bodies up to 5 MB, so a page of 400 blocks with large tool output could fail as `timeout`.
- projects.list does not count a picked Mac session in a project's thread count.
- Chat: a composer for Mac sessions (the read-only rule in deck/js/machine.js lifts for
  threads.send only; lease, answer and release stay off).

- The pwa / deck owners: the problems listed under "The browser look".
- Chat's rail groups by project slug, and a Mac project whose slug is also a box project's shares
  that group (both chips show). Worth a decision with the deck owner if it confuses.

## Needs from others

- lead: ADR 0021 assigned (done).
- deck: review the machine and offline chips, the read-only rule and the choices above (Task C).
- projects, recall, switchboard owners: review the `machines` input and the row labels.
- chat: a composer for Mac sessions, sending with `threads.send { thread, text, machine }` and
  showing the answers above; the note and the offline chip stay for everything else.
- capsule-now: answered (applied in d86afcc).
- chat: a Mac-owned ask can be answered from the Deck now. deck/chat/question.js and
  deck/chat/ask-item.js show "Answer it on <mac>" (`ask.elsewhere`, set in deck/chat/session.js)
  with no buttons. Replace that with the usual buttons, calling `threads.answer { ask, decision,
  message?, answers?, scope?, surface, machine: <the Mac's name> }` (machine is optional when the
  box saw the ask, and needed after a box restart). The answer comes back with `source: "mac"`,
  `machine`; errors `mac_offline` ("<mac> is offline; your answer was not sent"), `timeout`,
  `denied` (the Mac refused the box's assertion: pair again), or the Mac's own ("no ask <id>",
  final). Mac asks arrive on the box's stream as `ask.raised` / `ask.answered` with `source:
  "mac"`, `machine`, `node`; `threads.asks` on the box does not list them, so a reconnecting
  Deck sees only asks raised since. The phone's push for a Mac ask opens `/needs/<ask>`, which
  the box cannot load with `threads.asks` either (pwa).

## Changed contracts

- New box tool `files.deliver { path, mac }` (files module, CHANGELOG has detail): sends a file to
  one paired Mac by Taildrop. `link.macs` gained `stableId` (additive). A Mac now also runs an
  inbox receiver (default `~/Vyre/inbox`), where it had none before.
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

- Sending to a Mac session: `WRITE = ["threads.send"]` and `FOLLOWED` (the event types) in
  `core/link/allow.js`. `link.macs.call` takes `mac` (a peer id or name: that Mac only) and `as`
  (a WRITE tool needs `as: "person"`, else `denied` before queueing); writes default to a 15 s
  timeout; the queued request carries `as`. New box tool `link.events { key, events: [{ type,
  thread, project, at, payload }] }` answering `{ ok, taken }` or `{ paired: false }`; the link
  manifest declares it and emits the seven thread types it re-emits. On the Mac a WRITE runs only
  with `as: "person"`, as the caller `link:box`, with `surface` forced to `box:<surface or
  deck>`. `ctx.call(tool, input, { as })` (core/modules/index.js): calls as another caller label only
  for a module under core/ and only a label the registry's fixed `CALL_AS` map gives it (today
  `link` -> `link:box`); a manifest cannot grant it, so a module installed into a home never can. `threads.send` takes `machine` and, on the box for the person, forwards a
  thread the box does not have; the answer gains `source: "mac"` and `machine`; new errors
  `mac_offline` and `timeout`. New `Switchboard.knows(id)`. Re-emitted events' payloads gain
  `source: "mac"` and `machine`. The Mac's `link.status` gains `following`.
- `Switchboard.send` takes `wait` (queue while another surface holds the lease; never take it);
  `queue()` takes the holder, and its answer gains `busy` ("terminal" or the holder). New export
  `fromLink` in core/switchboard/index.js; `queuesFor("link:box")` is true by name. The Harness's
  hand-over names a `box:<surface>` as "<surface> on the box" (core/harness/index.js).

- Answering a Mac's ask (v2): `WRITE = ["threads.send", "threads.answer"]` and new `ASKS =
  ["ask.raised", "ask.answered"]` in core/link/allow.js; new core/link/assert.js (`boxKey`,
  `signAnswer`, `checkAnswer`, `Nonces`, `canonical`, `decisionHash`). `link.pair.poll`'s
  approved answer and `link.hello` gain `box.assertKey` and `you: { stableId } | null`; the Mac's
  link.json gains `box.assertKey` and `self`. `link.macs.call` takes `by: { caller, device? }`
  and, for threads.answer, sends only to the Mac the ask is on (or `mac`); the queued request
  carries `assertion: { a, sig }`. `link.events` takes `ask.raised`/`ask.answered` for any
  thread of the Mac; relayed events gain `node`. The link manifest emits both. `threads.answer`
  takes `machine`, lists `link:box` in its callers, and on the box forwards for the person
  (answer gains `source`, `machine`; errors `mac_offline`, `timeout`, `denied` or the Mac's).
  core/learn skips `ask.answered` with `source: "mac"`. core/daemon: `link:` joins the socket's
  forbidden caller labels.
- Person session and gated asks: A gains `person` (session id or null) and `presence` (method
  or null); `link.macs.call`'s `by` takes `person` and `presence`. New shared `gatedAsk(ask)` in
  core/modules/federate.js (imports HUMAN_ONLY from core/presence). On a box, `threads.answer`
  declares `presence: { when, summary }` (true only for a gated Mac-bound answer), so
  `/v1/tools` lists it with `presence: true` there; a Mac declares none. New errors on the box
  forward: `person_session_required`, `presence_required`. `checkAnswer` takes `gated`. The Mac
  reads its own ask with `threads.asks` before it checks. The switchboard's fake claude takes
  `use <tool>` (asks permission for that tool).

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


## threads.asks merges the Macs' open asks (27 Sep 2026, sessions' decision)

threads.asks on a box, for the person, merges each Mac's open asks (ALLOW read), labelled
source/machine, oldest first, with the box's gated rule in presence.required; listing records
each ask's gated flag for threads.answer's presence rule. Test box: 117 of 117 (federation
answer, reads, send, core/link, switchboard, hygiene, docs-build, docs-index).

## Session-import security fixes (e2e review, 28 Sep 2026)

Fixed everything open from e2e's review of 96cbf078/6816e83c, plus the two new asks in this
round's brief (per-import delete, sync.upload.cancel). One sha, all in core/sync and
core/link/mac.js. Detail in CHANGELOG.md; summary:

- HIGH `link.upload` path traversal: fixed. The carrier takes `{ upload, offset, data }`; the box
  path is built from a validated UUID, never a caller string.
- MEDIUM `sync.consent`/`sync.send` module-caller widths: fixed (`cli`/`local`/`deck`/`capsule` for
  consent; `module:sync`/`module:import` only for send). `sync.send` now resolves every path for
  real and refuses anything outside `~/.claude`/`CLAUDE_CONFIG_DIR`.
- The five earlier MEDIUMs (declared-size quota bypass, in-flight + MAX_OPEN cap, person-only
  consent, streamed finish, the swallowed symlink refusal): all fixed, all with tests.
- New: `sync.upload.cancel`, `sync.delete.import` (per-plan delete, `sync.consent`'s new
  `planHash` stamped onto each landed file). `sync.delete`'s confirm+preview shape (from last
  session) unchanged.
- Changed contracts: `sync.consent` input gains `planHash` (optional); `sync_peers` and
  `sync_files` gain a `plan_hash` column (migration, additive); `link.upload`'s input shape
  changed from `{ path, data }` to `{ upload, offset, data }` (internal-only tool, sync's own
  carrier — no other caller exists). module.json's `does.tools` gains `sync.delete.import`,
  `sync.upload.cancel`.
- Tests: core/sync/sync.test.js, sync-send.test.js. All green on testbox before this note (37/37
  on the pre-cancel/pre-import-delete batch); the added tests for cancel/streamed-finish/per-plan
  delete are new this round and need one more testbox run before the sha goes out (testbox was
  mid-resize when this was written).

## Reviewer's second pass (28 Sep 2026)

HOLD lifted. Fixed the MEDIUM and both LOWs reviewer flagged on 656ed493:
- MEDIUM: finish() now scans every chunk while streaming (small overlap across chunk boundaries),
  not just an 8 MB prefix.
- LOW: sync.send requires meta.firstParty too, not just the caller label. New kernel bit:
  core/modules/index.js's ctx.call now stamps `firstParty` on every module-to-module call, from
  the calling module's own directory (the existing firstParty() helper), never a manifest's claim.
  test/link-harness.js's macCall gained an optional meta param for this (additive, every existing
  caller unaffected).
- LOW: start()'s resume path was already correct (returns before MAX_OPEN/quota); added a
  regression test rather than changing working code.
- LOW: sync.consent { on: true } with no planHash now clears plan_hash instead of keeping a stale one.

All green: 139/139 (core/sync, core/link, core/modules, test/link*, test/federation-*,
core/planner/link.test.js, hygiene, docs-index) on testbox post-resize.

## Needs from others

- None open. Sent the sha to e2e and reviewer per the brief once testbox confirms green.

## De-duplicated meta.firstParty (team-lead check, 28 Sep 2026)

team-lead flagged that memory-iq (work/memory-iq 2ecf79ba, reviewer-cleared, 0.1.1 batch) already
added a loader-set firstParty flag on module calls in core/modules/index.js — same idea, built
independently on a different branch. Checked line for line: 2ecf79ba's change is in
`context(m).call`'s `!as` branch, exactly where mine was. Replaced mine with the identical code
(same variable order, same call site, same comment intent) rather than keeping a second version.
Did not do a literal `git rebase` onto 2ecf79ba — that commit is 850+ commits from this branch's
base (memory-iq's own unrelated history), so a real rebase would pull in work far outside this
review's scope. The kernel diff is now byte-for-byte the same logic as 2ecf79ba's, so a later
real merge of that commit is a no-op here. Confirmed with `diff` against
`git show 2ecf79ba:core/modules/index.js`.

139/139 green on testbox again after the swap (core/sync, core/link, core/modules, test/link*,
test/federation-*, core/planner/link.test.js, hygiene, docs-index).

## Vyre Drive step 1: files.receive toggle + conflict note (28 Sep 2026)

team-lead's order for Vyre Drive (user decision, HANDOFF.md): 1) files.receive toggle + conflict
note (this), 2) what-to-sync picker, 3) per-folder agent/project access (vault grant pattern +
sessions' lib/project-id.js), 4) launch's Drive API step + windows coordination. Each its own sha.

- `files.receive { on }` (core/files/drop.js): starts/stops a Mac's Taildrop inbox receiver live,
  person-only, persists via `config.save` (same pattern as `computers.egress.set`). No restart
  needed; previously this was a config.json-only key read once at startup.
- `files.received` gains `conflict`/`note` when Tailscale's `--conflict=rename` kept both copies:
  read off its own `--verbose` line (which names both the original and final filename), not
  guessed from the final name's shape. `parseWrote` gains `orig`.
- Did not claim a new ADR number for this step: it is a small, additive change to an existing tool
  and event, not a new architectural decision — the Drive-wide design is already the HANDOFF.md
  entry. A dedicated ADR may be worth claiming at step 3 (per-folder access) if that turns out to
  need one; will check docs/work/README.md's ADR table before that step.
- Tests: core/files/drop.test.js. 81/81 (core/files, hygiene, docs-index, boundaries) on testbox.

## Vyre Drive step 2: sync.scan (28 Sep 2026)

New `sync.scan { exclude? }`, device role: lists project folders under ~/.claude/projects or
CLAUDE_CONFIG_DIR/projects with size and file count, honors an exclude list, returns a planHash
(sha256 of the sorted included names) meant to be passed straight to sync.consent's own planHash.
Read-only. Bounded scan (50,000 entries, symlinks never followed), matching files/drive.js's
share-scan posture.

Caught and fixed in the same commit: sessionRoots() (shared with sync.send) pulled in the real
~/.claude unconditionally, even under tests. sync.send only ever compared a path against it, so
this was latent and harmless there, but sync.scan actually lists a folder's contents — under a
test run that would have read the real machine's real Claude Code folder. Gated behind
NODE_TEST_CONTEXT now, matching core/config/dialogs.js's transcriptFolders.

Tests: core/sync/sync-send.test.js. 57/57 (core/sync, core/link, hygiene, docs-index, boundaries)
green on testbox.

## Next
- Step 3: per-folder agent/project access (vault's grant pattern + sessions' lib/project-id.js) —
  not started; will need to read those two before designing it.

## Both Vyre Drive HOLDs fixed, one sha (28 Sep 2026)

**Step 1 (files.receive):** it was person-only by its callers list alone, never in
core/presence's PERSON_ONLY (or HUMAN_ONLY), so neither the daemon's model-shell check nor the
harness floor's MODEL_NEVER set actually refused a model's own "cli" call to it. Added to
PERSON_ONLY next to files.drive.access (a switch on an existing capability, not a secret reveal —
HUMAN_ONLY is for presence-proof tools like computers.egress.set). Reordered files.receive's
run(): ctx.paths check and config.save happen before the receiver starts or stops, so a save
failure never leaves the running state and config.json disagreeing (reviewer's LOW).

**Step 2 (sync.scan's exclusions):** they were advisory — planHash tagged what landed, nothing
refused a file outside the reviewed set. sync.consent now takes `included` (project folder
names) alongside planHash, stored on sync_peers as plan_included (additive migration).
sync.upload.plan reports an excluded file separately; sync.upload.start refuses it outright
(code "excluded") regardless of what a device sends or what upload.plan said before — enforced
where a device cannot route around it. sync.send never attempts a file upload.plan already
called excluded, and reports its own excluded count.

**Step 2 LOW (double-counted real-vs-CLAUDE_CONFIG_DIR root):** moot now — see below, claudeHome
resolves to exactly one folder.

**team-lead's real-home rule:** replaced the NODE_TEST_CONTEXT gate with core/config's own
claudeHome(root) rule (sessionRoots(root), threaded from ctx.paths.root down through
allowedSessionPath and sync.scan): the real folder only for the real ~/.vyre, `<root>/claude`
for any dev world, demo, trial or test home — the same rule every other module gets (connectors'
claudeJson included), not a second one sync invented. Test fixtures (core/sync/sync-send.test.js)
now write straight to `<macRoot>/claude` instead of setting CLAUDE_CONFIG_DIR, since that env var
no longer has any effect outside the real home.

Tests: core/harness/floor.test.js (files.receive denied for a model's shell), core/sync/
sync.test.js and sync-send.test.js (excluded-folder refusal at both upload.plan and
upload.start, end to end through sync.send, a later consent with no included lifting the
restriction). 270/270 (1 skipped, pre-existing) across core/sync, core/link, core/files,
core/presence, core/harness, core/config, core/modules, mcp-server-tools, hygiene, docs-index,
boundaries, cohesion-drift — testbox.

## Step 3 built: projects.access, deny by default (28 Sep 2026)

team-lead's design calls (over 181ef960): grants live in core/projects (a project-level fact
Drive, vault and memory will all ask about), not sync; the folder-to-project mapping happens at
consent time with the person confirming or editing a proposed project id; granting is HUMAN_ONLY,
revoking is PERSON_ONLY.

Built the grant itself: projects.access.grant/revoke/check/list in core/projects/index.js, table
projects_access (id, project, agent, status, by, at), appended to projects.js's own MIGRATIONS
array so version numbers continue rather than collide. Brought in lib/project-id.js verbatim from
e87f63df (not otherwise on this branch): SLUG_RE, slugify, isProjectId.

Not yet built, flagged rather than guessed at: the folder-to-project mapping itself (sync.scan
proposing a project id per folder, the person confirming at sync.consent time), and wiring an
actual caller (Drive's files.* tools, whatever serves synced session content to an agent) to ask
projects.access.check before serving. This lands the grant with deny-by-default and full test
coverage, with nothing yet asking it, since those two pieces touch Drive's and sync's own
consent/serving paths and deserve their own review pass rather than being folded in unreviewed.

Tests: core/projects/access.test.js (new), core/harness/floor.test.js (both tools alongside
files.receive). lib/project-id.test.js (brought in with the lib). Full local + testbox run
pending (queued behind testbox load).

## Next
- Wire sync.consent's picker to propose a project id per folder (marker or slugify fallback,
  person confirms/edits).
- Wire an actual caller (files.drive.*, or whatever serves synced content to an agent) to
  projects.access.check.

## Move engine: contract only, before the build (28 Sep 2026)

Per anywhere's move contract (ADR 0039 section 4, docs/design/anywhere.md): four pieces
(projects, memory, vault, sessions), source stays live and untouched until the destination
confirms every piece, then the flip is anywhere's own (onboard.machine), never mine. No
auto-delete: the pre-move copy sits at ~/.vyre/moved-<date>/ (core/projects/move.js's existing
pattern) until the person explicitly frees it from Settings.

Sent to launch and tailnet as the contract to build against; the engine itself is next.

- `move.plan { destination }` (HUMAN_ONLY): dry run against a reachable destination (a paired
  device or box, already verified by tailnet's onboard.join). Counts and bytes per piece
  (projects, memory, vault, sessions), a planId (hash of the four pieces' current state, so a
  stale plan is never started against). No write, nothing moved.
- `move.start { planId }` (HUMAN_ONLY): begins copying to the destination over Tailscale or the
  relay, piece by piece, source untouched and fully itself the whole time. Returns a moveId.
  Refuses a stale planId (source changed since plan) rather than starting against a wrong count.
- `move.status { moveId }`: `{ stage: "copying"|"verifying"|"ready"|"confirmed"|"failed",
  pieces: { projects: { bytes, of, done, error }, memory: {...}, vault: {...}, sessions: {...} } }`.
  Resumable: a status check after a restart of either machine picks up where copying left off,
  never re-starts a finished piece.
- `move.confirm { moveId }` (HUMAN_ONLY): the person's go-ahead once `stage: "ready"` (every
  piece copied and the destination has verified its checksums and, for vault, re-encrypted to
  its own device key). Marks the move confirmed and emits `move.confirmed { moveId }`; anywhere's
  onboard.machine is what actually listens for that and flips config.machine on the source.
  Nothing here calls onboard.machine directly: that boundary is anywhere's, this engine only
  reports.
- `move.cancel { moveId }` (PERSON_ONLY, instant): stops an in-flight or ready-but-unconfirmed
  move. The source was never touched (never flipped, per the contract), so this is cleanup of
  the partial destination copy only, not a rollback.
- Events: `move.progress { moveId, piece, bytes, of }` (throttled, not per-chunk), `move.piece.done
  { moveId, piece }`, `move.failed { moveId, piece, error }` (a dead network mid-copy: retried by
  a fresh move.start against the same planId, not a special recovery path), `move.confirmed
  { moveId }`.
- Checksums verified on the destination before `stage` reaches "ready": a piece whose checksum
  fails is retried, never surfaced to the person as "ready" with a silent mismatch.

Open question sent back to anywhere: whether vault and sessions need to move atomically together
(a session mid-thread holding a vault-derived credential) or each piece can lag independently as
above; the four-piece split otherwise fits the engine's real constraints (each piece copies and
verifies on its own, no cross-piece ordering needed except the final confirm gate).

## Both HOLDs fixed after the restart: f8330ccc, 7021d4e1 (28 Sep 2026)

db2d94fd: f8330ccc's M1 (guard() hands back r.cwds for every raw reader, not just memory.graph's
own drawing) and M2 (projects.access.grant/revoke/clear refuse any module caller that is not
module:agents or module:projects) were already written, uncommitted, from before the restart;
verified them against the reviewer's exact notes, ran the tests, committed. 7021d4e1 built fresh
this round: projects.create and projects.add-workspace both gained real callers (OWNER plus a
named module:sync exception, the only module with real business proposing a folder-to-project
mapping, sync's own attachMapped) and a real test exercising sync's attach-to-existing and
create-new-project calls plus a third-party-module refusal; Projects.create()/addWorkspace() now
refuse "/", the real home, and the credential/vault folders under it as a project's own home or
workspace. One pre-existing test (projects.test.js "tools: projects.of...") called
registry.call("projects.create", ...) with the default "unknown" caller; fixed to "cli", the real
surface it was standing in for. docs:ref regenerated. Tests, testbox nice -n 15: 234/234
core/projects, 417/417 (1 pre-existing skip) core/memory + core/sync + core/link + link* +
federation-* + docs-* + onboard* + harness/floor, 9/9 boundaries + mcp-server-tools +
cohesion-drift.

c6cda1aa: the e8560b79 dev/ino follow-up (fstat vs describe()'s stat, to catch a parent-dir swap
the O_NOFOLLOW fix alone does not). describe() now carries dev/ino; new openChecked(d) in
core/files/index.js opens and fstats, refusing on a mismatch; wired into files.preview's
small-image and text reads, and folded into chunk()'s existing fstat rather than a second one.
Thumbnail generation (external convert/sips by path) stays the accepted residual. Tests: 84/84
core/files + hygiene + boundaries.

CHANGELOG entries added in a follow-up commit (391c4840): missed landing them in the same commit
the first time.

Shas sent to reviewer and integrator. Told memory-iq db2d94fd/c6cda1aa so work/memory-reach can
branch off work/federation. Move-engine contract (below, already built and sent to launch and
tailnet before the restart) re-confirmed with both after the restart, in case the message did not
survive it.

## Next

- The move engine itself (move.plan/start/status/confirm/cancel), per the contract above: not
  started this round, time went to the two HOLDs and the dev/ino follow-up instead.

## core/mcp/hub.js: whoFrom()'s backwards person check, cohesion's audit (28 Sep 2026)

513f984d. cohesion's caller-check audit (core/ and local/, no edits made on their side) found
whoFrom() stripped "agent:kit" off "cli:agent:kit" before checking PEOPLE, reading it as person
AND agent at once; inScope() trusts who.person to skip every per-agent scope check, so this let
such a caller reach every connected MCP server, not just its own scope. Fixed: the agent claim is
checked first, person refuses immediately if one exists. Not a real ownership question (git log
shows no recent federation touch on hub.js) but team-lead and cohesion both routed it here, and it
is a live privilege-escalation bug, so fixed rather than passed back.

Round 2 (reviewer, same day): the first fix only caught the exact "<kind>:agent:<name>" shape.
"cli agent:kit" (space, not colon) and "cli:agent:" (a claim with no name) both still slipped
through the same PEOPLE.includes(kind)-plus-anchored-regex gap. Fixed at cb85c3eb: an unanchored
claimed test with no name required, and a thread: claim refused the same as an agent: one
(callerKind's own strip already treats them identically). Reviewer's LOW (PEOPLE includes
"module", so any module skips inScope) deferred, as they asked, to the lib/caller.js swap.

Could not take lib/caller.js (cohesion's fix path, work/cohesion 87149563) as a real dependency:
it imports agentClaim from core/modules and PERSON_SURFACES from core/presence, and neither is
merged into work/federation's tree (main at this branch's base, a3a844e4, predates both; agentClaim
itself is still unmerged into main too, per e2e-agentclaim's branch history). Wrote the equivalent
fix locally instead, with a note in the code and this doc for whoever swaps it onto lib/caller.js
once this branch takes a main merge that carries it.

Tests, testbox nice -n 15, load under 3: 43/43 across core/mcp, hygiene, boundaries.

## db2d94fd reviewer HOLD, round 2: three MEDIUMs (28 Sep 2026)

13e7b0e8 (memory MEDIUM 1 and 2, projects MEDIUM 3), a262b9ed (c6cda1aa's LOW, verified already
fixed by the existing try/finally, a test added rather than a code change). MEDIUM 1: guard()'s
NOTHING sentinel (a cwds value under /dev/null) replaces an empty r.folders wherever it would
otherwise become "unscoped" downstream. MEDIUM 2: scopedCwds() now checks every caller-supplied
folder against r.folders for the assistant, refusing outright rather than the old
non-empty-means-unchecked shortcut. MEDIUM 3: refuseSensitiveRoot now refuses an ancestor of "/",
home, or any SENSITIVE entry too (not just the folder itself or something inside it), and
"Library" joined the list. Tests: 354/354 on testbox across core/mcp, core/memory, core/projects,
core/files, hygiene, boundaries.

## Reviewer's HIGH on 13e7b0e8: fixed, b2e64518 (28 Sep 2026)

The ancestor fix for MEDIUM 3 (previous entry) put root and home into the SAME "inside-or-ancestor"
check as the SENSITIVE folders, which refused every real project nested anywhere under the actual
home directory - exactly where almost every real project lives (checked with home /Users/alex:
/Users/alex/Projects/harlow was refused). Fixed: root/home refused only as themselves or an
ancestor; SENSITIVE folders keep all three checks. New test against a fake $HOME proves the fix
without depending on this worktree's own real home holding anything in particular. Also backfilled
the ancestor/Library tests MEDIUM 3's fix should have shipped with the first time (I'd changed the
code but not added the test the reviewer specifically asked for - won't skip that again). Tests:
51/51 core/projects, 305/305 across core/mcp, core/memory, core/files, hygiene, boundaries.

## Reviewer signed off the whole range: 342d3a15..b2e64518 (28 Sep 2026)

f8330ccc and 7021d4e1 are CLOSED; 2fb4258c's old "release blocked" note is lifted. Range: 450c34b6,
c6b4856c, f8330ccc, 7021d4e1, e8560b79, 35188a38, 59d6833c, db2d94fd, c6cda1aa, 513f984d, 13e7b0e8,
a262b9ed, cb85c3eb, b2e64518, plus docs. Reviewer ran core/projects + core/memory + core/files +
core/mcp + boundaries + hygiene on testbox themselves at b2e64518: 263/263.

New LOW, on projects.reach (35188a38/59d6833c, previously unreviewed): `callers: ["module"]`
trusts the forwarded `caller` from any module, third-party included; consistent with third-party
modules already running in-process today, so not a hold, but narrow to firstParty at the same time
as the hub.js and projects.access module-caller LOWs, once lib/caller.js/the firstParty stamp is a
real dependency here.

Sent to integrator: work/federation ready to land.

## Move engine: design doc sent to reviewer, before any code (28 Sep 2026)

team-lead's next item: memory-iq has the projects.reach swap, so the move engine ("Move to a
server", launch's UI already targets the earlier contract) is federation's. Wrote ADR 0041
(docs/adr/0042-move-engine.md, sha 9c3fe3cc, renumbered from 0041 which collided with work/github)
covering the four pieces (unchanged from the earlier
contract) plus the team-lead's five constraints and the new transport plan (relay introduces via
tailnet's own join flow, Tailscale carries every byte of the actual copy). New move.free/
move.free.preview tools split "confirm the new machine" from "free the old one's disk", per
constraint 5. Flagged to tailnet: core/link/transport.js's transport is scoped to the Mac-to-box
pairing shape only; needs generalising before move.start can build on it. Sent to reviewer per
team-lead's "design note first" instruction; no code yet.

ADR number 0041 claimed tentatively - this branch's own docs/work/README.md table is stale
relative to several other teams' claims (box-deploy 0038, anywhere 0039, e2e-setsid 0040
referenced in HANDOFF.md but not in this branch's own copy of the table); flagged for a
collision check rather than guessed past.

## docs/design/projects-map.md: not on this branch (team-lead's docs-check report)

Checked: docs/design/projects-map.md does not exist on work/federation. It is sessions' own doc
(28408df8, d65353a8; front matter owner: sessions), on a branch not merged here. The file I do have at that similar name, docs/work/projects-map.md (the MIGRATIONS slot map), is
not itself subject to docs-check's nav/front-matter rules (docs/work/ is in nav.json's own
unpublished list), but it did carry one em dash (RULES bans them repo-wide, not just where
docs-check enforces it); fixed that in passing. Flagged the real docs/design/projects-map.md back
to team-lead rather than guessing at a file this branch cannot see.
