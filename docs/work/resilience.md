# resilience

Branch: work/resilience · Worktree: ../vyre-resilience · Owner session: resilience · ADR 0029

Scope: the resilience contract (docs/adr/0029-resilience.md) for every surface, the shared
pieces (SSE cursor fixes, idempotency layer, drain on stop, reference stream and outbox client
in core/resilience/), the chaos harness (test/chaos/), and the audit with fixes filed to owners.

## Done
- ADR 0029 drafted (R1..R8), aligned with ADR 0030 (sessions): the key reaches the tool, keyUuid
  for the SDK message uuid, `thread.stopped` reason `restart` on stop.
- Box side: SSE `retry:` and `id:` on open and on heartbeat, `stream.reset`, AUTOINCREMENT event
  ids; Idempotency-Key in Registry.call (24 h table, 409 conflict, overlap waits, failed not
  kept); drain on stop (503 `restarting`, 5 s); Switchboard stopAll ends threads with reason
  `restart`; dtach in box/Dockerfile.
- R4 terminal box side: core/term under dtach (re-adopted after a vyred restart), byte offsets,
  1 MB ring cut at line ends, `from=`, cut/at frames, 1012 on stop, `term.keep_hours` (12).
- Reference client: core/resilience/ stream, outbox (+ kick), backoff, sse, node.js transports,
  web.js (fetch transport and caller, IndexedDB outbox, cursor and snapshot stores, lifecycle).
- CLI `threads watch`, `connect --sign-in` and the live screen use the resilient client.
- Chaos harness test/chaos/ (proxy, R1 R2 R3 R5 R7 tests, browser transport tests, web.test.js).
- Lead decision (a): tini + core/daemon/loop.sh restart vyred inside the container; a deploy
  ends terminals and says so (term.closed "box updated", term.attach terminal_closed). Term
  sidecar that survives deploys: backlog.
- ctx.events.latestId() for modules (planner.upcoming's last_event).
- CLI write() with idempotency keys (threads send/answer, screen send); sse.js split-CRLF fix;
  strict-tsc JSDoc. c8f5654 is on main (15e82dd, with the integrator's term save() fix).
- R5 relay chaos (test/chaos/relay.test.js): 4 pass + 2 todo (relay redial bugs, filed with
  relay), twice on testbox; web.js over() fixed for relay bodies.
- R6 chaos test and web.js over() (relay paths); 39/39 on testbox after main 9efbddc merge.
- Tests on testbox (27 Sep, after main 15e82dd): 145 targeted pass, 0 fail. Earlier: 189 pass, 0 fail. Earlier: 124 pass, 0 fail across idempotency, switchboard, chaos, web, term
  (real dtach), daemon and modules tests.

## Doing
- Paused (lead, native-core refocus). ab4fdc4d is in batch 3b. Resume on the lead's word.

## Next
1. Relay fixed the redial bugs in work/relay fe94ed13 (batch 3b; relay ran this file with the
   todos removed: 54/54). Once fe94ed13 is on main, merge main and flip the two `todo` tests in test/chaos/relay.test.js
   ("kit redials within its backoff...", "the box's relay link comes back after an outage
   longer than its first retry") to real tests and run the file twice on testbox.
2. Idle durable terminal perf check: one dtach terminal open and idle for 30 min on testbox
   (scripts/perf-check, nice 15, load under 8): RSS and CPU of vyred, the dtach master and the
   shell; plus the stream client idle (heartbeats only). Put the numbers here.
3. `last_event` on reads (R1): threads.get and the Needs read (sessions, pwa) return
   `ctx.events.latestId()` as `last_event`, as planner.list/upcoming already do; add a chaos test
   (read, then follow from last_event, nothing missed) once they land.
4. pwa and mobile adopting web.js (outbox, cursor, cache, lifecycle; over(createPaths().fetch)
   for the phone): chaos tests against their clients when they ask.
5. mobile asks (work/mobile 3dd724c5, src/state/answers.ts; not urgent): outbox.js
   `cancel(key)`: drop an entry not yet handed to the transport and return true; false if it
   is in flight or done. Optional `add(tool, input, { holdMs })`: persisted at once, delivered
   after holdMs unless cancelled, so a 4 s Undo on the approve swipe can put the answer in the
   outbox the moment it commits (a killed app still sends it). Keep lifecycle's flush on hide
   delivering held entries early only if mobile wants that; ask.
6. From e2e (small, both in 3b's code; lead decides whether to fix before the deploy):
   a. core/daemon/main.js registers SIGTERM/SIGINT only after `await start()` (lines 7-10), so a
      stop during start-up kills vyred by the signal (exit 143, no drain). Register first; if the
      signal comes before start resolves, stop once it does, then exit 0.
   b. core/daemon/loop.sh: a trapped `wait` returns 143; if vyred already exited, the `kill -0`
      loop is skipped and the loop exits 143, not vyred's code. After a >128 return with the
      child gone, `wait "$pid"` once more for its real status (keep the old code on 127).
   Tests: loop.test.js (stop just as vyred exits 0 -> loop exits 0) and a daemon test (SIGTERM
   during start -> clean exit, socket removed).
   One init confirmed by e2e (work/e2e c8e00e7b, scripts/e2e-split/check.sh): tini PID 1 ->
   spawner -> loop.sh -> vyred; sessions under their own tini -s; no --init anywhere.
7. After batch 3 deploys: confirm on the live box that PID 1 is tini (ci smoke asserts it) and
   that a vyred restart keeps an open terminal.

## Audit (27 Sep 2026)
- R1: Deck, iOS, Android and the Mac link reconnect with since=latest if they drop before the
  first event (gap). Deck never rebuilds a CLOSED EventSource. `vyre threads watch` and
  `connect --sign-in` never reconnect. No client detects a stalled stream.
- R2: no idempotency key anywhere; composer retry and Capsule retry double-send; OkHttp
  retryOnConnectionFailure can double-POST; no outbox on any surface.
- R3: mostly quiet already (Deck status line, CLI). Capsule shows a full OFFLINE banner and
  clears its tool list on a blip; Deck remounts views on reconnect and loses drafts; phones
  open with empty Now and Needs offline; iOS no jitter; no NWPathMonitor / wake handling.
- R4: term idle grace 10 s; replay has no offset and client resets scrollback; ring cut at
  arbitrary bytes; vyred restart kills every pty; typed keys dropped.
- R5: every client stores one address; no failover; Mac link serve loop restarts only on the
  60 s heartbeat; box loses questions handed to a dead held request.
- R6: no local notifications on either phone; firing id exists only after firing, so no dedupe.
- R7: stop() cuts in-flight calls (closeAllConnections) and SSE without draining.

## Needs from others
- relay: on Node 22 a refused WebSocket fires only `error`, never `close`. relay/client/client.js
  openChannel (ws.onerror no-op, ~line 111) waits the full 15 s handshake instead of backing off;
  core/relay/link.js (~93, ~107) schedules retries only from onclose, so a retry landing during a
  relay outage never retries again: the box stays off the relay until vyred restarts. Todo tests
  in test/chaos/relay.test.js.
- integrator: box/Dockerfile's apt line is `procps dtach tini` here and `procps tini` on
  work/sessions: the union is right. Build the box image once in CI (ENTRYPOINT tini, CMD loop.sh).
- chat: show `term.closed` reason `box updated` / `terminal_closed` as "The box was updated and
  this terminal was closed. Open a new one." (one line, with a reopen button in the same folder).
- sessions (ADR 0030): threads.send passes `keyUuid(caller, meta.idempotencyKey)` as the SDK
  message uuid and refuses a uuid it already queued or handed over; the driver's close on vyred
  stop uses reason `restart` (the Switchboard's stopAll does it today); threads.answer and
  gate.approve/reject return the earlier outcome on a repeat.
- pwa + mobile: adopt core/resilience/web.js in the Deck and the Expo web target: outbox for
  sends, answers, approvals, notes, todos; cursor persisted; open from snapshot cache; one quiet
  Reconnecting pill after the first failed retry; never remount or drop drafts on reconnect.
- relay + tailnet: CORS for app.vyre.run on vyred or the relay, allowing authorization,
  idempotency-key, last-event-id and content-type (the web client needs it cross-origin).
- chat: the browser terminal client on the new term contract (from=, cut/at frames, 1012
  reattach, 4 KB key buffer, keep scrollback). docs: ADR 0024 still says 10 s idle.

## Changed contracts
- Registry.call: new meta `idempotencyKey` (from the Idempotency-Key header); tools receive it.
- vyred HTTP: 409 `idempotency_conflict`; 503 `restarting` with retry-after during drain.
- Switchboard stopAll: `thread.stopped` reason `restart` (was `stopped`).
- Module ctx: `ctx.events.latestId()`.
- box composes: `init: true` dropped on vyre, docker-api, egress (lead approved; e2e does theirs).
- daemon client: new `write()`; CLI threads send/answer and the screen's send use it (polish-cli).
- term: `term.closed` reason `box updated` at start for lost terminals; `term.attach` error code
  `terminal_closed`; terms.json gains `gone`.
- box image: ENTRYPOINT tini, CMD core/daemon/loop.sh.
- term: size ownership frames `take` (client) and `size` with `owner` (box), agreed with chat.
- term: `term.open`/`term.attach` add `durable`, `offset`, `oldest`; attach takes `from`; new
  text frames `cut` and `at` only when `from` is given; close code 1012 on stop; config
  `term.keep_hours`.
