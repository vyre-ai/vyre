---
title: ADR 0029: The resilience contract
summary: What every Vyre surface does when the network blips, a lid closes or the box restarts, so an outage is boring.
audience: builders
owner: resilience
status: draft
---

# ADR 0029: The resilience contract

Status: proposed, 27 Sep 2026 · Workstream: resilience ·
Builds on ADR 0002 (network and identity), ADR 0011 (web push), ADR 0014 (tailnet), ADR 0024
(chat and the terminal), ADR 0025 (planner), ADR 0026 (relay) and ADR 0027 (one Expo app).

## Context

The user ran Tess from a phone over Termius. Every time the network blipped, the session threw a
wall of errors and the user had to start again. Vyre is used the same way: a phone that walks from
Wi-Fi to cellular, a laptop lid that closes mid-turn, a box that restarts for a deploy, a relay or
a Tailscale path that goes flaky, and long stretches with no network at all.

An audit on 27 Sep 2026 found the pieces half there. vyred's event log has ids and the SSE route
honours `Last-Event-ID`, and most clients back off and stay quiet. But no write anywhere carries an
idempotency key, so a retry after a lost response sends a message twice; no surface keeps an
outbox; a stream that drops before its first event loses the gap; a terminal dies 10 s after its
socket closes and every vyred restart kills it; each client knows one box address; and a phone
cannot ring an alarm while the box is out of reach.

This ADR is the contract every surface meets: the Deck, the phone app, the Capsule, the CLI, the
terminal, Glass, the relay and federation between boxes. Each rule has a test in the chaos harness
(`test/chaos/`), named after the rule.

## Decision

### R1. Every event stream resumes from a cursor

- An event's id is its cursor. Ids only grow, across restarts and prunes: the events table is
  `AUTOINCREMENT`, so an emptied or pruned tail never hands out an id twice.
- vyred's SSE stream writes `retry: 2000` and an `id: <cursor>` line as soon as it opens, before
  any backlog, and again with every heartbeat. A client that drops before its first event
  therefore still resumes from where it was, never from `latest`.
- `since=latest` is resolved once, by the server, into a number the client then holds. A client
  never sends `latest` on a reconnect.
- The log is never trimmed at its head (only a turn's partial text is pruned, once its whole text
  is stored), so any cursor the box handed out can be replayed. A cursor ahead of the log (the
  box's store was reset, or the client followed another box) cannot: the stream sends a
  `stream.reset` event, shaped like any other event, whose id is the one to follow from. The
  client sets its cursor to it, reloads its state through tools and follows from there. A gap is
  always either replayed or announced, never silent.
- Clients drop any event whose id is at or below the last one they applied (no doubles), and
  persist the cursor so a cold start resumes too.
- A client treats 45 s without a byte (three missed heartbeats) as a dead stream and reconnects.
- Tool reads that a view renders from (`threads.get`, `planner.list`, `planner.upcoming`, Needs)
  return `last_event`, the cursor they are current to, so a view that loads first and subscribes
  second has no gap. A module reads it from `ctx.events.latestId()`.

### R2. Every write carries an idempotency key, and each device has an outbox

- A surface sends `Idempotency-Key: <uuid>` with every tool call that changes something (over MCP
  and `ctx.remote`, the key rides in meta). One key per intent: a retry reuses it.
- vyred keeps `(caller, tool, key) -> (input hash, result)` for 24 h, in the registry, around the
  tool's `run`. A repeat with the same input gets the stored result back without running the tool
  again, marked `replayed: true`. A repeat with different input is refused with a 409
  `idempotency_conflict`. A repeat that arrives while the first is still running waits for that
  same run and gets its answer. Successes and the tool's own coded refusals are stored; a crash
  (`failed`) is not, so it can be retried. Checks run before the lookup as before (rules,
  presence), so a replay never answers a caller the tool itself would have refused.
- The key reaches the tool as `meta.idempotencyKey`. A tool that hands the work on carries it:
  `threads.send` gives it to the Agent SDK as the message `uuid` (ADR 0030; `keyUuid(caller, key)`
  in `core/modules/idempotency.js` turns a key that is not a uuid into a stable one), so a send
  retried from an outbox, across the queue or after a restart is one turn, not two.
- A restart that kills vyred mid-run loses the in-memory "running" mark, and the retry runs the
  tool again. That is why the uuid matters: the session driver refuses a message uuid it has
  already queued or handed over. Other tools whose writes cannot be repeated safely make their own
  write and the key's record in one transaction (a later step; none needs it yet).
- Tools that refuse a second attempt today (`threads.answer`, `gate.approve`, `gate.reject`)
  should return the earlier outcome as a success, so a retry that comes without a key (or after
  the key's day) still reads as done.
- Every device keeps an outbox in durable storage (IndexedDB in the Deck, SQLite or MMKV in the
  app, a file in the CLI and the Capsule). Sends, answers, approvals, notes and todos go into it
  first, with their key, and show at once as "sending". The outbox drains in order when the box
  is reachable, and an entry leaves it only on a stored result from the box. Presence-gated
  writes (approvals that need Touch ID or a passkey) keep their proof request in the outbox and
  ask the person again only if the proof has expired.
- An entry the box refuses on its merits (a gate already rejected by someone else) leaves the
  outbox and shows its reason inline. Nothing is dropped without a trace.

### R3. Reconnecting is quiet, and the last state is always on screen

- A lost box shows one small "Reconnecting" pill. Never a blocking screen, an error wall, a modal
  or an empty list. Lists keep their last contents; the Capsule keeps its tool list.
- Backoff starts at 2 s, doubles to a 60 s cap, with 20 percent jitter. It resets on success, on a
  network change (NWPathMonitor, ConnectivityManager, the browser's `online` event) and on a wake
  from sleep.
- A hidden app, tab or window stops reconnecting and closes its stream. Coming back to the front
  reconnects at once from the saved cursor.
- The pill appears only after the first failed retry (about 2 s), so a blip that heals on the
  first try shows nothing. After 60 s it says since when the box has not answered, measured from
  the box's last answer, not from when the pill appeared.
- Each surface caches what it last showed (Now, Needs, chat threads, the planner) and opens from
  that cache offline. A reconnect reconciles in place; it never remounts a view, and it never
  throws away a draft.

### R4. The terminal survives like mosh

- The shell runs on the box under a detachable holder (a pty kept by vyred's term module, with a
  `dtach` socket so it outlives a vyred restart; the next vyred re-adopts it from
  `run/term/terms.json`). Without `dtach` on the PATH it is a plain pty and `term.open` says
  `durable: false`. In the box image tini is the only init (PID 1; no compose service on the
  image sets `init: true`, so there is no docker-init in front of it) and a small loop
  (`core/daemon/loop.sh`) restarts vyred inside the container. Sessions keep their own nested
  `tini -s` subreaper behind the spawner (ADR 0030), which is not a second PID 1. So a vyred crash or restart keeps every terminal. A deploy
  recreates the container and ends them: the next vyred says so with `term.closed` reason
  `box updated`, and `term.attach` on one of them answers `terminal_closed` (for a day) instead of
  `not_found`, so the screen shows "the box was updated; open a new terminal" rather than going
  quiet. Terminals that survive a deploy need a holder outside the vyred container (backlog). A client disconnect never ends it. An idle
  terminal is kept for 12 h by default (`term.keep_hours`), not seconds.
- The box counts every output byte. A client attaches with `from=<offset>` and gets exactly the
  bytes after it from a 1 MB ring, trimmed only at line boundaries. If the offset has left the
  ring, the client gets the whole ring and a marker saying what was cut. The client keeps its own
  scrollback and never resets it on reattach.
- Keys typed while disconnected are held (up to 4 KB) and sent on reattach, and the terminal
  dims to show it is catching up. A vyred restart is a reconnect like any other.

### R5. Paths fail over without the user noticing

- Each device keeps an ordered list of ways to the box: LAN (when the box advertises one and the
  device sees it), the tailnet name, then the relay (ADR 0026). Every path ends at the same
  identity check, so a path never weakens who the box is.
- A transport error, a stall (R1) or a network change moves to the next path at once, without
  waiting out the backoff. The device probes a better path in the background every 60 s while
  the app is in front and moves back when it answers.
- The stream cursor and the outbox are per box, not per path, so a switch mid-stream replays
  nothing twice and loses nothing.
- The Mac link to the box restarts its serve loop after a short backoff (2 s to 60 s), not on its
  60 s heartbeat, and the box re-queues any question a dead held request never delivered.
- Federation between boxes retries reads once on another path and carries cursors for anything
  it follows.

### R6. Alarms ring even when the box is out of reach

- Each device schedules the next 48 h of planner alarms and reminders as local notifications,
  from `planner.agenda`, and refreshes that schedule on every planner change event and every
  foreground.
- The dedupe key is `planner-<item>-<due>`, where `due` is the scheduled time in epoch seconds.
  The box's push uses that same key as its tag (web push), `apns-collapse-id` (iOS) and
  notification tag (Android), and carries `item` and `due`. A device that already rang locally
  replaces the box's notification instead of ringing twice.
- An alarm acknowledged on one device clears it on the others through the existing `planner-ack`
  push, and the local schedule for that key is cancelled.

### R7. The box's restarts and deploys drop no client state

- On SIGTERM vyred stops accepting new connections, lets in-flight tool calls finish (up to 5 s),
  then ends streams with a final `retry: 2000` so clients come back fast.
- Event ids, idempotency records and outboxes are durable, so a restart costs a reconnect and
  nothing else. On stop, every live session ends with `thread.stopped` reason `restart` (the
  Switchboard's stopAll today, the session driver's `close("restart")` under ADR 0030), written
  before the streams close, so a surface replays it and says "the box restarted" instead of
  spinning. A vyred that crashed says the same on its next start, for every thread it finds
  still marked live. Idle sessions lose nothing: the next send resumes them. A session closed for
  idleness (`thread.stopped` reason `idle`, ADR 0030) is not an end either: surfaces show it as
  resting, not stopped, and never as an error.
- The durable terminal socket closes with code 1012 ("restarting"), so the client reattaches with
  `from` instead of ending.
- The Deck's service worker swaps its shell as one versioned set, so a deploy never mixes old and
  new modules.

### R8. Proven by a chaos harness

`test/chaos/` runs vyred behind a small fault proxy in a temp home. The proxy can drop a
connection, delay bytes, cut a stream mid-event, partition (blackhole without closing), switch
between two paths and restart vyred mid-stream. Every rule above has a test named `R<n>: ...`.
The harness runs on testbox under `nice -n 15`, one file at a time, in well under a minute. A
surface team adds its own client to the harness by pointing it at the proxy.

## Consequences

- Every surface team has work to meet R1 to R6; the resilience workstream tracks it in
  `docs/work/resilience.md` and does the shared pieces: the SSE changes, the idempotency layer,
  the drain on stop, the chaos harness and a reference client (stream plus outbox) in
  `core/resilience/` that the CLI and the Mac link use in Node (`node.js`), and the Deck, the
  hosted web app and the Expo web target use in a browser (`web.js`: a fetch transport and
  caller, IndexedDB stores for the outbox, the cursor and a snapshot cache, and `lifecycle()` for
  hidden pages, the back/forward cache and online/offline).
- Idempotency costs one small table and one lookup per write. Reads skip it.
- A terminal that outlives vyred needs `dtach` in the box image (a 30 KB binary).
- Local alarms mean each device holds the next 48 h of alarm titles. They are the user's own
  data on the user's own devices, and the schedule is cleared on sign-out.
