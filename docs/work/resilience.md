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
- Tests on testbox (27 Sep, after main 15e82dd): 145 targeted pass, 0 fail. Earlier: 189 pass, 0 fail. Earlier: 124 pass, 0 fail across idempotency, switchboard, chaos, web, term
  (real dtach), daemon and modules tests.

## Doing
- UNTESTED (testbox frozen for sessions' SDK suite; the lead announces the lift):
  - R6 chaos test in test/chaos/chaos.test.js (planner.upcoming key, answer offline from the
    outbox, the box never rings it, one planner.acked unrung:true, a retry is already:true).
  - web.js over(pathFetch): open and caller over relay/client's createPaths().fetch (the relay
    is Noise over a WebSocket, not an HTTP proxy); test in test/chaos/web.test.js.
  Run: test/chaos/chaos.test.js test/chaos/web.test.js, then CHANGELOG, push, tell integrator.

## Next
1. Per-team fixes (below), starting with pwa and mobile (the web app is the phone's default).
2. R6 chaos test, once work/planner 3c75e47 is on main (not yet at b1dbb49). Planner's spec:
   key = planner-<item>-<Math.floor(due/1000)>; planner.upcoming omits moments answered or
   ringing and returns last_event; done/snooze/dismiss {key} on an unrung moment records it
   answered, the box never rings it, planner.acked carries unrung:true; a repeat of the key
   returns {already:true}; the push tag and planner-ack tag equal the key. Test: a device takes
   upcoming, goes offline (proxy partition), answers from its outbox by key, comes back; the box
   never rings it, one planner.acked, and a retried answer is {already:true}.
3. `last_event` on threads.get, planner.list and Needs reads (R1), with their owners.
4. A 30 min perf check of an idle durable terminal and of the stream client (scripts/perf-check).

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
- daemon client: new `write()`; CLI threads send/answer and the screen's send use it (polish-cli).
- term: `term.closed` reason `box updated` at start for lost terminals; `term.attach` error code
  `terminal_closed`; terms.json gains `gone`.
- box image: ENTRYPOINT tini, CMD core/daemon/loop.sh.
- term: `term.open`/`term.attach` add `durable`, `offset`, `oldest`; attach takes `from`; new
  text frames `cut` and `at` only when `from` is given; close code 1012 on stop; config
  `term.keep_hours`.
